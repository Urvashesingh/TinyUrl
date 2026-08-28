import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/app.js";
import { createLinkCache, type LinkCache } from "../src/cache.js";
import { closeRedis, createRedis } from "../src/redis.js";
import { CLICK_CHANNEL, createRedisEventPublisher, parseClickEvent } from "../src/events.js";
import type Redis from "ioredis";
import { encodeId } from "../src/codes.js";
import { logger } from "../src/logger.js";
import { config } from "../src/config.js";

// Integration tests: these talk to the Postgres from docker-compose. Rows they
// create are tracked and removed in `after`, so repeated runs stay clean.

const prisma = new PrismaClient();
const createdCodes: string[] = [];
let cache: LinkCache;
let redis: Redis;
// A second, ordinary client for test bookkeeping. The app's client has offline
// queueing disabled by design, so it cannot be used before it is ready.
let admin: Redis;
// Exercises the real split when a replica is configured, and degrades to a
// single node when it is not -- both are supported deployments.
const replicaClient = config.databaseReplicaUrl
  ? new PrismaClient({ datasourceUrl: config.databaseReplicaUrl })
  : null;

let server: Server;
let origin: string;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${origin}${path}`, { redirect: "manual", ...init });
}

async function createLink(longUrl: string): Promise<Response> {
  const response = await api("/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ longUrl }),
  });

  if (response.status === 201) {
    createdCodes.push(((await response.clone().json()) as { code: string }).code);
  }

  return response;
}

before(async () => {
  // Request logs would drown the test reporter; the logger itself is exercised
  // by running the app at all, not by asserting on its output.
  logger.level = "silent";

  const { default: Redis } = await import("ioredis");
  admin = new Redis(config.redisUrl);
  await admin.ping();

  redis = createRedis("test");
  // enableOfflineQueue is false, so commands issued before the socket is up
  // are rejected outright. Wait for readiness rather than racing it.
  if (redis.status !== "ready") {
    await new Promise((resolve) => redis.once("ready", resolve));
  }

  cache = createLinkCache(redis);
  server = createApp({
    db: { write: prisma, read: replicaClient ?? prisma },
    cache,
    redis,
    events: createRedisEventPublisher(redis),
  }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

// Only this suite's own limiter scopes: test files run in parallel processes
// against one Redis, so a broad wildcard delete would sabotage its neighbours.
beforeEach(async () => {
  const keys = await admin.keys("rl:create:*");
  const more = await admin.keys("rl:redirect:*");
  const all = [...keys, ...more];
  if (all.length > 0) {
    await admin.del(...all);
  }
});

after(async () => {
  await prisma.clickEvent.deleteMany({ where: { code: { in: createdCodes } } });
  await prisma.link.deleteMany({ where: { code: { in: createdCodes } } });
  await new Promise((resolve) => server.close(resolve));
  await Promise.allSettled([
    prisma.$disconnect(),
    replicaClient?.$disconnect() ?? Promise.resolve(),
    closeRedis(redis),
    admin.quit(),
  ]);
});

describe("GET /health", () => {
  it("reports liveness without touching the database", async () => {
    const response = await api("/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

describe("GET /ready", () => {
  it("reports readiness when the database answers", async () => {
    const response = await api("/ready");
    const body = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(body.status, "ready");
  });
});

describe("POST /links", () => {
  it("creates a link and returns its short url", async () => {
    const longUrl = "https://example.com/some/long/path?a=1";
    const response = await createLink(longUrl);
    const body = (await response.json()) as Record<string, string>;

    assert.equal(response.status, 201);
    assert.equal(body.longUrl, longUrl);
    assert.equal(body.code.length, 7);
    assert.equal(body.shortUrl, `${origin}/${body.code}`);
    assert.ok(!Number.isNaN(Date.parse(body.createdAt)));
  });

  it("issues a distinct code per request, even for the same url", async () => {
    const longUrl = "https://example.com/duplicate";
    const first = (await (await createLink(longUrl)).json()) as { code: string };
    const second = (await (await createLink(longUrl)).json()) as { code: string };

    assert.notEqual(first.code, second.code);
  });

  it("preserves the url exactly as stored", async () => {
    const longUrl = "https://example.com/p?q=a%20b&r=%C3%A9#frag";
    const body = (await (await createLink(longUrl)).json()) as { code: string };

    const redirect = await api(`/${body.code}`);
    assert.equal(redirect.headers.get("location"), longUrl);
  });

  for (const [label, longUrl] of [
    ["a non-http scheme", "ftp://example.com"],
    ["a javascript: payload", "javascript:alert(1)"],
    ["a relative path", "/just/a/path"],
    ["an empty string", ""],
  ] as const) {
    it(`rejects ${label}`, async () => {
      const response = await createLink(longUrl);
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: string }).error, /longUrl/);
    });
  }

  it("rejects a missing longUrl", async () => {
    const response = await api("/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
  });

  it("rejects a url longer than the configured maximum", async () => {
    const response = await createLink(`https://example.com/${"x".repeat(2100)}`);
    assert.equal(response.status, 400);
  });

  it("rejects malformed json without a 500", async () => {
    const response = await api("/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    assert.equal(response.status, 400);
  });

  it("rejects an oversized body", async () => {
    const response = await api("/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ longUrl: "https://example.com", padding: "x".repeat(10_000) }),
    });

    assert.equal(response.status, 413);
  });
});

