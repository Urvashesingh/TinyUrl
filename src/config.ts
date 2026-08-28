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

  /**
   * Read replica. When unset, reads go to the primary -- the split is an
   * optimisation, and a single-node deployment must still work unchanged.
   */
  databaseReplicaUrl: process.env.DATABASE_REPLICA_URL || null,

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
  /**
   * Salt for hashing visitor IPs before storage. An unsalted hash of an IPv4
   * address is trivially reversible -- the whole space is 2^32 -- so this must
   * be set to something secret in production.
   */
  ipHashSalt: process.env.IP_HASH_SALT ?? "local-development-salt",

  /**
   * Which transport carries click events. "redis" is Phase 3 pub/sub, which is
   * at-most-once and loses everything published while no consumer is
   * connected. "kafka" is Phase 4: durable, replayable, at-least-once.
   */
  eventTransport: (process.env.EVENT_TRANSPORT ?? "kafka") as "redis" | "kafka",

  kafka: {
    brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((b) => b.trim()),
    groupId: process.env.KAFKA_GROUP_ID ?? "click-consumer",
    /**
     * Partition count is effectively permanent: raising it later rehashes keys
     * to different partitions and breaks per-key ordering for existing keys.
     * It also caps consumer parallelism, since one partition is consumed by at
     * most one member of a group.
     */
    partitions: readInteger("CLICK_TOPIC_PARTITIONS", 3),
  },

  trending: {
    /** Length of the sliding window, in one-minute buckets. */
    windowMinutes: readInteger("TRENDING_WINDOW_MINUTES", 10),
    limit: readInteger("TRENDING_LIMIT", 10),
    /**
     * How often the leaderboard is recomputed and pushed. The union across
     * buckets is the expensive part, so it happens on this timer and is shared
     * by every connected client rather than recomputed per request.
     */
    refreshMs: readInteger("TRENDING_REFRESH_MS", 2_000),
  },

  /** Analytics batching: flush on whichever trigger fires first. */
  clickBatch: {
    maxSize: readInteger("CLICK_BATCH_SIZE", 100),
    maxDelayMs: readInteger("CLICK_BATCH_DELAY_MS", 500),
  },

  redirectRateLimit: {
    limit: readInteger("REDIRECT_RATE_LIMIT", 600),
    windowSeconds: readInteger("REDIRECT_RATE_WINDOW_SECONDS", 60),
  },
} as const;
