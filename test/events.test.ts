import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashIp, nullEventPublisher, parseClickEvent } from "../src/events.js";

describe("hashIp", () => {
  it("never returns the address it was given", () => {
    const hashed = hashIp("203.0.113.7");
    assert.ok(hashed);
    assert.ok(!hashed.includes("203.0.113.7"));
  });

  it("is stable, so unique visitors can be counted", () => {
    assert.equal(hashIp("203.0.113.7"), hashIp("203.0.113.7"));
  });

  it("separates different visitors", () => {
    assert.notEqual(hashIp("203.0.113.7"), hashIp("203.0.113.8"));
  });

  it("passes through a missing address rather than hashing undefined", () => {
    assert.equal(hashIp(undefined), undefined);
    assert.equal(hashIp(""), undefined);
  });
});

describe("parseClickEvent", () => {
  const valid = JSON.stringify({
    code: "0EjtcvP",
    occurredAt: "2026-08-28T12:00:00.000Z",
    userAgent: "curl/8",
    referer: "https://ref.example",
    ipHash: "abc123",
  });

  it("round-trips a well-formed event", () => {
    assert.deepEqual(parseClickEvent(valid), {
      code: "0EjtcvP",
      occurredAt: "2026-08-28T12:00:00.000Z",
      userAgent: "curl/8",
      referer: "https://ref.example",
      ipHash: "abc123",
    });
  });

  it("keeps optional fields optional", () => {
    const minimal = JSON.stringify({ code: "abc", occurredAt: "2026-08-28T12:00:00.000Z" });
    assert.deepEqual(parseClickEvent(minimal), {
      code: "abc",
      occurredAt: "2026-08-28T12:00:00.000Z",
      userAgent: undefined,
      referer: undefined,
      ipHash: undefined,
    });
  });

  it("rejects anything malformed rather than letting it reach the database", () => {
    // One bad publisher must not be able to stop analytics for everyone, so
    // these are dropped rather than thrown.
    for (const payload of [
      "not json",
      "{}",
      JSON.stringify({ code: "abc" }),
      JSON.stringify({ code: 42, occurredAt: "2026-08-28T12:00:00.000Z" }),
      JSON.stringify({ code: "abc", occurredAt: "not a date" }),
    ]) {
      assert.equal(parseClickEvent(payload), null, `should reject: ${payload}`);
    }
  });

  it("ignores fields of the wrong type instead of trusting them", () => {
    const odd = JSON.stringify({
      code: "abc",
      occurredAt: "2026-08-28T12:00:00.000Z",
      userAgent: { nested: "object" },
    });
    assert.equal(parseClickEvent(odd)?.userAgent, undefined);
  });
});

describe("nullEventPublisher", () => {
  it("accepts events and does nothing", () => {
    assert.doesNotThrow(() =>
      nullEventPublisher.publishClick({ code: "abc", occurredAt: new Date().toISOString() }),
    );
  });
});
