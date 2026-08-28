import { createHash } from "node:crypto";
import type Redis from "ioredis";
import { config } from "./config.js";

export interface ClickEvent {
  code: string;
  /** ISO 8601. Set by the edge that served the redirect, not by the consumer. */
  occurredAt: string;
  userAgent?: string;
  referer?: string;
  ipHash?: string;
}

export const CLICK_CHANNEL = "clicks";

/**
 * Never store the address itself. A salted hash is enough to count unique
 * visitors and not enough to identify one; without the salt a raw hash of an
 * IPv4 address is trivially reversible, since the entire space is only 2^32.
 */
export function hashIp(ip: string | undefined): string | undefined {
  if (!ip) {
    return undefined;
  }

  return createHash("sha256").update(`${config.ipHashSalt}:${ip}`).digest("hex").slice(0, 32);
}

export interface EventPublisher {
  /**
   * Fire and forget, by contract. A redirect must never wait on analytics, and
   * must never fail because analytics failed -- so this returns void rather
   * than a promise the caller might be tempted to await.
   */
  publishClick(event: ClickEvent): void;
}

export function createRedisEventPublisher(
  redis: Redis,
  onDrop?: (error: unknown) => void,
): EventPublisher {
  return {
    publishClick(event) {
      // Not awaited on purpose. The redirect is already on its way out.
      void redis.publish(CLICK_CHANNEL, JSON.stringify(event)).catch((error) => {
        // Redis pub/sub is at-most-once: this event is simply gone. That is
        // the accepted cost at this phase and the reason Phase 4 exists.
        onDrop?.(error);
      });
    },
  };
}

/** Used by tests and by any deployment that wants analytics switched off. */
export const nullEventPublisher: EventPublisher = {
  publishClick() {},
};

export function parseClickEvent(payload: string): ClickEvent | null {
  try {
    const parsed = JSON.parse(payload) as Partial<ClickEvent>;
    if (typeof parsed.code !== "string" || typeof parsed.occurredAt !== "string") {
      return null;
    }

    if (Number.isNaN(Date.parse(parsed.occurredAt))) {
      return null;
    }

    return {
      code: parsed.code,
      occurredAt: parsed.occurredAt,
      userAgent: typeof parsed.userAgent === "string" ? parsed.userAgent : undefined,
      referer: typeof parsed.referer === "string" ? parsed.referer : undefined,
      ipHash: typeof parsed.ipHash === "string" ? parsed.ipHash : undefined,
    };
  } catch {
    return null;
  }
}