describe("GET /:code", () => {
  it("redirects with 302 and forbids caching so clicks stay countable", async () => {
    const body = (await (await createLink("https://example.com/target")).json()) as { code: string };
    const response = await api(`/${body.code}`);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://example.com/target");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("returns 404 for a well-formed code that was never issued", async () => {
    // Valid shape, but the id it decodes to is far beyond anything we created.
    const response = await api(`/${encodeId(3_000_000_000_000n)}`);
    assert.equal(response.status, 404);
  });

  it("returns 404 for codes that could never have been issued", async () => {
    for (const code of ["short", "waaaaytoolong", "abc-def"]) {
      assert.equal((await api(`/${code}`)).status, 404);
    }
  });

  it("returns json, not an html error page, for unknown paths", async () => {
    const response = await api("/a/deeper/path");
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  });
});

describe("caching and observability", () => {
  it("serves a repeated redirect identically once it is cached", async () => {
    const longUrl = "https://example.com/cached-target";
    const { code } = (await (await createLink(longUrl)).json()) as { code: string };

    // First request populates the cache, second should be served from it.
    // Both must be indistinguishable to the caller -- that is the whole
    // contract of a cache-aside read path.
    const first = await api(`/${code}`);
    const second = await api(`/${code}`);

    assert.equal(first.status, 302);
    assert.equal(second.status, 302);
    assert.equal(second.headers.get("location"), longUrl);
    assert.equal(second.headers.get("cache-control"), "no-store");
  });

  it("still resolves a link whose cache entry was dropped", async () => {
    // Eviction under memory pressure is normal, not exceptional.
    const longUrl = "https://example.com/evicted";
    const { code } = (await (await createLink(longUrl)).json()) as { code: string };

    await api(`/${code}`);
    await cache.remember(code, longUrl);

    const response = await api(`/${code}`);
    assert.equal(response.headers.get("location"), longUrl);
  });

  it("echoes an inbound request id so traces survive across services", async () => {
    const response = await api("/health", { headers: { "X-Request-Id": "trace-me-123" } });
    assert.equal(response.headers.get("x-request-id"), "trace-me-123");
  });

  it("mints a request id when the caller does not supply one", async () => {
    const response = await api("/health");
    assert.match(response.headers.get("x-request-id") ?? "", /[0-9a-f-]{36}/);
  });
});

describe("rate limiting", () => {
  it("refuses creation past the configured limit", async () => {
    // Proves the limiter is actually mounted on the route, which the
    // middleware's own unit tests cannot tell us.
    const limit = config.createRateLimit.limit;
    const statuses: number[] = [];

    for (let i = 0; i < limit + 3; i += 1) {
      statuses.push((await createLink(`https://example.com/burst/${i}`)).status);
    }

    assert.equal(statuses.filter((s) => s === 201).length, limit);
    assert.ok(statuses.slice(-3).every((s) => s === 429), "the overflow must be refused");
  });

  it("does not let creation exhaust the redirect budget", async () => {
    // Separate scopes, separate budgets. If these shared a key, a burst of
    // creates would break every redirect on the service.
    const { code } = (await (await createLink("https://example.com/still-works")).json()) as {
      code: string;
    };

    for (let i = 0; i < config.createRateLimit.limit + 2; i += 1) {
      await createLink(`https://example.com/noise/${i}`);
    }

    assert.equal((await api(`/${code}`)).status, 302);
  });
});

