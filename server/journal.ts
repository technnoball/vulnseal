// The Hardhat node keeps its state in memory. To survive restarts, every raw signed
// transaction the app broadcasts is appended here, and on the next start the journal is
// replayed into a fresh node with the original block times. Transaction hashes, block
// numbers and contract state come out identical; replay() checks that they do.
import fs from "node:fs";
import path from "node:path";
import { JsonRpcProvider } from "ethers";

export type JournalEntry =
  | { kind: "tx"; raw: string; hash: string; block: number; timestamp: number }
  | { kind: "mine"; block: number; timestamp: number };

export class Journal {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  entries(): JournalEntry[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  append(e: JournalEntry) {
    const fd = fs.openSync(this.file, "a");
    try {
      fs.writeSync(fd, JSON.stringify(e) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export interface ReplayResult {
  transactions: number;
  emptyBlocks: number;
  lastBlock: number;
  ms: number;
}

export async function replay(provider: JsonRpcProvider, journal: Journal, onProgress?: (n: number, total: number) => void): Promise<ReplayResult> {
  const t0 = Date.now();
  const entries = journal.entries();
  let tx = 0;
  let mined = 0;
  for (const [i, e] of entries.entries()) {
    await provider.send("evm_setNextBlockTimestamp", [e.timestamp]);
    if (e.kind === "tx") {
      const hash = await provider.send("eth_sendRawTransaction", [e.raw]);
      if (hash !== e.hash) throw new Error(`replay diverged at entry ${i}: expected tx ${e.hash}, node returned ${hash}`);
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt || receipt.blockNumber !== e.block) {
        throw new Error(`replay diverged at entry ${i}: tx ${hash} landed in block ${receipt?.blockNumber}, journal says ${e.block}`);
      }
      tx++;
    } else {
      await provider.send("evm_mine", []);
      const n = await provider.getBlockNumber();
      if (n !== e.block) throw new Error(`replay diverged at entry ${i}: empty block ${n}, journal says ${e.block}`);
      mined++;
    }
    onProgress?.(i + 1, entries.length);
  }
  const lastBlock = await provider.getBlockNumber();
  return { transactions: tx, emptyBlocks: mined, lastBlock, ms: Date.now() - t0 };
}

/** After a replay the node's clock sits at the last journaled block; move it to now. */
export async function syncClock(provider: JsonRpcProvider, journal: Journal) {
  const entries = journal.entries();
  const last = entries.length ? entries[entries.length - 1].timestamp : 0;
  const ts = Math.max(Math.floor(Date.now() / 1000), last + 1);
  await provider.send("evm_setNextBlockTimestamp", [ts]);
  await provider.send("evm_mine", []);
  journal.append({ kind: "mine", block: await provider.getBlockNumber(), timestamp: ts });
}

export function firstTimestamp(journal: Journal): number | null {
  const e = journal.entries()[0];
  return e ? e.timestamp : null;
}
