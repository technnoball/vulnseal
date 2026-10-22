// Evidence files live on the local filesystem; their SHA-256 digests live in
// SQLite and are committed (inside the canonical payload) to the chain.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "./canonical.ts";

export const ALLOWED_MIME = new Map<string, string>([
  ["application/pdf", "pdf"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
  ["text/plain", "txt"],
  ["text/csv", "csv"],
  ["application/json", "json"],
]);
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
export function randomCode(len: number): string {
  const bytes = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] & 31];
  return s;
}

export type IntegrityResult = { status: "match" | "mismatch" | "missing"; expected: string; actual: string | null; checkedAt: string };

export class EvidenceVault {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  store(id: string, mime: string, data: Uint8Array): { storedName: string; sha256: string; size: number } {
    const ext = ALLOWED_MIME.get(mime) ?? "bin";
    const storedName = `${id}.${ext}`;
    fs.writeFileSync(path.join(this.dir, storedName), data, { flag: "wx" });
    return { storedName, sha256: sha256Hex(data), size: data.byteLength };
  }

  pathOf(storedName: string): string {
    // storedName is generated server-side, but guard against traversal anyway
    const p = path.join(this.dir, path.basename(storedName));
    return p;
  }

  verify(storedName: string, expectedSha: string): IntegrityResult {
    const p = this.pathOf(storedName);
    const checkedAt = new Date().toISOString();
    if (!fs.existsSync(p)) return { status: "missing", expected: expectedSha, actual: null, checkedAt };
    const actual = sha256Hex(fs.readFileSync(p));
    return { status: actual === expectedSha ? "match" : "mismatch", expected: expectedSha, actual, checkedAt };
  }
}
