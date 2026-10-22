// Ethers client for the deployed PatchLedger contract.
// Demo identities sign locally with keys derived from the public Hardhat test
// mnemonic. The server never pre-checks roles: authorization is enforced by the
// contract, and reverts are surfaced to the caller as LedgerError.
import fs from "node:fs";
import path from "node:path";
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  Mnemonic,
  Network,
  Wallet,
  type InterfaceAbi,
  type TransactionReceipt,
} from "ethers";
import { HARDHAT_TEST_MNEMONIC, IDENTITIES, ROLE, type Identity } from "./domain.ts";
import { NO_REF } from "./ledger-hash.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
export const ARTIFACT_PATH = path.join(ROOT, "build/artifacts/contracts/PatchLedger.sol/PatchLedger.json");

export function loadArtifact(): { abi: InterfaceAbi; bytecode: string } {
  if (!fs.existsSync(ARTIFACT_PATH)) throw new Error(`Contract artifact missing at ${ARTIFACT_PATH}. Run: npm run compile`);
  return JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));
}

export interface OnChainRecord {
  seq: number;
  recordHash: string;
  prevHash: string;
  payloadDigest: string;
  actor: string;
  timestamp: number;
  recordType: number;
  outcome: number;
  refSeq: number;
}

export interface WriteResult {
  seq: number;
  recordHash: string;
  prevHash: string;
  txHash: string;
  blockNumber: number;
  gasUsed: number;
  timestamp: number;
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

const ROLE_NAMES = Object.entries(ROLE) as [string, number][];
export const roleMaskNames = (mask: number) => ROLE_NAMES.filter(([, v]) => (mask & v) !== 0).map(([k]) => k);

const ERROR_STATUS: Record<string, number> = {
  NotAuthorized: 403,
  NotAdmin: 403,
  NotOriginalActor: 403,
  SelfResolution: 403,
  SelfChallenge: 403,
  SelfCorroboration: 403,
  ConflictOfInterest: 403,
  StalePrevHash: 409,
  DisputeAlreadyOpen: 409,
  DeviceAlreadyRegistered: 409,
  AlreadySuperseded: 409,
  DisputeNotOpen: 409,
};

const ERROR_TEXT: Record<string, (a: string[]) => string> = {
  NotAuthorized: (a) => `account ${a[0]} does not hold a required role (${roleMaskNames(Number(a[1])).join(" or ")})`,
  StalePrevHash: (a) => `expected previous record ${a[0].slice(0, 12)}… but the current head is ${a[1].slice(0, 12)}… — the history changed or the predecessor is invalid`,
  SelfResolution: () => "the author of a disputed claim cannot resolve the dispute about it",
  ConflictOfInterest: () => "the challenger cannot resolve their own challenge",
  SelfChallenge: () => "an actor cannot challenge their own claim",
  SelfCorroboration: () => "an actor cannot corroborate their own claim",
  NotOriginalActor: () => "only the original author (or an auditor) may correct or add evidence to this record",
  DisputeAlreadyOpen: (a) => `record #${a[0]} already has an open challenge (#${a[1]})`,
  DisputeNotOpen: (a) => `challenge #${a[0]} is already resolved`,
  DeviceAlreadyRegistered: () => "this device key is already registered",
  AlreadySuperseded: (a) => `record #${a[0]} was already superseded by correction #${a[1]}; correct the correction instead`,
  InvalidReference: (a) => `record #${a[0]} cannot be referenced by this record type`,
  UnknownDevice: () => "device is not registered on-chain",
};

/** Simple promise queue: transactions are sent one at a time so nonces stay ordered. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function walletFor(identity: Identity, provider?: JsonRpcProvider): Wallet {
  const m = Mnemonic.fromPhrase(HARDHAT_TEST_MNEMONIC);
  const hd = HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${identity.index}`);
  return new Wallet(hd.privateKey, provider);
}

export function makeProvider(rpcUrl: string, chainId = 31337): JsonRpcProvider {
  const network = Network.from(chainId);
  const provider = new JsonRpcProvider(rpcUrl, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
  provider.pollingInterval = 100;
  return provider;
}

export class Ledger {
  readonly provider: JsonRpcProvider;
  readonly contract: Contract;
  readonly address: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  private wallets = new Map<string, Wallet>();
  private mutex = new Mutex();

  constructor(rpcUrl: string, address: string, chainId = 31337) {
    const { abi } = loadArtifact();
    this.rpcUrl = rpcUrl;
    this.chainId = chainId;
    this.address = address;
    this.provider = makeProvider(rpcUrl, chainId);
    this.contract = new Contract(address, abi, this.provider);
    for (const id of IDENTITIES) this.wallets.set(id.id, walletFor(id, this.provider));
  }

  addressOf(identityId: string): string {
    const w = this.wallets.get(identityId);
    if (!w) throw new LedgerError(`unknown demo identity "${identityId}"`, 400);
    return w.address;
  }

  /** Throws a helpful LedgerError if the RPC is down or no contract is deployed at the address. */
  async ping(): Promise<{ blockNumber: number }> {
    try {
      const code = await this.provider.getCode(this.address);
      if (code === "0x") throw new LedgerError(`No PatchLedger contract at ${this.address} on ${this.rpcUrl}. Re-run deployment.`, 503);
      return { blockNumber: await this.provider.getBlockNumber() };
    } catch (e) {
      throw toLedgerError(e, this.rpcUrl);
    }
  }

