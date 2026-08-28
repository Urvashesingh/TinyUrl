import { randomUUID } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import pinoHttp from "pino-http";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { decodeCode, encodeId } from "./codes.js";
import type { LinkCache } from "./cache.js";
import { createLinkResolver, type Databases } from "./links.js";
import { createRateLimiter } from "./rateLimit.js";
import { hashIp, type EventPublisher } from "./events.js";
import { readTrending, type TrendingEntry } from "./trending.js";
import {
  linksCreated,
  metricsHandler,
  metricsMiddleware,
  redirectCacheOutcomes,
} from "./metrics.js";

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

export interface AppDeps {
  /** Primary for writes, replica for reads. Both may be the same client. */
  db: Databases;
  cache: LinkCache;
  /** Absent in the minimal profile: no cache, no rate limiting, no trending. */
  redis?: Redis;
  events: EventPublisher;
  /**
   * Supplies the leaderboard already computed by the live feed. Without it the
   * endpoint falls back to computing its own, which is correct but does the
   * expensive union once per request.
   */
  trendingSnapshot?: () => TrendingEntry[];
}

export function createApp(deps: AppDeps): Express {
  const { db, cache, redis, events, trendingSnapshot } = deps;
  // Writes are always the primary. Reads that tolerate a little staleness use
  // the replica.
  const prisma = db.write;
  const replica = db.read;
  const app = express();
  const resolveLink = createLinkResolver(db, cache);

  // Rate limiting needs shared state across instances, which means Redis.
  // Without it the limiters are omitted rather than faked: a per-instance
  // in-memory limiter on a serverless platform would count each cold start
  // separately and give a false sense of protection. The API key below is the
  // control that actually works there.
  const noLimit: RequestHandler = (_req, _res, next) => next();
  const limitCreates = redis
    ? createRateLimiter(redis, { name: "create", ...config.createRateLimit })
    : noLimit;
  const limitRedirects = redis
    ? createRateLimiter(redis, { name: "redirect", ...config.redirectRateLimit })
    : noLimit;

  /**
   * Guards creation when CREATE_API_KEY is set. Redirects are always public --
   * the whole point of a short link is that anyone can follow it.
   */
  const requireApiKey: RequestHandler = (req, res, next) => {
    if (!config.createApiKey) {
      return next();
    }

    const supplied = req.get("x-api-key");
    if (supplied !== config.createApiKey) {
      return res.status(401).json({ error: "A valid X-API-Key header is required to create links." });
    }

    return next();
  };

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

  app.use(metricsMiddleware());
  app.use(express.json({ limit: config.jsonBodyLimit }));

  // Deliberately above the rate limiters and outside the click path: a scrape
  // is not user traffic. In Kubernetes this is reached through the pod IP, not
  // through the ingress, so it is not publicly exposed.
  app.get("/metrics", metricsHandler);

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
    } catch (error) {
      req.log.error({ err: error }, "readiness check failed");
      return res.status(503).json({ status: "unavailable", error: "Database unreachable." });
    }

    // The replica is reported, never required. Reads fall back to the primary
    // when it is unavailable, so failing readiness here would remove capacity
    // for a condition the service already handles.
    let replicaLagSeconds: number | null = null;
    if (replica !== prisma) {
      try {
        const [row] = await replica.$queryRaw<Array<{ lag: number | null }>>`
          SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8 AS lag
        `;
        replicaLagSeconds = row?.lag ?? 0;
      } catch {
        replicaLagSeconds = null;
      }
    }

    return res.json({ status: "ready", profile: config.profile, replicaLagSeconds });
  });

  app.post("/links", limitCreates, requireApiKey, async (req, res, next) => {
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

      // Warm the cache with what we just wrote. Replication is asynchronous,
      // so a redirect arriving within the lag window would miss on the replica
      // and 404 a link that demonstrably exists. Seeding the cache means the
      // read path never consults the replica for a brand new link at all --
      // read-your-writes, without a synchronous replica or a primary read.
      await cache.remember(link.code, link.longUrl);

      linksCreated.inc();
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

  // Trending is backed by Redis sorted sets, so it exists only when Redis
  // does. Omitted rather than stubbed: a leaderboard that is always empty is
  // worse than a 404, because it looks like the feature is broken.
  if (redis) {
    const trendingRedis = redis;
    app.get("/trending", async (_req, res, next) => {
      try {
        const entries = trendingSnapshot?.() ?? (await readTrending(trendingRedis));
        return res.json({ window: `${config.trending.windowMinutes}m`, entries });
      } catch (error) {
        return next(error);
      }
    });
  }

  // Two path segments, so this cannot be shadowed by the single-segment
  // catch-all below -- but it still has to be declared first to be safe.
  app.get("/links/:code/stats", async (req, res, next) => {
    try {
      const { code } = req.params;
      if (decodeCode(code) === null) {
        return res.status(404).json({ error: "Short link not found." });
      }

      // Analytics tolerate replication lag by definition, so they read from
      // the replica and keep that load off the primary entirely.
      const link = await replica.link.findUnique({ where: { code }, select: { createdAt: true } });
      if (!link) {
        return res.status(404).json({ error: "Short link not found." });
      }

      const [totals] = await replica.$queryRaw<Array<{ clicks: bigint; visitors: bigint }>>`
        SELECT count(*) AS clicks, count(DISTINCT "ipHash") AS visitors
        FROM click_events WHERE code = ${code}
      `;

      return res.json({
        code,
        createdAt: link.createdAt.toISOString(),
        clicks: Number(totals?.clicks ?? 0),
        uniqueVisitors: Number(totals?.visitors ?? 0),
      });
    } catch (error) {
      return next(error);
    }
  });

  // Must stay below every other route: it matches any single path segment.
  app.get("/:code", limitRedirects, async (req, res, next) => {
    try {
      const { code } = req.params;

      // Codes are reversible, so a malformed one is provably not ours and can
      // be rejected without spending a cache or database round trip on it.
      if (decodeCode(code) === null) {
        return res.status(404).json({ error: "Short link not found." });
      }

      const { longUrl, cache: outcome } = await resolveLink(code);
      redirectCacheOutcomes.inc({ outcome });
      req.log.info({ code, cache: outcome, found: longUrl !== null }, "redirect resolved");

      if (longUrl === null) {
        return res.status(404).json({ error: "Short link not found." });
      }

      // Fire and forget. The redirect is what the user is waiting for; the
      // analytics event must never add latency to it, and must never be able
      // to fail it.
      events.publishClick({
        code,
        occurredAt: new Date().toISOString(),
        userAgent: req.get("user-agent"),
        referer: req.get("referer"),
        ipHash: hashIp(req.ip),
      });

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
