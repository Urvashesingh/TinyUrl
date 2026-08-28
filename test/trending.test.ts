import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import Redis from "ioredis";
import { config } from "../src/config.js";
import { bucketKey, readTrending, recordClicks } from "../src/trending.js";

// Integration tests against the Redis from docker-compose.

let redis: Redis;

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const clicks = (code: string, count: number, minutesAgo = 0) =>
  Array.from({ length: count }, () => ({ code, occurredAt: at(minutesAgo) }));

async function clearBuckets(): Promise<void> {
  const keys = await redis.keys("trending:*");
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

before(async () => {
  redis = new Redis(config.redisUrl);
  await redis.ping();
});

beforeEach(clearBuckets);

after(async () => {
  await clearBuckets();
  await redis.quit();
});

describe("bucketKey", () => {
  it("puts one minute of clicks in one bucket", () => {
    const base = Date.now();
    assert.equal(bucketKey(base), bucketKey(base + 59_000 - (base % 60_000)));
  });

  it("separates adjacent minutes", () => {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    assert.notEqual(bucketKey(base), bucketKey(base + 60_000));
  });
});

describe("recordClicks / readTrending", () => {
  it("ranks links by click count", async () => {
    await recordClicks(redis, [
      ...clicks("popular", 9),
      ...clicks("middling", 4),
      ...clicks("quiet", 1),
    ]);

    const entries = await readTrending(redis, { limit: 10 });

    assert.deepEqual(entries, [
      { code: "popular", clicks: 9 },
      { code: "middling", clicks: 4 },
      { code: "quiet", clicks: 1 },
    ]);
  });

  it("respects the requested limit", async () => {
    await recordClicks(redis, [
      ...clicks("a", 5),
      ...clicks("b", 4),
      ...clicks("c", 3),
      ...clicks("d", 2),
    ]);

    const entries = await readTrending(redis, { limit: 2 });
    assert.deepEqual(entries.map((e) => e.code), ["a", "b"]);
  });

  it("sums a link's clicks across minutes inside the window", async () => {
    await recordClicks(redis, clicks("spread", 3, 0));
    await recordClicks(redis, clicks("spread", 4, 2));

    const entries = await readTrending(redis, { windowMinutes: 10, limit: 5 });
    assert.deepEqual(entries, [{ code: "spread", clicks: 7 }]);
  });

  it("forgets clicks that fall outside the window", async () => {
    // The reason for per-minute buckets: a single running total would let
    // yesterday's viral link outrank everything current, forever.
    await recordClicks(redis, clicks("current", 2, 0));
    await recordClicks(redis, clicks("yesterday", 500, 90));

    const entries = await readTrending(redis, { windowMinutes: 5, limit: 10 });

    assert.deepEqual(entries, [{ code: "current", clicks: 2 }]);
  });

  it("buckets by when the click happened, not when it was processed", async () => {
    // A consumer catching up after a restart must not pile hours of backlog
    // into the current minute and invent a spike that never occurred.
    await recordClicks(redis, clicks("backlog", 50, 45));

    const wide = await readTrending(redis, { windowMinutes: 60, limit: 10 });
    const narrow = await readTrending(redis, { windowMinutes: 5, limit: 10 });

    assert.deepEqual(wide, [{ code: "backlog", clicks: 50 }]);
    assert.deepEqual(narrow, [], "old clicks must not appear in the recent window");
  });

  it("returns an empty board when nothing has been clicked", async () => {
    assert.deepEqual(await readTrending(redis, { limit: 10 }), []);
  });

  it("does nothing when handed an empty batch", async () => {
    await recordClicks(redis, []);
    assert.deepEqual(await readTrending(redis, { limit: 10 }), []);
  });

  it("aggregates a batch so repeated codes cost one increment", async () => {
    await recordClicks(redis, clicks("hot", 100));
    const entries = await readTrending(redis, { limit: 1 });
    assert.deepEqual(entries, [{ code: "hot", clicks: 100 }]);
  });

  it("expires buckets so the key space cannot grow without bound", async () => {
    await recordClicks(redis, clicks("ttl-check", 1));
    const ttl = await redis.ttl(bucketKey(Date.now()));

    assert.ok(ttl > 0, "bucket must carry a TTL");
    assert.ok(ttl <= (config.trending.windowMinutes + 2) * 60);
  });
});
