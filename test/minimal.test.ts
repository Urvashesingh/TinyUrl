import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

// The serverless deployment shape: Postgres only, no Redis, no Kafka, no
// background timers, and creation behind an API key.
//
// The environment is set before the dynamic imports below because config.ts
// reads process.env once, at module load. node --test runs each file in its
// own process, so this cannot leak into another suite.
process.env.APP_PROFILE = "minimal";
process.env.CREATE_API_KEY = "test-key";

const { createApp } = await import("../src/app.js");
const { createNullCache } = await import("../src/cache.js");
const { nullEventPublisher } = await import("../src/events.js");
const { logger } = await import("../src/logger.js");

const prisma = new PrismaClient();
const createdCodes: string[] = [];

let server: Server;
let origin: string;

const api = (path: string, init?: RequestInit) =>
  fetch(`${origin}${path}`, { redirect: "manual", ...init });

async function createLink(longUrl: string, key: string | null = "test-key"): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) {
    headers["X-API-Key"] = key;
  }

  const response = await api("/links", { method: "POST", headers, body: JSON.stringify({ longUrl }) });
  if (response.status === 201) {
    createdCodes.push(((await response.clone().json()) as { code: string }).code);
  }
  return response;
}

before(async () => {
  logger.level = "silent";
  server = createApp({
    db: { write: prisma, read: prisma },
    cache: createNullCache(),
    events: nullEventPublisher,
    // No redis on purpose: this is the whole point of the profile.
  }).listen(0);

  await new Promise((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await prisma.link.deleteMany({ where: { code: { in: createdCodes } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

describe("minimal profile", () => {
  it("creates and redirects with no Redis at all", async () => {
    const longUrl = "https://example.com/serverless";
    const { code } = (await (await createLink(longUrl)).json()) as { code: string };

    const redirect = await api(`/${code}`);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), longUrl);
  });

  it("still resolves on a second request, with nothing cached between them", async () => {
    // The null cache reports a miss every time, so both requests read Postgres.
    // Slower, and identical from the outside -- which is what lets the same
    // code serve both deployment shapes.
    const longUrl = "https://example.com/uncached";
    const { code } = (await (await createLink(longUrl)).json()) as { code: string };

    assert.equal((await api(`/${code}`)).status, 302);
    assert.equal((await api(`/${code}`)).headers.get("location"), longUrl);
  });

  it("404s an unknown code", async () => {
    assert.equal((await api("/aaaaaaa")).status, 404);
  });

  it("serves health and readiness", async () => {
    assert.equal((await api("/health")).status, 200);

    const ready = (await (await api("/ready")).json()) as { status: string; profile: string };
    assert.equal(ready.status, "ready");
    assert.equal(ready.profile, "minimal");
  });
});

describe("API key gate", () => {
  it("refuses creation without a key", async () => {
    const response = await createLink("https://example.com/nokey", null);
    assert.equal(response.status, 401);
  });

  it("refuses creation with the wrong key", async () => {
    const response = await createLink("https://example.com/wrongkey", "not-the-key");
    assert.equal(response.status, 401);
  });

  it("accepts creation with the right key", async () => {
    const response = await createLink("https://example.com/withkey");
    assert.equal(response.status, 201);
  });

  it("leaves redirects public", async () => {
    // The entire point of a short link is that anyone can follow it. Only
    // creation is gated.
    const longUrl = "https://example.com/public-redirect";
    const { code } = (await (await createLink(longUrl)).json()) as { code: string };

    const response = await fetch(`${origin}/${code}`, { redirect: "manual" });
    assert.equal(response.status, 302);
  });
});

describe("features that need a long-lived process", () => {
  it("does not expose trending, which is backed by Redis", async () => {
    // Omitted rather than stubbed: a board that is always empty looks broken.
    assert.equal((await api("/trending")).status, 404);
  });

  it("does not rate limit, since that needs shared state", async () => {
    // A per-instance limiter on a serverless platform counts each cold start
    // separately, which is worse than none because it looks like protection.
    const response = await createLink("https://example.com/no-limit-headers");
    assert.equal(response.headers.get("x-ratelimit-limit"), null);
  });
});
