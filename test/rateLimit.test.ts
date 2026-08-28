import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import express from "express";
import Redis from "ioredis";
import { config } from "../src/config.js";
import { createRateLimiter } from "../src/rateLimit.js";

// Integration tests against the Redis from docker-compose.

let redis: Redis;
const servers: Server[] = [];

/** Mounts a limiter on a throwaway app and returns a function that calls it. */
async function limitedApp(
  client: Redis,
  options: { name: string; limit: number; windowSeconds: number },
): Promise<(headers?: Record<string, string>) => Promise<Response>> {
  const app = express();
  app.set("trust proxy", true);
  app.get("/", createRateLimiter(client, options), (_req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);

  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (headers) => fetch(`${origin}/`, { headers });
}

before(async () => {
  redis = new Redis(config.redisUrl);
  const keys = await redis.keys("rl:test*");
  if (keys.length > 0) {
    await redis.del(...keys);
  }
});

after(async () => {
  const keys = await redis.keys("rl:test*");
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  await redis.quit();
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
});

describe("createRateLimiter", () => {
  it("admits requests up to the limit and refuses the next one", async () => {
    const call = await limitedApp(redis, { name: "test-basic", limit: 3, windowSeconds: 60 });

    for (let i = 0; i < 3; i += 1) {
      assert.equal((await call()).status, 200, `request ${i + 1} should be admitted`);
    }

    assert.equal((await call()).status, 429);
  });

  it("counts down remaining and advertises when to retry", async () => {
    const call = await limitedApp(redis, { name: "test-headers", limit: 2, windowSeconds: 60 });

    const first = await call();
    assert.equal(first.headers.get("x-ratelimit-limit"), "2");
    assert.equal(first.headers.get("x-ratelimit-remaining"), "1");

    await call();
    const refused = await call();

    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("x-ratelimit-remaining"), "0");
    const retryAfter = Number(refused.headers.get("retry-after"));
    assert.ok(retryAfter > 0 && retryAfter <= 60, `unexpected Retry-After ${retryAfter}`);
  });

  it("gives each caller its own budget", async () => {
    const call = await limitedApp(redis, { name: "test-perip", limit: 1, windowSeconds: 60 });

    assert.equal((await call({ "X-Forwarded-For": "10.0.0.1" })).status, 200);
    assert.equal((await call({ "X-Forwarded-For": "10.0.0.1" })).status, 429);
    // A different caller must be unaffected by the first one's spending.
    assert.equal((await call({ "X-Forwarded-For": "10.0.0.2" })).status, 200);
  });

  it("keeps separate limiters from sharing a budget", async () => {
    const a = await limitedApp(redis, { name: "test-scope-a", limit: 1, windowSeconds: 60 });
    const b = await limitedApp(redis, { name: "test-scope-b", limit: 1, windowSeconds: 60 });

    assert.equal((await a({ "X-Forwarded-For": "10.1.0.1" })).status, 200);
    assert.equal((await a({ "X-Forwarded-For": "10.1.0.1" })).status, 429);
    assert.equal((await b({ "X-Forwarded-For": "10.1.0.1" })).status, 200);
  });

  it("lets the window slide, rather than resetting on a fixed boundary", async () => {
    const call = await limitedApp(redis, { name: "test-slide", limit: 2, windowSeconds: 1 });

    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 429);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // The two earlier requests have aged out of the window, so budget is back.
    assert.equal((await call()).status, 200);
  });

  it("admits concurrent requests only up to the limit", async () => {
    // The race the Lua script exists to prevent: without atomicity these all
    // observe the same under-limit count and all get through.
    const call = await limitedApp(redis, { name: "test-race", limit: 5, windowSeconds: 60 });

    const responses = await Promise.all(Array.from({ length: 40 }, () => call()));
    const admitted = responses.filter((r) => r.status === 200).length;

    assert.equal(admitted, 5, `expected exactly 5 admitted, got ${admitted}`);
  });

  it("fails open when Redis is unreachable", async () => {
    // An outage of the limiter must not become an outage of the service it
    // protects. The cost is explicit: no limiting at all while Redis is down.
    const dead = new Redis({
      port: 6999,
      host: "127.0.0.1",
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 300,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    dead.on("error", () => {});

    const call = await limitedApp(dead, { name: "test-dead", limit: 1, windowSeconds: 60 });

    for (let i = 0; i < 5; i += 1) {
      assert.equal((await call()).status, 200, "requests must pass through when Redis is down");
    }

    dead.disconnect();
  });
});
