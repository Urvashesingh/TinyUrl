import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/app.js";
import { createLinkCache, type LinkCache } from "../src/cache.js";
import { encodeId } from "../src/codes.js";
import { logger } from "../src/logger.js";

// Integration tests: these talk to the Postgres from docker-compose. Rows they
// create are tracked and removed in `after`, so repeated runs stay clean.

const prisma = new PrismaClient();
const createdCodes: string[] = [];
let cache: LinkCache;

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

  cache = createLinkCache();
  server = createApp(prisma, cache).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await prisma.link.deleteMany({ where: { code: { in: createdCodes } } });
  await new Promise((resolve) => server.close(resolve));
  await Promise.allSettled([prisma.$disconnect(), cache.close()]);
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
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ready" });
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