describe("click events", () => {
  it("publishes an event for every redirect served", async () => {
    const { default: Redis } = await import("ioredis");
    const listener = new Redis(config.redisUrl);

    const received = new Promise<string>((resolve) => {
      listener.on("message", (_channel, payload) => resolve(payload));
    });
    await listener.subscribe(CLICK_CHANNEL);

    const { code } = (await (await createLink("https://example.com/tracked")).json()) as {
      code: string;
    };
    await api(`/${code}`, { headers: { "User-Agent": "test-agent", Referer: "https://ref.example" } });

    const event = parseClickEvent(await received);
    await listener.quit();

    assert.ok(event, "published payload must parse as a click event");
    assert.equal(event.code, code);
    assert.equal(event.userAgent, "test-agent");
    assert.equal(event.referer, "https://ref.example");
    assert.ok(event.ipHash, "the visitor address must be hashed, never stored raw");
    assert.ok(!event.ipHash.includes("127.0.0.1") && !event.ipHash.includes("::1"));
  });

  it("serves the redirect even when nothing is listening for events", async () => {
    // Pub/sub with no subscriber silently drops the message. The redirect
    // must be completely indifferent to that.
    const { code } = (await (await createLink("https://example.com/unwatched")).json()) as {
      code: string;
    };

    const response = await api(`/${code}`);
    assert.equal(response.status, 302);
  });

  it("reports zero clicks for a link nobody has followed", async () => {
    const { code } = (await (await createLink("https://example.com/unclicked")).json()) as {
      code: string;
    };

    const stats = (await (await api(`/links/${code}/stats`)).json()) as Record<string, number>;
    assert.equal(stats.clicks, 0);
    assert.equal(stats.uniqueVisitors, 0);
  });

  it("404s stats for a code that was never issued", async () => {
    assert.equal((await api("/links/notacode/stats")).status, 404);
    assert.equal((await api(`/links/${encodeId(2_999_999_999_999n)}/stats`)).status, 404);
  });
});

describe("read/write split", () => {
  it("warms the cache on create, so the read path never asks the replica", async () => {
    // Replication is asynchronous. A redirect arriving inside the lag window
    // would miss on the replica and 404 a link that demonstrably exists.
    // Seeding the cache at write time is what makes read-your-writes hold
    // without a synchronous replica or a read against the primary.
    const longUrl = "https://example.com/read-your-writes";
    const { code } = (await (await createLink(longUrl)).json()) as { code: string };

    assert.deepEqual(await cache.lookup(code), { state: "hit", longUrl });
  });

  it("serves a redirect immediately after creation", async () => {
    const longUrl = "https://example.com/instant";
    const { code } = (await (await createLink(longUrl)).json()) as { code: string };

    const response = await api(`/${code}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), longUrl);
  });

  it("still resolves once the cache entry is gone and only the replica can answer", async () => {
    const longUrl = "https://example.com/from-replica";
    const { code } = (await (await createLink(longUrl)).json()) as { code: string };

    // Wait for the write to reach the replica, then drop the cached entry so
    // the next read has to go to the database.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await cache.forget(code);

    const response = await api(`/${code}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), longUrl);
  });

  it("reports replication lag on the readiness endpoint", async () => {
    const body = (await (await api("/ready")).json()) as { status: string; replicaLagSeconds: unknown };

    assert.equal(body.status, "ready");
    if (config.databaseReplicaUrl) {
      assert.equal(typeof body.replicaLagSeconds, "number");
    }
  });

  it("refuses writes on the replica", async (t) => {
    if (!replicaClient) {
      return t.skip("no replica configured");
    }

    // Proves the split is real: the read client physically cannot write, so a
    // stray write cannot silently succeed against the wrong node.
    await assert.rejects(
      replicaClient.$executeRaw`INSERT INTO links (id, code, "longUrl") VALUES (987654321, 'zzz', 'https://x')`,
      /read-only/i,
    );
  });
});

describe("metrics", () => {
  it("exposes a Prometheus exposition endpoint", async () => {
    const response = await api("/metrics");
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
    assert.match(body, /# HELP http_request_duration_seconds/);
    assert.match(body, /# TYPE http_request_duration_seconds histogram/);
  });

  it("labels requests with the route pattern, never the short code", async () => {
    // The cardinality trap: labelling with the actual path would mint a new
    // time series per short link. A million links would be a million series,
    // which is how people take down their own Prometheus.
    const { code } = (await (await createLink("https://example.com/metrics-label")).json()) as {
      code: string;
    };
    await api(`/${code}`);

    const body = await (await api("/metrics")).text();

    assert.match(body, /route="\/:code"/);
    assert.ok(!body.includes(`route="/${code}"`), "the code must never appear as a label value");
  });

  it("counts redirect cache outcomes", async () => {
    const { code } = (await (await createLink("https://example.com/metrics-cache")).json()) as {
      code: string;
    };
    await api(`/${code}`);

    const body = await (await api("/metrics")).text();
    assert.match(body, /redirect_cache_outcomes_total\{outcome="(hit|miss|coalesced)"\}/);
  });

  it("exposes event loop lag, the symptom of the known bottleneck", async () => {
    const body = await (await api("/metrics")).text();
    assert.match(body, /shortener_node_nodejs_eventloop_lag_seconds/);
  });

  it("does not measure the metrics endpoint itself", async () => {
    await api("/metrics");
    const body = await (await api("/metrics")).text();

    assert.ok(!body.includes('route="/metrics"'), "scraping must not appear as traffic");
  });
});
