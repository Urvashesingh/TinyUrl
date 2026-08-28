import type { PrismaClient } from "@prisma/client";
import type { LinkCache } from "./cache.js";

export type CacheOutcome = "hit" | "miss" | "coalesced";

export interface Resolution {
  longUrl: string | null;
  cache: CacheOutcome;
}

export type LinkResolver = (code: string) => Promise<Resolution>;

/**
 * Cache-aside read path.
 *
 * Read the cache; on a miss read Postgres and populate the cache. Writes do
 * not touch the cache at all: a brand new code is not in it, and a request for
 * it will populate it on the way through. The alternative, write-through,
 * would fill the cache with links that may never be clicked.
 */
export function createLinkResolver(prisma: PrismaClient, cache: LinkCache): LinkResolver {
  // Single-flight: while one request is reading a given code from Postgres,
  // concurrent requests for the same code wait on that read instead of piling
  // on. This is what stops a newly popular link from turning a cold cache into
  // a thundering herd against the database.
  //
  // It is per-process, so with N instances a cold key still costs N reads
  // rather than one. That is a large enough improvement to be worth twelve
  // lines, and the cross-instance version needs a distributed lock whose
  // failure modes cost more than they save at this scale.
  const inFlight = new Map<string, Promise<string | null>>();

  async function readThrough(code: string): Promise<string | null> {
    const link = await prisma.link.findUnique({
      where: { code },
      select: { longUrl: true },
    });

    if (link) {
      await cache.remember(code, link.longUrl);
      return link.longUrl;
    }

    // Cache the absence too, otherwise a scanner walking the code space gets a
    // free pass straight to Postgres on every single request.
    await cache.rememberMissing(code);
    return null;
  }

  return async function resolve(code: string): Promise<Resolution> {
    const cached = await cache.lookup(code);

    if (cached.state === "hit") {
      return { longUrl: cached.longUrl, cache: "hit" };
    }

    if (cached.state === "known-missing") {
      return { longUrl: null, cache: "hit" };
    }

    const alreadyReading = inFlight.get(code);
    if (alreadyReading) {
      return { longUrl: await alreadyReading, cache: "coalesced" };
    }

    const pending = readThrough(code).finally(() => inFlight.delete(code));
    inFlight.set(code, pending);

    return { longUrl: await pending, cache: "miss" };
  };
}
