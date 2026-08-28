import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CODE_LENGTH, CODE_SPACE, decodeCode, encodeId } from "../src/codes.js";

describe("encodeId", () => {
  it("always produces a fixed-width code", () => {
    for (const id of [0n, 1n, 62n, 1_000_000n, CODE_SPACE - 1n]) {
      assert.equal(encodeId(id).length, CODE_LENGTH);
    }
  });

  it("does not leak sequence position to a caller counting upwards", () => {
    const codes = [1n, 2n, 3n].map(encodeId);
    // Consecutive ids must not produce codes an attacker can guess by
    // incrementing the last character.
    assert.notEqual(codes[0].slice(0, -1), codes[1].slice(0, -1));
    assert.notEqual(codes[1].slice(0, -1), codes[2].slice(0, -1));
  });

  it("rejects ids outside the code space", () => {
    assert.throws(() => encodeId(-1n), RangeError);
    assert.throws(() => encodeId(CODE_SPACE), RangeError);
  });
});

describe("decodeCode", () => {
  it("is the exact inverse of encodeId", () => {
    for (let id = 0n; id < 20_000n; id += 1n) {
      assert.equal(decodeCode(encodeId(id)), id);
    }
  });

  it("stays injective at the top of the code space", () => {
    const seen = new Set<string>();
    for (let offset = 0n; offset < 5_000n; offset += 1n) {
      const id = CODE_SPACE - 1n - offset;
      const code = encodeId(id);
      assert.equal(seen.has(code), false, `collision on ${code}`);
      seen.add(code);
      assert.equal(decodeCode(code), id);
    }
  });

  it("rejects codes of the wrong length", () => {
    assert.equal(decodeCode(""), null);
    assert.equal(decodeCode("abc"), null);
    assert.equal(decodeCode("abcdefgh"), null);
  });

  it("rejects codes containing characters we never emit", () => {
    assert.equal(decodeCode("abc-def"), null);
    assert.equal(decodeCode("../../et"), null);
  });
});
