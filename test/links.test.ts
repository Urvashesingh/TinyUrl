import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { CacheLookup, LinkCache } from "../src/cache.js";
import { createLinkResolver } from "../src/links.js";

// Unit tests for the cache-aside logic itself. No Redis and no Postgres here:
// the point is the decision-making, and fakes make the "how many times did we
// touch the database" assertions exact.

interface FakePrisma {
  client: PrismaClient;
  reads: number;
}

function fakePrisma(rows: Record<string, string>, delayMs = 0): FakePrisma {
  const state = { reads: 0 };
  const client = {
    link: {
      async findUnique({ where }: { where: { code: string } }) {
        state.reads += 1;
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const longUrl = rows[where.code];
        return longUrl ? { longUrl } : null;
      },
    },
  } as unknown as PrismaClient;

  return {
    client,
    get reads() {
      return state.reads;
    },
  } as FakePrisma;
}

function fakeCache(seed: Record<string, CacheLookup> = {}) {
  const entries = new Map<string, CacheLookup>(Object.entries(seed));
  const writes: Array<{ code: string; longUrl: string | null }> = [];

  const cache: LinkCache = {
    async lookup(code) {
      return entries.get(code) ?? { state: "miss" };
    },
    async remember(code, longUrl) {
      writes.push({ code, longUrl });
      entries.set(code, { state: "hit", longUrl });
    },
    async rememberMissing(code) {
      writes.push({ code, longUrl: null });
      entries.set(code, { state: "known-missing" });
    },
    async forget(code) {
      entries.delete(code);
    },
  };

  return { cache, writes };
}

describe("createLinkResolver", () => {
  it("serves a cache hit without touching the database", async () => {
    const prisma = fakePrisma({ abc: "https://example.com/from-db" });
    const { cache } = fakeCache({ abc: { state: "hit", longUrl: "https://example.com/cached" } });

    const result = await createLinkResolver(prisma.client, cache)("abc");

    assert.deepEqual(result, { longUrl: "https://example.com/cached", cache: "hit" });
    assert.equal(prisma.reads, 0);
  });

  it("reads through on a miss and populates the cache", async () => {
    const prisma = fakePrisma({ abc: "https://example.com/target" });
    const { cache, writes } = fakeCache();
    const resolve = createLinkResolver(prisma.client, cache);

    const first = await resolve("abc");
    assert.deepEqual(first, { longUrl: "https://example.com/target", cache: "miss" });
    assert.equal(prisma.reads, 1);
    assert.deepEqual(writes, [{ code: "abc", longUrl: "https://example.com/target" }]);

    // The populated entry must satisfy the next request on its own.
    const second = await resolve("abc");
    assert.equal(second.cache, "hit");
    assert.equal(prisma.reads, 1);
  });

  it("negatively caches an unknown code so scanners cannot reach the database twice", async () => {
    const prisma = fakePrisma({});
    const { cache, writes } = fakeCache();
    const resolve = createLinkResolver(prisma.client, cache);

    assert.equal((await resolve("nope")).longUrl, null);
    assert.deepEqual(writes, [{ code: "nope", longUrl: null }]);

    assert.equal((await resolve("nope")).longUrl, null);
    assert.equal(prisma.reads, 1, "second lookup must be served by the negative cache");
  });

  it("treats a cached miss as authoritative", async () => {
    const prisma = fakePrisma({ abc: "https://example.com/target" });
    const { cache } = fakeCache({ abc: { state: "known-missing" } });

    const result = await createLinkResolver(prisma.client, cache)("abc");

    assert.equal(result.longUrl, null);
    assert.equal(prisma.reads, 0);
  });

  it("coalesces concurrent misses for the same code into one database read", async () => {
    const prisma = fakePrisma({ hot: "https://example.com/viral" }, 25);
    const { cache } = fakeCache();
    const resolve = createLinkResolver(prisma.client, cache);

    const results = await Promise.all(Array.from({ length: 20 }, () => resolve("hot")));

    assert.equal(prisma.reads, 1, "a cold hot key must not stampede the database");
    assert.ok(results.every((r) => r.longUrl === "https://example.com/viral"));
    assert.equal(results.filter((r) => r.cache === "miss").length, 1);
    assert.equal(results.filter((r) => r.cache === "coalesced").length, 19);
  });

  it("does not coalesce different codes", async () => {
    const prisma = fakePrisma({ a: "https://example.com/a", b: "https://example.com/b" }, 10);
    const { cache } = fakeCache();
    const resolve = createLinkResolver(prisma.client, cache);

    await Promise.all([resolve("a"), resolve("b")]);
    assert.equal(prisma.reads, 2);
  });

  it("stops coalescing once the in-flight read settles", async () => {
    const prisma = fakePrisma({ abc: "https://example.com/target" }, 5);
    const { cache } = fakeCache();
    const resolve = createLinkResolver(prisma.client, cache);

    await resolve("abc");
    const second = await resolve("abc");

    // Served from the now-populated cache, not left waiting on a stale entry.
    assert.equal(second.cache, "hit");
  });

  it("keeps serving from the database when the cache never returns anything", async () => {
    // This is the Redis-is-down shape: every lookup reports a miss and every
    // write is silently dropped. Requests must still succeed, just slower.
    const prisma = fakePrisma({ abc: "https://example.com/target" });
    const deadCache: LinkCache = {
      async lookup(): Promise<CacheLookup> {
        return { state: "miss" };
      },
      async remember() {},
      async rememberMissing() {},
      async forget() {},
    };

    const resolve = createLinkResolver(prisma.client, deadCache);

    assert.equal((await resolve("abc")).longUrl, "https://example.com/target");
    assert.equal((await resolve("abc")).longUrl, "https://example.com/target");
    assert.equal(prisma.reads, 2, "every request reads through when the cache is unavailable");
  });
});
