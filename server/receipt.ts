// Commitment receipts: what a researcher keeps after anchoring, and how anyone with RPC
// access to the chain checks one. Receipts contain no report text and no nonce.
import { Contract, getAddress, type JsonRpcProvider } from "ethers";
import { RECEIPT_FORMAT, REPORT_SCHEMA, COMMIT_DOMAIN, checkReveal, logEntryHash, type RevealCheck } from "./commitment.ts";
import { loadArtifact } from "./chain.ts";

export interface Receipt {
  format: string;
  statement: { proves: string; doesNotProve: string };
  reportRef: string;
  commitmentId: number;
  commitment: string;
  schema: string;
  commitDomain: string;
  researcher: string;
  programId: number;
  programNameTag: string;
  policyVersion: number;
  policyDigest: string;
  chainId: number;
  contract: string;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  anchoredAt: number;
  anchoredAtIso: string;
  logSeq: number;
  logEntryHash: string;
  supersedes: number;
  issuedAt: string;
}

export const RECEIPT_STATEMENT = {
  proves:
    "That this exact commitment was recorded by this pseudonymous address for this program and policy version, in this transaction and block, before every later entry in the shared log. With the matching reveal package it also proves that a specific report and evidence set were committed at that point.",
  doesNotProve:
    "That the report is true, valid, reproducible, in scope or original, or when the researcher actually discovered the issue. Block time is set by whoever produces blocks (here a single local node).",
};

export const REQUIRED_RECEIPT_FIELDS: (keyof Receipt)[] = [
  "format",
  "commitmentId",
  "commitment",
  "researcher",
  "programId",
  "policyVersion",
  "policyDigest",
  "chainId",
  "contract",
  "txHash",
  "blockNumber",
  "blockHash",
  "anchoredAt",
  "logSeq",
  "logEntryHash",
];

export interface ReceiptCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export interface ReceiptVerification {
  verdict: "valid" | "invalid" | "incomplete";
  checks: ReceiptCheck[];
  missing: string[];
  reveal?: RevealCheck;
  verifiedAt: string;
}

/** Verify a receipt (and optionally a reveal package) directly against the chain. */
export async function verifyReceipt(input: unknown, provider: JsonRpcProvider, revealPackage?: unknown): Promise<ReceiptVerification> {
  const verifiedAt = new Date().toISOString();
  const checks: ReceiptCheck[] = [];
  const r = (input && typeof input === "object" ? input : {}) as Partial<Receipt>;
  const missing = REQUIRED_RECEIPT_FIELDS.filter((f) => r[f] === undefined || r[f] === null || r[f] === "");
  if (missing.length) return { verdict: "incomplete", checks, missing, verifiedAt };
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

  add("format", r.format === RECEIPT_FORMAT, `format is ${r.format}`);
  const net = await provider.getNetwork();
  add("chain id", Number(net.chainId) === Number(r.chainId), `node chain ${net.chainId}, receipt ${r.chainId}`);
  let contractAddress = "";
  try {
    contractAddress = getAddress(String(r.contract));
  } catch {
    add("contract address", false, "not a valid address");
    return { verdict: "invalid", checks, missing, verifiedAt };
  }
  const code = await provider.getCode(contractAddress);
  add("contract deployed", code !== "0x", code !== "0x" ? `code present at ${contractAddress}` : "no contract at this address");
  if (code === "0x") return { verdict: "invalid", checks, missing, verifiedAt };

  const c = new Contract(contractAddress, loadArtifact().abi, provider);
  let onchain: any;
  try {
    onchain = await c.getCommitment(r.commitmentId);
  } catch {
    add("commitment exists", false, `no commitment #${r.commitmentId} on-chain`);
    return { verdict: "invalid", checks, missing, verifiedAt };
  }
  add("commitment hash", onchain.commitment === r.commitment, onchain.commitment === r.commitment ? "matches the on-chain record" : `on-chain ${onchain.commitment}`);
  add("researcher", getAddress(onchain.researcher) === getAddress(String(r.researcher)), `on-chain ${onchain.researcher}`);
  add("program", Number(onchain.programId) === Number(r.programId), `on-chain program ${onchain.programId}`);
  add("policy version", Number(onchain.policyVersion) === Number(r.policyVersion), `on-chain version ${onchain.policyVersion}`);
  add("anchoring time", Number(onchain.anchoredAt) === Number(r.anchoredAt), `on-chain ${new Date(Number(onchain.anchoredAt) * 1000).toISOString()}`);
  const pd = await c.policyDigest(r.programId, r.policyVersion);
  add("policy digest", pd === r.policyDigest, pd === r.policyDigest ? "matches the registered policy" : `registered ${pd}`);
  add("log position", Number(onchain.logSeq) === Number(r.logSeq), `on-chain log seq ${onchain.logSeq}`);
  const entry = await c.logEntries(r.logSeq);
  add("log entry hash", entry === r.logEntryHash, entry === r.logEntryHash ? "matches the hash-chained log" : `on-chain ${entry}`);

  const tx = await provider.getTransactionReceipt(String(r.txHash));
  if (!tx) add("transaction", false, "transaction not found on this chain");
  else {
    add("transaction status", tx.status === 1, `status ${tx.status}`);
    add("block number", tx.blockNumber === Number(r.blockNumber), `transaction is in block ${tx.blockNumber}`);
    const block = await provider.getBlock(tx.blockNumber);
    add("block hash", block?.hash === r.blockHash, `block hash ${block?.hash}`);
    const ev = tx.logs
      .filter((l) => l.address.toLowerCase() === contractAddress.toLowerCase())
      .map((l) => {
        try {
          return c.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "CommitmentAnchored");
    add(
      "anchoring event",
      !!ev && Number(ev.args.cid) === Number(r.commitmentId) && ev.args.commitment === r.commitment,
      ev ? `event for #${ev.args.cid}` : "no CommitmentAnchored event in this transaction",
    );
  }

  let reveal: RevealCheck | undefined;
  if (revealPackage !== undefined) {
    reveal = checkReveal(revealPackage, {
      cid: Number(r.commitmentId),
      commitment: onchain.commitment,
      chainId: Number(r.chainId),
      contract: contractAddress,
      researcher: onchain.researcher,
      programId: Number(onchain.programId),
      policyVersion: Number(onchain.policyVersion),
    });
    add("reveal", reveal.outcome === "match", `reveal outcome: ${reveal.outcome}`);
  }
  return { verdict: checks.every((x) => x.ok) ? "valid" : "invalid", checks, missing, reveal, verifiedAt };
}

export function buildReceipt(a: Omit<Receipt, "format" | "statement" | "schema" | "commitDomain" | "issuedAt" | "anchoredAtIso">): Receipt {
  return {
    format: RECEIPT_FORMAT,
    statement: RECEIPT_STATEMENT,
    schema: REPORT_SCHEMA,
    commitDomain: COMMIT_DOMAIN,
    ...a,
    anchoredAtIso: new Date(a.anchoredAt * 1000).toISOString(),
    issuedAt: new Date().toISOString(),
  };
}

export { logEntryHash };
