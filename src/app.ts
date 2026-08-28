import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import pinoHttp from "pino-http";
import type { PrismaClient } from "@prisma/client";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { decodeCode, encodeId } from "./codes.js";
import type { LinkCache } from "./cache.js";
import { createLinkResolver } from "./links.js";

type UrlRejection = "missing" | "malformed" | "unsupported_scheme" | "too_long";

function parseLongUrl(value: unknown): { url: URL } | { reason: UrlRejection } {
  if (typeof value !== "string" || value.trim() === "") {
    return { reason: "missing" };
  }

  if (value.length > config.maxUrlLength) {
    return { reason: "too_long" };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { reason: "malformed" };
  }

  // Anything else -- javascript:, data:, file: -- turns the redirect into a
  // delivery mechanism for whatever the submitter wants.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { reason: "unsupported_scheme" };
  }

  return { url };
}

const REJECTION_MESSAGES: Record<UrlRejection, string> = {
  missing: "longUrl is required and must be a non-empty string.",
  malformed: "longUrl must be an absolute URL.",
  unsupported_scheme: "longUrl must use the http or https scheme.",
  too_long: `longUrl must be at most ${config.maxUrlLength} characters.`,
};

function originFor(req: Request): string {
  return config.baseUrl ?? `${req.protocol}://${req.get("host")}`;
}

export function createApp(prisma: PrismaClient, cache: LinkCache): Express {
  const app = express();
  const resolveLink = createLinkResolver(prisma, cache);

  app.disable("x-powered-by");
  if (config.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use(
    pinoHttp({
      logger,
      // Honour an inbound request id so a trace survives across services, and
      // mint one when there is not one yet. Everything logged during the
      // request carries it, which is the entire point of structured logging:
      // one grep on reqId reconstructs a single user's journey.
      genReqId: (req, res) => {
        const inbound = req.headers["x-request-id"];
        const id = (Array.isArray(inbound) ? inbound[0] : inbound) ?? randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      // Health probes fire constantly and would drown everything else.
      autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/ready" },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    }),
  );

  app.use(express.json({ limit: config.jsonBodyLimit }));

  // Liveness: is the process up? Deliberately does not touch the database, so
  // a database blip does not get the container killed and restarted.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: should this instance receive traffic? This checks Postgres,
  // because without it every request fails. It deliberately does NOT check
  // Redis: the cache is an optimization, and an instance with a cold cache is
  // slower but perfectly correct. Failing readiness on a Redis outage would
  // pull every healthy instance out of the load balancer at once.
  app.get("/ready", async (req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ready" });
    } catch (error) {
      req.log.error({ err: error }, "readiness check failed");
      res.status(503).json({ status: "unavailable", error: "Database unreachable." });
    }
  });

  app.post("/links", async (req, res, next) => {
    try {
      const parsed = parseLongUrl(req.body?.longUrl);
      if ("reason" in parsed) {
        return res.status(400).json({ error: REJECTION_MESSAGES[parsed.reason] });
      }

      // Reserve the id from the sequence before inserting. The short code is a
      // function of the id, so knowing it up front turns link creation into a
      // single atomic INSERT -- no insert-then-update, no placeholder code, and
      // nothing half-written if the process dies mid-request.
      const [reserved] = await prisma.$queryRaw<Array<{ id: bigint }>>`
        SELECT nextval(pg_get_serial_sequence('links', 'id')) AS id
      `;

      const link = await prisma.link.create({
        data: {
          id: reserved.id,
          code: encodeId(reserved.id),
          longUrl: parsed.url.toString(),
        },
      });

      req.log.info({ code: link.code }, "link created");

      return res.status(201).json({
        code: link.code,
        longUrl: link.longUrl,
        shortUrl: `${originFor(req)}/${link.code}`,
        createdAt: link.createdAt.toISOString(),
      });
    } catch (error) {
      return next(error);
    }
  });

  // Must stay below every other route: it matches any single path segment.
  app.get("/:code", async (req, res, next) => {
    try {
      const { code } = req.params;

      // Codes are reversible, so a malformed one is provably not ours and can
      // be rejected without spending a cache or database round trip on it.
      if (decodeCode(code) === null) {
        return res.status(404).json({ error: "Short link not found." });
      }

      const { longUrl, cache: outcome } = await resolveLink(code);
      req.log.info({ code, cache: outcome, found: longUrl !== null }, "redirect resolved");

      if (longUrl === null) {
        return res.status(404).json({ error: "Short link not found." });
      }

      // Every redirect is a click we want to count later, so no intermediary
      // gets to serve it for us.
      res.set("Cache-Control", "no-store");
      return res.redirect(302, longUrl);
    } catch (error) {
      return next(error);
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    // Body-parser rejections (malformed JSON, oversized payload) are the
    // caller's fault and arrive here carrying their own status.
    const status = (error as { status?: number; statusCode?: number })?.status
      ?? (error as { statusCode?: number })?.statusCode;

    if (typeof status === "number" && status >= 400 && status < 500) {
      return res.status(status).json({ error: "Malformed request body." });
    }

    req.log.error({ err: error }, "unhandled request error");
    return res.status(500).json({ error: "Internal server error." });
  });

  return app;
}
