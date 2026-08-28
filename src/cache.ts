import Redis from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

export type CacheLookup =
  | { state: "hit"; longUrl: string }
  | { state: "known-missing" }
  | { state: "miss" };

export interface LinkCache {
  lookup(code: string): Promise<CacheLookup>;
  remember(code: string, longUrl: string): Promise<void>;
  rememberMissing(code: string): Promise<void>;
  close(): Promise<void>;
}

// Versioned key prefix. If the stored shape ever changes, bumping this rolls
// the whole cache over atomically instead of leaving old entries to be
// misread by new code.
const KEY_PREFIX = "link:v1:";

// Sentinel for a negatively cached code. No valid longUrl can collide with it
// because a NUL byte cannot survive URL parsing.
const MISSING = "\u0000missing";

function keyFor(code: string): string {
  return `${KEY_PREFIX}${code}`;
}

export function createLinkCache(): LinkCache {
  const redis = new Redis(config.redisUrl, {
    // The cache is an optimization, never a dependency. If Redis is down a
    // command must fail immediately so the request falls through to Postgres:
    //   enableOfflineQueue: false  do not park commands until reconnect
    //   maxRetriesPerRequest: 1    do not spend the caller's latency retrying
    // Without these two, an outage turns into every request hanging rather
    // than every request getting slower, which is far worse.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  // ioredis emits "error" on every failed reconnect. An EventEmitter with no
  // error listener throws, so this handler is what keeps a Redis outage from
  // taking the process down with it.
  let lastErrorLoggedAt = 0;
  redis.on("error", (error: Error) => {
    // Reconnect storms would otherwise write thousands of identical lines.
    const now = Date.now();
    if (now - lastErrorLoggedAt > 10_000) {
      lastErrorLoggedAt = now;
      logger.warn({ err: error.message }, "redis unavailable, serving from postgres");
    }
  });

  redis.on("ready", () => logger.info("redis connected"));

  return {
    async lookup(code) {
      try {
        const cached = await redis.get(keyFor(code));
        if (cached === null) {
          return { state: "miss" };
        }

        return cached === MISSING ? { state: "known-missing" } : { state: "hit", longUrl: cached };
      } catch {
        // Degrade, do not fail. The caller reads through to Postgres.
        return { state: "miss" };
      }
    },

    async remember(code, longUrl) {
      try {
        await redis.set(keyFor(code), longUrl, "EX", config.cacheTtlSeconds);
      } catch {
        // A write-through failure only costs us the next read.
      }
    },

    async rememberMissing(code) {
      try {
        await redis.set(keyFor(code), MISSING, "EX", config.missCacheTtlSeconds);
      } catch {
        // As above.
      }
    },

    async close() {
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}
