// Commitment construction and reveal checking. The exact encoding is documented in
// docs/commitment-protocol.md and must stay in step with VulnSeal.computeCommitment.
import { randomBytes } from "node:crypto";
import { AbiCoder, getAddress, hexlify, isHexString, keccak256, toUtf8Bytes } from "ethers";

export const REPORT_SCHEMA = "vulnseal.report.v1";
export const REVEAL_FORMAT = "vulnseal.reveal.v1";
export const RECEIPT_FORMAT = "vulnseal.receipt.v1";

export const REPORT_TAG = keccak256(toUtf8Bytes("VulnSeal.Report.v1"));
export const COMMIT_DOMAIN = keccak256(toUtf8Bytes("VulnSeal.Commitment.v1"));
export const REVEAL_TAG = keccak256(toUtf8Bytes("VulnSeal.Reveal.v1"));
export const NOTE_TAG = keccak256(toUtf8Bytes("VulnSeal.Note.v1"));
export const LOG_DOMAIN = keccak256(toUtf8Bytes("VulnSeal.Log.v1"));

/** Text fields in the order they are hashed. Changing this list means a new schema version. */
export const REPORT_FIELDS = ["title", "description", "impact", "reproduction", "scope", "severity"] as const;
export type ReportFields = Record<(typeof REPORT_FIELDS)[number], string> & { evidence: string[] };

const coder = AbiCoder.defaultAbiCoder();
const textHash = (s: string) => keccak256(toUtf8Bytes(s.normalize("NFC")));

export function evidenceRoot(sha256s: string[]): string {
  const sorted = [...sha256s].map((h) => "0x" + h.replace(/^0x/, "").toLowerCase()).sort();
  return keccak256(coder.encode(["bytes32[]"], [sorted]));
}

/** keccak256(abi.encode(tag, h(title), h(description), h(impact), h(reproduction), h(scope), h(severity), evidenceRoot)) */
export function fieldsDigest(r: ReportFields): string {
  return keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [REPORT_TAG, ...REPORT_FIELDS.map((f) => textHash(r[f])), evidenceRoot(r.evidence)],
    ),
  );
}

export interface CommitContext {
  chainId: number;
  contract: string;
  researcher: string;
  programId: number;
  policyVersion: number;
}

export function computeCommitment(ctx: CommitContext, digest: string, nonce: string): string {
  return keccak256(
    coder.encode(
      ["bytes32", "uint256", "address", "address", "uint32", "uint32", "bytes32", "bytes32"],
      [COMMIT_DOMAIN, ctx.chainId, ctx.contract, ctx.researcher, ctx.programId, ctx.policyVersion, digest, nonce],
    ),
  );
}

export const newNonce = () => hexlify(randomBytes(32));

/**
 * Recorded on-chain when a reveal is checked. It includes the secret nonce (hashed, never
 * disclosed) so that nobody without the reveal package can use it to test guesses about
 * the report's content.
 */
export function revealDigest(cid: number, digest: string, nonce: string): string {
  return keccak256(coder.encode(["bytes32", "uint64", "bytes32", "bytes32"], [REVEAL_TAG, cid, digest, nonce]));
}

/** Salted digest for free text recorded on-chain (rationales, claims), so short texts can't be guessed. */
export function noteDigest(text: string, salt: string): string {
  return keccak256(coder.encode(["bytes32", "bytes32", "bytes32"], [NOTE_TAG, salt, textHash(text)]));
}

export function logEntryHash(chainId: number, contract: string, e: { seq: number; kind: number; subject: bigint | number; actor: string; timestamp: number; dataHash: string; prevHash: string }) {
  return keccak256(
    coder.encode(
      ["bytes32", "uint256", "address", "uint64", "uint8", "uint64", "address", "uint64", "bytes32", "bytes32"],
      [LOG_DOMAIN, chainId, contract, e.seq, e.kind, e.subject, e.actor, e.timestamp, e.dataHash, e.prevHash],
    ),
  );
}

export interface RevealPackage {
  format: string;
  commitmentId: number;
  chainId: number;
  contract: string;
  researcher: string;
  programId: number;
  policyVersion: number;
  report: { schema: string } & ReportFields;
  nonce: string;
}

export type RevealCheck =
  | { outcome: "match"; fieldsDigest: string; commitment: string; revealDigest: string }
  | { outcome: "mismatch"; fieldsDigest: string; commitment: string; expected: string; revealDigest: string }
  | { outcome: "missing"; missing: string[] }
  | { outcome: "invalid-encoding"; problems: string[] };

/** Parse an untrusted reveal package and compare it with the anchored commitment. */
export function checkReveal(pkg: unknown, anchored: { cid: number; commitment: string } & CommitContext): RevealCheck {
  if (!pkg || typeof pkg !== "object") return { outcome: "invalid-encoding", problems: ["package is not a JSON object"] };
  const p = pkg as Record<string, any>;
  const problems: string[] = [];
  const missing: string[] = [];
  if (p.format !== REVEAL_FORMAT) problems.push(`format must be "${REVEAL_FORMAT}"`);
  if (p.nonce === undefined || p.nonce === null || p.nonce === "") missing.push("nonce");
  else if (typeof p.nonce !== "string" || !isHexString(p.nonce, 32)) problems.push("nonce must be 32 bytes of hex (0x + 64 hex digits)");
  const r = p.report;
  if (!r || typeof r !== "object") missing.push("report");
  else {
    if (r.schema !== REPORT_SCHEMA) problems.push(`report.schema must be "${REPORT_SCHEMA}"`);
    for (const f of REPORT_FIELDS) {
      if (r[f] === undefined || r[f] === null) missing.push(`report.${f}`);
      else if (typeof r[f] !== "string") problems.push(`report.${f} must be text`);
    }
    if (r.evidence === undefined) missing.push("report.evidence");
    else if (!Array.isArray(r.evidence) || r.evidence.some((h: unknown) => typeof h !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(h))) {
      problems.push("report.evidence must be a list of SHA-256 hex digests");
    }
    const extra = Object.keys(r).filter((k) => k !== "schema" && k !== "evidence" && !(REPORT_FIELDS as readonly string[]).includes(k));
    if (extra.length) problems.push(`unexpected report fields: ${extra.join(", ")}`);
  }
  for (const [k, want] of [
    ["commitmentId", anchored.cid],
    ["programId", anchored.programId],
    ["policyVersion", anchored.policyVersion],
    ["chainId", anchored.chainId],
  ] as const) {
    if (p[k] !== undefined && p[k] !== want) problems.push(`${k} is ${p[k]} but the commitment says ${want}`);
  }
  for (const [k, want] of [
    ["researcher", anchored.researcher],
    ["contract", anchored.contract],
  ] as const) {
    if (p[k] !== undefined) {
      try {
        if (getAddress(p[k]) !== getAddress(want)) problems.push(`${k} does not match the commitment`);
      } catch {
        problems.push(`${k} is not an address`);
      }
    }
  }
  if (problems.length) return { outcome: "invalid-encoding", problems };
  if (missing.length) return { outcome: "missing", missing };
  const digest = fieldsDigest(r as ReportFields);
  const recomputed = computeCommitment(anchored, digest, p.nonce);
  const rd = revealDigest(anchored.cid, digest, p.nonce);
  return recomputed === anchored.commitment
    ? { outcome: "match", fieldsDigest: digest, commitment: recomputed, revealDigest: rd }
    : { outcome: "mismatch", fieldsDigest: digest, commitment: recomputed, expected: anchored.commitment, revealDigest: rd };
}
