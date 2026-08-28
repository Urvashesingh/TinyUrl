import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/app.js";
import { createNullCache } from "../src/cache.js";
import { nullEventPublisher } from "../src/events.js";
import { normalizeRequestUrl } from "../src/vercelPath.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Vercel entry point: the minimal profile of the same application.
 *
 * A serverless function wakes up, answers one request and is frozen or
 * discarded. There is nowhere to keep a Redis connection pooled, a WebSocket
 * open, or a Kafka consumer running -- so this build wires in a null cache and
 * a null event publisher and serves the part that genuinely fits: create a
 * link, follow a link.
 *
 * Everything else still exists in the codebase and runs under Docker Compose.
 * This is a deployment shape, not a different program.
 */

// Reused across invocations on a warm instance. Creating a PrismaClient per
// request is the classic serverless mistake: connections are per-instance and
// Postgres runs out of them long before you run out of traffic. The pooled
// Supabase URL (pgbouncer, port 6543) is what keeps that bounded.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
globalForPrisma.prisma = prisma;

const app = createApp({
  db: { write: prisma, read: prisma },
  cache: createNullCache(),
  events: nullEventPublisher,
});

// Vercel invokes the default export with (req, res). An Express app is already
// a function with that signature, but every path arrives through one catch-all
// rewrite, so the original path is restored before Express routes on it.
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.url) {
    req.url = normalizeRequestUrl(req.url);
  }

  return app(req as never, res as never);
}
