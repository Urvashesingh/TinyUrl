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
} as const;