  async registerDevice(identityId: string, deviceKey: string, digest: string): Promise<WriteResult> {
    return this.write(identityId, (c) => c.registerDevice(deviceKey, digest));
  }

  async appendRecord(
    identityId: string,
    a: { deviceKey: string; recordType: number; expectedPrevHash?: string; payloadDigest: string; refSeq?: number; outcome?: number },
  ): Promise<WriteResult> {
    // When the caller did not pin a predecessor, read the head inside the write lock.
    return this.write(identityId, async (c) =>
      c.appendRecord(
        a.deviceKey,
        a.recordType,
        a.expectedPrevHash ?? (await this.headHash(a.deviceKey)),
        a.payloadDigest,
        a.refSeq ?? NO_REF,
        a.outcome ?? 0,
      ),
    );
  }

  /** Low-level escape hatch used by the tamper lab to send arbitrary (expected-to-fail) calls. */
  async rawWrite(identityId: string, fn: (c: Contract) => Promise<unknown>): Promise<WriteResult> {
    return this.write(identityId, fn);
  }

  private async write(identityId: string, fn: (c: Contract) => Promise<unknown>): Promise<WriteResult> {
    const wallet = this.wallets.get(identityId);
    if (!wallet) throw new LedgerError(`unknown demo identity "${identityId}"`, 400);
    return this.mutex.run(async () => {
      try {
        const c = this.contract.connect(wallet) as Contract;
        const tx = (await fn(c)) as { hash: string };
        const receipt = await this.waitReceipt(tx.hash);
        if (receipt.status !== 1) throw new LedgerError("transaction reverted on-chain", 422);
        let ev: { seq: number; recordHash: string; prevHash: string } | undefined;
        for (const log of receipt.logs) {
          try {
            const parsed = this.contract.interface.parseLog(log);
            if (parsed?.name === "RecordAppended") {
              ev = { seq: Number(parsed.args.seq), recordHash: parsed.args.recordHash, prevHash: parsed.args.prevHash };
            }
          } catch {
            /* not ours */
          }
        }
        const block = await this.provider.getBlock(receipt.blockNumber);
        return {
          seq: ev?.seq ?? -1,
          recordHash: ev?.recordHash ?? "",
          prevHash: ev?.prevHash ?? "",
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: Number(receipt.gasUsed),
          timestamp: block?.timestamp ?? 0,
        };
      } catch (e) {
        throw toLedgerError(e, this.rpcUrl, this.contract);
      }
    });
  }

