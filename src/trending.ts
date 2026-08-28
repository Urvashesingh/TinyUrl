import type Redis from "ioredis";
import { config } from "./config.js";

export interface TrendingEntry {
  code: string;
  clicks: number;
}

const BUCKET_PREFIX = "trending:m:";

/**
 * One sorted set per minute, rather than a single running total.
 *
 * A single ZINCRBY set never forgets: a link that went viral last week would
 * outrank everything current, forever. Per-minute buckets with a TTL give a
 * genuinely sliding window for free -- old minutes fall out of the union
 * because Redis has already deleted them, so nothing has to sweep them.
 */
export function bucketKey(epochMs: number): string {
  return `${BUCKET_PREFIX}${Math.floor(epochMs / 60_000)}`;
}

/**
 * Records a batch of clicks. Counts are aggregated in memory first so a batch
 * of 100 events for one code costs one ZINCRBY rather than 100.
 */
export async function recordClicks(
  redis: Redis,
  clicks: Array<{ code: string; occurredAt: string }>,
): Promise<void> {
  if (clicks.length === 0) {
    return;
  }

  const perBucket = new Map<string, Map<string, number>>();

  for (const click of clicks) {
    // Bucket by when the click happened, not when it was processed, so a
    // consumer catching up after a restart does not pile old clicks into the
    // current minute and invent a spike that never occurred.
    const at = Date.parse(click.occurredAt);
    const key = bucketKey(Number.isNaN(at) ? Date.now() : at);
    const counts = perBucket.get(key) ?? new Map<string, number>();
    counts.set(click.code, (counts.get(click.code) ?? 0) + 1);
    perBucket.set(key, counts);
  }

  const pipeline = redis.pipeline();
  // Keep a couple of minutes beyond the window so a bucket cannot expire
  // while it is still being unioned.
  const ttlSeconds = (config.trending.windowMinutes + 2) * 60;

  for (const [key, counts] of perBucket) {
    for (const [code, count] of counts) {
      pipeline.zincrby(key, count, code);
    }
    pipeline.expire(key, ttlSeconds);
  }

  await pipeline.exec();
}

/**
 * Top links over the trailing window.
 *
 * ZUNIONSTORE across the window's buckets, then ZREVRANGE for the top slice.
 * The union is the expensive part, so it is computed on a timer by the live
 * feed and shared by every reader rather than recomputed per request.
 */
export async function readTrending(
  redis: Redis,
  options: { windowMinutes?: number; limit?: number } = {},
): Promise<TrendingEntry[]> {
  const windowMinutes = options.windowMinutes ?? config.trending.windowMinutes;
  const limit = options.limit ?? config.trending.limit;

  const now = Date.now();
  const keys = Array.from({ length: windowMinutes }, (_, i) => bucketKey(now - i * 60_000));

  // Missing buckets are treated as empty by Redis, so quiet minutes cost
  // nothing and need no special handling.
  const destination = `trending:union:${windowMinutes}`;

  const results = await redis
    .multi()
    .zunionstore(destination, keys.length, ...keys)
    .expire(destination, 60)
    .zrevrange(destination, 0, limit - 1, "WITHSCORES")
    .exec();

  const flat = (results?.[2]?.[1] ?? []) as string[];
  const entries: TrendingEntry[] = [];

  for (let i = 0; i < flat.length; i += 2) {
    entries.push({ code: flat[i], clicks: Number(flat[i + 1]) });
  }

  return entries;
}
