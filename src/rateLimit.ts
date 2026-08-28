import type { Request, RequestHandler, Response } from "express";
import type Redis from "ioredis";

/**
 * Sliding-window-log rate limiter.
 *
 * Each caller gets a Redis sorted set of request timestamps. Every check drops
 * entries older than the window, counts what is left, and admits the request if
 * that count is under the limit.
 *
 * Why this and not the alternatives:
 *   fixed window     cheapest, but allows 2x the limit across a boundary --
 *                    a caller can spend a full quota at 11:59:59 and another
 *                    at 12:00:00
 *   token bucket     allows deliberate bursts, which is a feature for APIs and
 *                    a bug for abuse control
 *   sliding log      exact, and memory is bounded by the limit itself, which
 *                    for limits this small is a few dozen bytes per caller
 *
 * The whole read-modify-write runs as one Lua script so it is atomic. Doing it
 * with separate ZCARD and ZADD calls leaves a race in which concurrent requests
 * all observe the same under-limit count and all get admitted -- precisely the
 * burst the limiter exists to stop.
 */
const SLIDING_WINDOW_SCRIPT = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local used = redis.call('ZCARD', key)

if used < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - used - 1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retryIn = window - (now - tonumber(oldest[2]))
return {0, 0, retryIn}
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    slidingWindow(
      key: string,
      now: string,
      windowMs: string,
      limit: string,
      member: string,
    ): Promise<[number, number, number]>;
  }
}

export interface RateLimitOptions {
  /** Namespaces the keys, so separate limits do not share a budget. */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Defaults to the client IP. */
  identify?: (req: Request) => string;
}

const scriptDefined = new WeakSet<Redis>();

export function createRateLimiter(redis: Redis, options: RateLimitOptions): RequestHandler {
  if (!scriptDefined.has(redis)) {
    // ioredis sends EVALSHA and falls back to EVAL on NOSCRIPT, so the script
    // body crosses the wire once rather than on every request.
    redis.defineCommand("slidingWindow", { numberOfKeys: 1, lua: SLIDING_WINDOW_SCRIPT });
    scriptDefined.add(redis);
  }

  const windowMs = options.windowSeconds * 1_000;
  const identify = options.identify ?? ((req: Request) => req.ip ?? "unknown");

  return async function rateLimit(req, res, next) {
    const key = `rl:${options.name}:${identify(req)}`;
    let allowed = 1;
    let remaining = options.limit - 1;
    let retryInMs = 0;

    try {
      [allowed, remaining, retryInMs] = await redis.slidingWindow(
        key,
        String(Date.now()),
        String(windowMs),
        String(options.limit),
        // Two requests in the same millisecond would otherwise collide on
        // score alone and the sorted set would keep only one of them.
        `${Date.now()}-${Math.random()}`,
      );
    } catch {
      // Fail open. A Redis outage must not take down the service the limiter
      // is protecting -- but be clear about the trade: for the duration of an
      // outage there is no rate limiting at all. Failing closed would swap a
      // cache outage for a total outage, which is the worse of the two.
      req.log?.warn({ limiter: options.name }, "rate limiter unavailable, allowing request");
      return next();
    }

    setRateLimitHeaders(res, options.limit, remaining, retryInMs, windowMs);

    if (allowed === 1) {
      return next();
    }

    req.log?.warn({ limiter: options.name, key }, "rate limit exceeded");
    return res.status(429).json({
      error: "Too many requests. Slow down and try again shortly.",
    });
  };
}

function setRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  retryInMs: number,
  windowMs: number,
): void {
  const retryAfterSeconds = Math.max(1, Math.ceil((retryInMs || windowMs) / 1_000));

  res.set("X-RateLimit-Limit", String(limit));
  res.set("X-RateLimit-Remaining", String(Math.max(0, remaining)));

  if (retryInMs > 0) {
    res.set("Retry-After", String(retryAfterSeconds));
  }
}