  private async waitReceipt(hash: string): Promise<TransactionReceipt> {
    // Poll directly: the local chain automines, so the receipt is normally ready at once.
    for (let i = 0; i < 600; i++) {
      const r = await this.provider.getTransactionReceipt(hash);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new LedgerError(`timed out waiting for transaction ${hash}`, 504);
  }

  async getRecords(deviceKey: string): Promise<OnChainRecord[]> {
    try {
      const raw = (await this.contract.getRecords(deviceKey)) as unknown[];
      return raw.map((r: any, i) => ({
        seq: i,
        recordHash: r.recordHash,
        prevHash: r.prevHash,
        payloadDigest: r.payloadDigest,
        actor: r.actor,
        timestamp: Number(r.timestamp),
        recordType: Number(r.recordType),
        outcome: Number(r.outcome),
        refSeq: Number(r.refSeq),
      }));
    } catch (e) {
      throw toLedgerError(e, this.rpcUrl, this.contract);
    }
  }

  async headHash(deviceKey: string): Promise<string> {
    return (await this.contract.headHash(deviceKey)) as string;
  }

  async verifyChain(deviceKey: string): Promise<{ ok: boolean; firstBadSeq: number }> {
    const [ok, bad] = await this.contract.verifyChain(deviceKey);
    return { ok: Boolean(ok), firstBadSeq: Number(bad) };
  }

  async roleMask(address: string): Promise<number> {
    return Number(await this.contract.roles(address));
  }

  async stats(): Promise<{ devices: number; records: number; openDisputes: number; blockNumber: number }> {
    const [d, r, o, b] = await Promise.all([
      this.contract.deviceCount(),
      this.contract.totalRecords(),
      this.contract.totalOpenDisputes(),
      this.provider.getBlockNumber(),
    ]);
    return { devices: Number(d), records: Number(r), openDisputes: Number(o), blockNumber: b };
  }

  /** Names of every state-changing function in the deployed ABI (used to show there is no edit/delete). */
  mutatingFunctions(): string[] {
    const out: string[] = [];
    this.contract.interface.forEachFunction((f) => {
      if (f.stateMutability !== "view" && f.stateMutability !== "pure") out.push(f.format("sighash"));
    });
    return out;
  }
}

export function toLedgerError(e: unknown, rpcUrl: string, contract?: Contract): LedgerError {
  if (e instanceof LedgerError) return e;
  const err = e as any;
  const code = err?.code ?? err?.error?.code;
  const msg = String(err?.shortMessage ?? err?.message ?? e);
  if (code === "ECONNREFUSED" || /ECONNREFUSED|fetch failed|socket hang up|connect ECONN/i.test(msg + String(err?.cause ?? ""))) {
    return new LedgerError(`Local blockchain unavailable at ${rpcUrl}. Is the Hardhat node running? (start everything with ./run.sh)`, 503);
  }
  let revert = err?.revert as { name: string; args: unknown[] } | undefined;
  if (!revert && contract && err?.data) {
    try {
      const parsed = contract.interface.parseError(err.data);
      if (parsed) revert = { name: parsed.name, args: [...parsed.args] };
    } catch {
      /* ignore */
    }
  }
  if (revert) {
    const args = revert.args.map((a) => String(a));
    const text = ERROR_TEXT[revert.name]?.(args) ?? revert.name;
    return new LedgerError(`Contract rejected the transaction: ${text}`, ERROR_STATUS[revert.name] ?? 422, { name: revert.name, args });
  }
  if (code === "CALL_EXCEPTION") return new LedgerError(`Contract call reverted: ${msg}`, 422);
  return new LedgerError(`Blockchain error: ${msg}`, 502);
}

/** Deploy PatchLedger with the registrar identity and grant every demo role. */
export async function deployPatchLedger(rpcUrl: string, chainId = 31337): Promise<{ address: string; blockNumber: number; gasUsed: number }> {
  const provider = makeProvider(rpcUrl, chainId);
  const { abi, bytecode } = loadArtifact();
  const admin = walletFor(IDENTITIES[0], provider);
  const factory = new ContractFactory(abi, bytecode, admin);
  const deployed = await factory.deploy();
  const deployTx = deployed.deploymentTransaction()!;
  const receipt = await provider.getTransactionReceipt(deployTx.hash) ?? (await deployTx.wait())!;
  const address = await deployed.getAddress();
  const c = new Contract(address, abi, admin);
  for (const id of IDENTITIES) {
    for (const r of id.roles) {
      if (id.index === 0 && r === "REGISTRAR") continue; // granted in constructor
      const w = walletFor(id);
      const tx = await c.grantRole(w.address, ROLE[r]);
      await tx.wait(1, 30_000);
    }
  }
  provider.destroy();
  return { address, blockNumber: receipt.blockNumber, gasUsed: Number(receipt.gasUsed) };
}
