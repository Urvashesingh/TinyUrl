import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { base62Decode, base62Encode } from "../src/base62.js";

describe("base62Encode", () => {
  it("encodes the boundaries of the first digit", () => {
    assert.equal(base62Encode(0n), "0");
    assert.equal(base62Encode(9n), "9");
    assert.equal(base62Encode(10n), "A");
    assert.equal(base62Encode(35n), "Z");
    assert.equal(base62Encode(36n), "a");
    assert.equal(base62Encode(61n), "z");
  });

  it("rolls over to a second digit", () => {
    assert.equal(base62Encode(62n), "10");
    assert.equal(base62Encode(63n), "11");
    assert.equal(base62Encode(3843n), "zz");
  });

  it("handles values far beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = 9_007_199_254_740_993n;
    assert.equal(base62Decode(base62Encode(huge)), huge);
  });

  it("rejects negative values", () => {
    assert.throws(() => base62Encode(-1n), RangeError);
  });
});

describe("base62Decode", () => {
  it("round-trips every encoded value", () => {
    for (let value = 0n; value < 5_000n; value += 1n) {
      assert.equal(base62Decode(base62Encode(value)), value);
    }
  });

  it("ignores leading zeroes, which is what padding relies on", () => {
    assert.equal(base62Decode("0000010"), 62n);
  });

  it("returns null for characters outside the alphabet", () => {
    assert.equal(base62Decode("abc-def"), null);
    assert.equal(base62Decode("héllo"), null);
    assert.equal(base62Decode(""), null);
  });
});
