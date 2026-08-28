import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Redis from "ioredis";
import { config } from "../src/config.js";
import { createLinkCache, type LinkCache } from "../src/cache.js";

// Integration tests against the Redis from docker-compose.

const PREFIX = "link:v1:";

let cache: LinkCache;
let redis: Redis;

function uniqueCode(): string {
  return `t${Math.random().toString(36).slice(2, 8)}`;
}

before(async () => {
  cache = createLinkCache();
  redis = new Redis(config.redisUrl);
  await redis.ping();
});

after(async () => {
  const keys = await redis.keys(`${PREFIX}t*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  await cache.close();
  await redis.quit();
});

describe("createLinkCache", () => {
  it("reports a miss for a code it has never seen", async () => {
    assert.deepEqual(await cache.lookup(uniqueCode()), { state: "miss" });
  });

  it("round-trips a remembered link", async () => {
    const code = uniqueCode();
    await cache.remember(code, "https://example.com/target");

    assert.deepEqual(await cache.lookup(code), {
      state: "hit",
      longUrl: "https://example.com/target",
    });
  });

  it("distinguishes a remembered absence from a miss", async () => {
    const code = uniqueCode();
    await cache.rememberMissing(code);

    assert.deepEqual(await cache.lookup(code), { state: "known-missing" });
  });

  it("expires remembered links so the cache cannot grow without bound", async () => {
    const code = uniqueCode();
    await cache.remember(code, "https://example.com/target");

    const ttl = await redis.ttl(`${PREFIX}${code}`);
    assert.ok(ttl > 0, "entry must carry a TTL");
    assert.ok(ttl <= config.cacheTtlSeconds);
  });

  it("expires a remembered absence far sooner than a real link", async () => {
    // A cached miss is a claim that a code does not exist, and codes are
    // created constantly -- so it must decay quickly.
    const hit = uniqueCode();
    const missing = uniqueCode();
    await cache.remember(hit, "https://example.com/target");
    await cache.rememberMissing(missing);

    const hitTtl = await redis.ttl(`${PREFIX}${hit}`);
    const missTtl = await redis.ttl(`${PREFIX}${missing}`);

    assert.ok(missTtl < hitTtl, `miss ttl ${missTtl} must be shorter than hit ttl ${hitTtl}`);
    assert.ok(missTtl <= config.missCacheTtlSeconds);
  });

  it("namespaces its keys so it can share a Redis with other workloads", async () => {
    const code = uniqueCode();
    await cache.remember(code, "https://example.com/target");

    assert.equal(await redis.exists(`${PREFIX}${code}`), 1);
    assert.equal(await redis.exists(code), 0);
  });
});
