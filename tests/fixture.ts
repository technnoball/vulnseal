// A fresh chain with VulnSeal deployed, three programs and every demo identity registered.
import { keccak256, toUtf8Bytes } from "ethers";
import { startChain, type ChainProcess } from "../scripts/lib/chainproc.ts";
import { Ledger, deployVulnSeal, eventArg, registerParticipants } from "../server/chain.ts";
import { computeCommitment, fieldsDigest, newNonce, revealDigest, type ReportFields } from "../server/commitment.ts";
import { PROGRAMS, REVEAL } from "../server/domain.ts";
import { Keyring } from "../server/keys.ts";

export interface Deployment {
  chain: ChainProcess;
  ledger: Ledger;
  keyring: Keyring;
  stop: () => Promise<void>;
}

export async function freshDeployment(appealWindowSeconds = 3600): Promise<Deployment> {
  const chain = await startChain();
  const keyring = Keyring.generate();
  const { address } = await deployVulnSeal({ rpcUrl: chain.url, keyring, appealWindowSeconds });
  const ledger = new Ledger({ rpcUrl: chain.url, address, keyring });
  for (const p of PROGRAMS) {
    await ledger.send("governor", "registerProgram", [keccak256(toUtf8Bytes(p.slug)), keccak256(toUtf8Bytes(`${p.slug} policy v1`))]);
  }
  await registerParticipants(ledger);
  return {
    chain,
    ledger,
    keyring,
    stop: async () => {
      ledger.provider.destroy();
      await chain.stop();
    },
  };
}

let counter = 0;
export function sampleReport(over: Partial<ReportFields> = {}): ReportFields {
  counter++;
  return {
    title: `Synthetic finding ${counter}`,
    description: `Test description ${counter} with enough words to be a description.`,
    impact: "Synthetic impact statement.",
    reproduction: "1. Open the synthetic page. 2. Observe the synthetic result.",
    scope: "synthetic.example",
    severity: "medium",
    evidence: [],
    ...over,
  };
}

/** Anchor a commitment for a report and return everything needed to reveal it later. */
export async function anchor(ledger: Ledger, researcher: string, programId: number, report = sampleReport(), policyVersion = 1) {
  const nonce = newNonce();
  const digest = fieldsDigest(report);
  const commitment = computeCommitment(
    { chainId: ledger.chainId, contract: ledger.address, researcher: ledger.keyring.address(researcher), programId, policyVersion },
    digest,
    nonce,
  );
  const tx = await ledger.send(researcher, "anchorCommitment", [commitment, programId, policyVersion]);
  const cid = Number(eventArg(tx.events, "CommitmentAnchored", "cid"));
  return { cid, report, nonce, digest, commitment, tx };
}

/** Walk a commitment through acknowledge -> request reveal -> matching reveal check. */
export async function reveal(ledger: Ledger, a: { cid: number; digest: string }, reviewer: string) {
  await ledger.send(reviewer, "acknowledge", [a.cid]);
  await ledger.send(reviewer, "requestReveal", [a.cid]);
  await ledger.send(reviewer, "recordReveal", [a.cid, REVEAL.MATCH, revealDigest(a.cid, a.digest)]);
}
