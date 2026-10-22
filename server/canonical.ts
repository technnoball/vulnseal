// Canonical serialization for off-chain payloads.
//
// Rules (a strict subset of RFC 8785 / JCS, chosen so every value has exactly
// one encoding):
//   * object keys sorted by UTF-16 code unit order; keys with `undefined` are omitted
//   * no insignificant whitespace
//   * strings are NFC-normalised, then JSON-escaped
//   * numbers must be safe integers (floats are rejected: encode them as strings)
//   * arrays keep their order
// The on-chain payload digest is keccak256(utf8(canonical)). Evidence files are
// hashed separately with SHA-256 over the raw bytes.
import { createHash } from "node:crypto";
import { keccak256, toUtf8Bytes } from "ethers";

export class CanonicalError extends Error {}

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalError(`non-integer number ${value} is not canonical`);
      return String(value);
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((v) => canonicalize(v === undefined ? null : v)).join(",") + "]";
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return "{" + keys.map((k) => JSON.stringify(k.normalize("NFC")) + ":" + canonicalize(obj[k])).join(",") + "}";
    }
    default:
      throw new CanonicalError(`type ${typeof value} cannot be canonicalized`);
  }
}

export function payloadDigest(canonical: string): string {
  return keccak256(toUtf8Bytes(canonical));
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}
