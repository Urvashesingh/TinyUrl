import Redis from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * One Redis connection, shared by everything that needs it.
 *
 * The settings here are the whole reason Redis can be a dependency of the hot
 * path without being a single point of failure:
 *   enableOfflineQueue: false  do not park commands until reconnect
 *   maxRetriesPerRequest: 1    do not spend the caller's latency retrying
 * Without them an outage turns into every request hanging rather than every
 * request getting slower, which is far worse -- hung requests exhaust
 * connections and take the service down with the cache.
 */
export function createRedis(purpose = "shared"): Redis {
  const redis = new Redis(config.redisUrl, {
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
      logger.warn({ err: error.message, purpose }, "redis unavailable, degrading");
    }
  });

  redis.on("ready", () => logger.info({ purpose }, "redis connected"));

  return redis;
}

export async function closeRedis(redis: Redis): Promise<void> {
  await redis.quit().catch(() => redis.disconnect());
}
