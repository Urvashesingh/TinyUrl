import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeRequestUrl } from "../src/vercelPath.js";

// Every request reaches the serverless function through one catch-all rewrite.
// If the original path is not recovered correctly, every short code resolves to
// the same route and the entire service 404s -- so this is worth pinning down
// rather than discovering after a deploy.

describe("normalizeRequestUrl", () => {
  it("recovers a short code from the rewrite", () => {
    assert.equal(normalizeRequestUrl("/api?__path=0EjtcvP"), "/0EjtcvP");
  });

  it("recovers the root path", () => {
    assert.equal(normalizeRequestUrl("/api?__path="), "/");
  });

  it("recovers a multi-segment path", () => {
    assert.equal(normalizeRequestUrl("/api?__path=links/0EjtcvP/stats"), "/links/0EjtcvP/stats");
  });

  it("keeps the caller's own query parameters", () => {
    assert.equal(normalizeRequestUrl("/api?__path=search&q=hello&page=2"), "/search?q=hello&page=2");
  });

  it("drops only the injected parameter", () => {
    const result = normalizeRequestUrl("/api?__path=x&__path_hint=keep");
    assert.ok(!result.includes("__path="), result);
    assert.ok(result.includes("__path_hint=keep"), result);
  });

  it("leaves a normal URL untouched when the rewrite is not in play", () => {
    // Running the module directly, or locally under node.
    assert.equal(normalizeRequestUrl("/0EjtcvP"), "/0EjtcvP");
    assert.equal(normalizeRequestUrl("/links"), "/links");
    assert.equal(normalizeRequestUrl("/health?verbose=1"), "/health?verbose=1");
  });

  it("tolerates a path that already has a leading slash", () => {
    assert.equal(normalizeRequestUrl("/api?__path=/0EjtcvP"), "/0EjtcvP");
  });

  it("preserves percent-encoded characters in the query", () => {
    assert.equal(normalizeRequestUrl("/api?__path=go&to=a%20b"), "/go?to=a+b");
  });
});
