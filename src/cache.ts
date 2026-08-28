import type Redis from "ioredis";
import { config } from "./config.js";

export type CacheLookup =
  | { state: "hit"; longUrl: string }
  | { state: "known-missing" }
  | { state: "miss" };

export interface LinkCache {
  lookup(code: string): Promise<CacheLookup>;
  remember(code: string, longUrl: string): Promise<void>;
  rememberMissing(code: string): Promise<void>;
  forget(code: string): Promise<void>;
}

// Versioned key prefix. If the stored shape ever changes, bumping this rolls
// the whole cache over atomically instead of leaving old entries to be
// misread by new code.
const KEY_PREFIX = "link:v1:";

// Sentinel for a negatively cached code. No valid longUrl can collide with it
// because a NUL byte cannot survive URL parsing.
const MISSING = "\u0000missing";

function keyFor(code: string): string {
  return `${KEY_PREFIX}${code}`;
}

export function createLinkCache(redis: Redis): LinkCache {
  return {
    async lookup(code) {
      try {
        const cached = await redis.get(keyFor(code));
        if (cached === null) {
          return { state: "miss" };
        }

        return cached === MISSING ? { state: "known-missing" } : { state: "hit", longUrl: cached };
      } catch {
        // Degrade, do not fail. The caller reads through to Postgres.
        return { state: "miss" };
      }
    },

    async remember(code, longUrl) {
      try {
        await redis.set(keyFor(code), longUrl, "EX", config.cacheTtlSeconds);
      } catch {
        // A write-through failure only costs us the next read.
      }
    },

    async rememberMissing(code) {
      try {
        await redis.set(keyFor(code), MISSING, "EX", config.missCacheTtlSeconds);
      } catch {
        // As above.
      }
    },

    async forget(code) {
      try {
        await redis.del(keyFor(code));
      } catch {
        // The entry expires on its own; this only shortens the window.
      }
    },
  };
}
