// Ethers client for the VulnSeal contract. Transactions are signed here (not by the
// node) so the raw bytes can be journaled for replay. Roles are never pre-checked:
// the contract decides, and its custom errors are turned into readable messages.
import fs from "node:fs";
import path from "node:path";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Network,
  type InterfaceAbi,
  type LogDescription,
  type TransactionRequest,
  type Wallet,
} from "ethers";
import { IDENTITY_DEFS, ROLE, roleMask } from "./domain.ts";
import type { Journal } from "./journal.ts";
import { faucetWallet, type Keyring } from "./keys.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
export const ARTIFACT_PATH = path.join(ROOT, "build/artifacts/contracts/VulnSeal.sol/VulnSeal.json");

export function loadArtifact(): { abi: InterfaceAbi; bytecode: string } {
  if (!fs.existsSync(ARTIFACT_PATH)) throw new Error(`Contract artifact missing at ${ARTIFACT_PATH}. Run: npm run compile`);
  return JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));
}

export function makeProvider(rpcUrl: string, chainId = 31337): JsonRpcProvider {
  const network = Network.from(chainId);
  const p = new JsonRpcProvider(rpcUrl, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
  p.pollingInterval = 100;
  return p;
}

export class LedgerError extends Error {
  status: number;
  contractError?: { name: string; args: string[] };
  constructor(message: string, status: number, contractError?: { name: string; args: string[] }) {
    super(message);
    this.status = status;
    this.contractError = contractError;
  }
}

export interface TxResult {
  hash: string;
  blockNumber: number;
  timestamp: number;
  gasUsed: number;
  events: LogDescription[];
}

const roleNames = (mask: number) =>
  Object.entries(ROLE)
    .filter(([, v]) => (mask & v) !== 0)
    .map(([k]) => k.toLowerCase().replace("_", " "))
    .join(" or ");

const ERRORS: Record<string, [number, (a: string[]) => string]> = {
  NotGovernor: [403, () => "only the consortium desk can do this"],
  NotAuthorized: [403, (a) => `this account does not hold the ${roleNames(Number(a[1]))} role`],
  WrongProgram: [403, (a) => `this account belongs to program ${a[1] === "0" ? "none" : a[1]}, not program ${a[0]}`],
  SelfReview: [403, () => "the researcher who submitted a report cannot review it"],
  NotCommitmentOwner: [403, () => "only the researcher who anchored a commitment can revise it"],
  ProposerCannotReview: [403, () => "whoever proposed an association cannot also review it"],
  ConflictedArbitrator: [403, (a) => `this arbitrator is affiliated with program ${a[0]}, which is involved in the dispute, and must recuse`],
  PartyCannotVote: [403, () => "a party to the dispute cannot vote on it"],
  PriorPanelMember: [403, () => "arbitrators who decided the first round cannot sit on the appeal"],
  ArbitratorRecused: [403, () => "this arbitrator has recused from the dispute"],
  NotAParty: [403, () => "only the researchers or program admins involved can do this"],
  AlreadyVoted: [409, () => "this arbitrator has already voted in this round"],
  ReplayedCommitment: [409, () => "this commitment was already anchored by this account"],
  AlreadySuperseded: [409, (a) => `commitment ${a[0]} was already replaced by ${a[1]}`],
  CommitmentSuperseded: [409, (a) => `commitment ${a[0]} has been replaced by a revision; act on the newer one`],
  AssociationExists: [409, (a) => `these two reports already have an active association (#${a[0]})`],
  AssociationNotPending: [409, () => "this association is no longer awaiting review"],
  SideAlreadyReviewed: [409, () => "this program has already reviewed the association"],
  DisputeExists: [409, (a) => `there is already an open dispute (#${a[0]}) about this`],
  DisputeOpen: [409, () => "a dispute about this report is still open"],
  InvalidTransition: [409, (a) => `cannot move from status ${a[0]} to ${a[1]}`],
  NotOpenForVoting: [409, () => "the dispute is not open for votes"],
  NotDecided: [409, () => "the dispute has not been decided yet"],
  AppealWindowClosed: [409, () => "the appeal window has closed"],
  AppealWindowOpen: [409, () => "the appeal window is still open"],
  RevealRequired: [409, () => "the report has not been revealed and verified yet"],
  SameProgram: [422, () => "both reports belong to the same program"],
  InvalidDecision: [422, () => "that decision is not available for this kind of dispute"],
  InvalidSubject: [422, () => "this dispute subject is not eligible"],
  InvalidOutcome: [422, () => "invalid outcome code"],
  EmptyDigest: [422, () => "a required digest was empty"],
  UnknownCommitment: [404, (a) => `no commitment #${a[0]}`],
  UnknownAssociation: [404, (a) => `no association #${a[0]}`],
  UnknownDispute: [404, (a) => `no dispute #${a[0]}`],
  UnknownProgram: [404, (a) => `no program #${a[0]}`],
  UnknownPolicy: [422, (a) => `program ${a[0]} has no policy version ${a[1]}`],
  ProgramInactive: [409, () => "program is not active"],
};

export function toLedgerError(e: unknown, rpcUrl: string, contract?: Contract): LedgerError {
  if (e instanceof LedgerError) return e;
  const err = e as any;
  const msg = String(err?.shortMessage ?? err?.message ?? e);
  if (/ECONNREFUSED|fetch failed|socket hang up/i.test(msg + String(err?.cause ?? "")) || err?.code === "ECONNREFUSED") {
    return new LedgerError(`The local blockchain at ${rpcUrl} is not responding. Start everything with ./run.sh.`, 503);
  }
  let revert: { name: string; args: unknown[] } | undefined = err?.revert;
  const data = err?.data ?? err?.info?.error?.data?.data ?? err?.info?.error?.data;
  if (!revert && contract && typeof data === "string" && data.length >= 10) {
    try {
      const parsed = contract.interface.parseError(data);
      if (parsed) revert = { name: parsed.name, args: [...parsed.args] };
    } catch {
      /* not one of ours */
    }
  }
  if (!revert) {
    const m = /custom error '(\w+)\((.*)\)'/.exec(msg + " " + String(err?.info?.error?.message ?? ""));
    if (m) revert = { name: m[1], args: m[2] ? m[2].split(",").map((s) => s.trim().replace(/^"|"$/g, "")) : [] };
  }
  if (revert) {
    const args = revert.args.map(String);
    const [status, text] = ERRORS[revert.name] ?? [422, () => revert!.name];
    return new LedgerError(`Rejected by the contract: ${text(args)}.`, status, { name: revert.name, args });
  }
  if (err?.code === "CALL_EXCEPTION") return new LedgerError(`Contract call reverted: ${msg}`, 422);
  return new LedgerError(`Blockchain error: ${msg}`, 502);
}

class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Sign locally, broadcast, wait, journal. Shared by the app, deployment and the benchmark. */
export class Sender {
  readonly provider: JsonRpcProvider;
  readonly journal?: Journal;
  private queue = new Queue();
  constructor(provider: JsonRpcProvider, journal?: Journal) {
    this.provider = provider;
    this.journal = journal;
  }

  send(wallet: Wallet, req: TransactionRequest): Promise<{ hash: string; blockNumber: number; timestamp: number; gasUsed: number; logs: any[]; contractAddress: string | null }> {
    return this.queue.run(async () => {
      const signer = wallet.connect(this.provider);
      const populated = await signer.populateTransaction(req);
      populated.gasLimit = (BigInt(populated.gasLimit ?? 0) * 12n) / 10n;
      const raw = await signer.signTransaction(populated);
      const hash: string = await this.provider.send("eth_sendRawTransaction", [raw]);
      let receipt = null;
      for (let i = 0; i < 600 && !receipt; i++) {
        receipt = await this.provider.getTransactionReceipt(hash);
        if (!receipt) await new Promise((r) => setTimeout(r, 20));
      }
      if (!receipt) throw new LedgerError(`timed out waiting for ${hash}`, 504);
      const block = await this.provider.getBlock(receipt.blockNumber);
      const timestamp = block?.timestamp ?? 0;
      this.journal?.append({ kind: "tx", raw, hash, block: receipt.blockNumber, timestamp });
      if (receipt.status !== 1) throw new LedgerError("transaction was mined but reverted", 422);
      return { hash, blockNumber: receipt.blockNumber, timestamp, gasUsed: Number(receipt.gasUsed), logs: [...receipt.logs], contractAddress: receipt.contractAddress };
    });
  }
}

export class Ledger {
  readonly provider: JsonRpcProvider;
  readonly contract: Contract;
  readonly address: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly keyring: Keyring;
  readonly sender: Sender;

  constructor(opts: { rpcUrl: string; address: string; keyring: Keyring; journal?: Journal; chainId?: number }) {
    this.rpcUrl = opts.rpcUrl;
    this.address = opts.address;
    this.chainId = opts.chainId ?? 31337;
    this.keyring = opts.keyring;
    this.provider = makeProvider(opts.rpcUrl, this.chainId);
    this.contract = new Contract(opts.address, loadArtifact().abi, this.provider);
    this.sender = new Sender(this.provider, opts.journal);
  }

  /** Call a state-changing contract function as a demo identity. */
  async send(identityId: string, method: string, args: unknown[]): Promise<TxResult> {
    try {
      const wallet = this.keyring.wallet(identityId);
      const req = await this.contract.getFunction(method).populateTransaction(...args);
      const r = await this.sender.send(wallet, { ...req, from: wallet.address });
      const events: LogDescription[] = [];
      for (const log of r.logs) {
        try {
          const ev = this.contract.interface.parseLog(log);
          if (ev) events.push(ev);
        } catch {
          /* not ours */
        }
      }
      return { hash: r.hash, blockNumber: r.blockNumber, timestamp: r.timestamp, gasUsed: r.gasUsed, events };
    } catch (e) {
      throw toLedgerError(e, this.rpcUrl, this.contract);
    }
  }

  async ping(): Promise<number> {
    try {
      const code = await this.provider.getCode(this.address);
      if (code === "0x") throw new LedgerError(`No VulnSeal contract at ${this.address}. Run ./run.sh to deploy or restore it.`, 503);
      return await this.provider.getBlockNumber();
    } catch (e) {
      throw toLedgerError(e, this.rpcUrl, this.contract);
    }
  }

  async read<T = any>(method: string, ...args: unknown[]): Promise<T> {
    try {
      return (await this.contract.getFunction(method).staticCall(...args)) as T;
    } catch (e) {
      throw toLedgerError(e, this.rpcUrl, this.contract);
    }
  }
}

export function eventArg(events: LogDescription[], name: string, arg: string): any {
  const ev = events.find((e) => e.name === name);
  if (!ev) throw new Error(`expected ${name} event`);
  return ev.args[arg];
}

/**
 * Deploy VulnSeal from the governor key, fund every demo identity from the faucet and
 * register participants. Programs are registered by the caller (they need policy digests).
 */
export async function deployVulnSeal(opts: {
  rpcUrl: string;
  keyring: Keyring;
  journal?: Journal;
  appealWindowSeconds?: number;
  threshold?: number;
}): Promise<{ address: string; gasUsed: number; blockNumber: number }> {
  const provider = makeProvider(opts.rpcUrl);
  const sender = new Sender(provider, opts.journal);
  const faucet = faucetWallet();
  for (const id of opts.keyring.ids()) {
    await sender.send(faucet, { to: opts.keyring.address(id), value: 100n * 10n ** 18n });
  }
  const { abi, bytecode } = loadArtifact();
  const factory = new ContractFactory(abi, bytecode);
  const deployTx = await factory.getDeployTransaction(opts.appealWindowSeconds ?? 7 * 24 * 3600, opts.threshold ?? 2);
  const governor = opts.keyring.wallet("governor");
  const r = await sender.send(governor, { ...deployTx, from: governor.address });
  provider.destroy();
  return { address: r.contractAddress!, gasUsed: r.gasUsed, blockNumber: r.blockNumber };
}

export async function registerParticipants(ledger: Ledger) {
  for (const d of IDENTITY_DEFS) {
    if (d.kind === "governor" || d.kind === "outsider") continue;
    if (d.kind === "researcher") await ledger.send(d.id, "registerResearcher", []);
    else await ledger.send("governor", "registerParticipant", [ledger.keyring.address(d.id), roleMask(d.roles), d.programId]);
  }
}
