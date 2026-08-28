import "dotenv/config";

function readInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }

  return parsed;
}

export const config = {
  port: readInteger("PORT", 3000),

  /**
   * Longest URL we will store. Browsers and proxies start misbehaving well
   * before this, and an unbounded TEXT column is a cheap way to let someone
   * push megabytes into the table.
   */
  maxUrlLength: readInteger("MAX_URL_LENGTH", 2048),

  /** Request bodies are a single small JSON object; nothing needs to be big. */
  jsonBodyLimit: process.env.JSON_BODY_LIMIT ?? "4kb",

  /**
   * Public origin used to build shortUrl. When unset we fall back to the
   * request's Host header, which is fine locally but attacker-controlled in
   * production -- set this once the service sits behind a real domain.
   */
  baseUrl: process.env.BASE_URL?.replace(/\/+$/, "") || null,

  /** Enable when running behind a load balancer so req.protocol sees X-Forwarded-Proto. */
  trustProxy: process.env.TRUST_PROXY === "true",

  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",

  /**
   * How long a resolved link stays cached. Links are immutable today, so this
   * is purely a memory bound rather than a staleness bound -- see the note on
   * invalidation in the README before that stops being true.
   */
  cacheTtlSeconds: readInteger("CACHE_TTL_SECONDS", 3600),

  /**
   * Misses are cached too, so a scanner walking the code space cannot turn
   * every request into a database read. Kept short: a cached miss is a promise
   * that a code does not exist, and codes get created all the time.
   */
  missCacheTtlSeconds: readInteger("MISS_CACHE_TTL_SECONDS", 30),

  logLevel: process.env.LOG_LEVEL ?? "info",

  /**
   * Creation is the expensive, abusable path: it writes a row and mints a
   * permanent public identifier. Kept deliberately tight.
   */
  createRateLimit: {
    limit: readInteger("CREATE_RATE_LIMIT", 20),
    windowSeconds: readInteger("CREATE_RATE_WINDOW_SECONDS", 60),
  },

  /**
   * Redirects are the product, so this ceiling exists to blunt scanners rather
   * than to ration real traffic. It sits far above anything a human browsing
   * links could produce.
   */
  redirectRateLimit: {
    limit: readInteger("REDIRECT_RATE_LIMIT", 600),
    windowSeconds: readInteger("REDIRECT_RATE_WINDOW_SECONDS", 60),
  },
} as const;
