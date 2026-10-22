import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, payloadDigest, CanonicalError } from "../../server/canonical.ts";

describe("canonical serialization", () => {
  it("is independent of key order and whitespace", () => {
    const a = canonicalize({ b: 1, a: { d: [1, 2], c: "x" } });
    const b = canonicalize(JSON.parse('{ "a": { "c": "x", "d": [1, 2] },   "b": 1 }'));
    assert.equal(a, b);
    assert.equal(a, '{"a":{"c":"x","d":[1,2]},"b":1}');
    assert.equal(payloadDigest(a), payloadDigest(b));
  });
  it("rejects non-integer numbers and normalises Unicode", () => {
    assert.throws(() => canonicalize({ x: 1.5 }), CanonicalError);
    assert.equal(canonicalize("é"), canonicalize("é"));
  });
  it("omits undefined keys", () => {
    assert.equal(canonicalize({ a: undefined, b: null }), '{"b":null}');
  });
});
