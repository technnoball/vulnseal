// Contract-level tests against a real local Hardhat node.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Contract, keccak256, toUtf8Bytes, hexlify, randomBytes } from "ethers";
import { startChain, type ChainProcess } from "../../scripts/lib/chainproc.ts";
import { deployPatchLedger, loadArtifact, makeProvider, walletFor } from "../../server/chain.ts";
import { IDENTITIES, ROLE, typeCode } from "../../server/domain.ts";
import { computeRecordHash, deviceKeyFor, NO_REF, ZERO_HASH } from "../../server/ledger-hash.ts";
import { expectRevert } from "../helpers.ts";

const id = (k: string) => IDENTITIES.find((i) => i.id === k)!;
const digest = (s: string) => keccak256(toUtf8Bytes(s));
const T = {
  DIAG: typeCode("DIAGNOSTIC"),
  REPAIR: typeCode("REPAIR"),
  COMP: typeCode("COMPONENT_REPLACEMENT"),
  INSP: typeCode("INSPECTION"),
  CUSTODY: typeCode("CUSTODY_TRANSFER"),
  EVID: typeCode("EVIDENCE_ATTACHMENT"),
  CORROB: typeCode("CORROBORATION"),
  CHAL: typeCode("CHALLENGE"),
  RES: typeCode("RESOLUTION"),
  CORR: typeCode("CORRECTION"),
};

let chain: ChainProcess;
let c: Record<string, Contract>; // contract connected as each identity
let base: Contract;
let chainId: bigint;

describe("PatchLedger contract", () => {
  before(async () => {
    chain = await startChain();
    const { address } = await deployPatchLedger(chain.url);
    const provider = makeProvider(chain.url);
    chainId = (await provider.getNetwork()).chainId;
    const { abi } = loadArtifact();
    base = new Contract(address, abi, provider);
    c = {};
    for (const i of IDENTITIES) c[i.id] = base.connect(walletFor(i, provider)) as Contract;
  });
  after(async () => {
    await chain?.stop();
  });

  const head = (key: string) => base.headHash(key) as Promise<string>;
  async function register(label: string) {
    const key = deviceKeyFor(label + hexlify(randomBytes(4)));
    await (await c.registrar.registerDevice(key, digest("reg:" + label))).wait();
    return key;
  }
  async function append(who: string, key: string, type: number, ref = NO_REF, outcome = 0, payload = "p") {
    const tx = await c[who].appendRecord(key, type, await head(key), digest(payload + Math.random()), ref, outcome);
    await tx.wait();
    return Number(await base.recordCount(key)) - 1;
  }

  it("lets the registrar register a device and commits a verifiable record", async () => {
    const key = deviceKeyFor("PL-TEST-0001");
    const before = Number(await base.deviceCount());
    await (await c.registrar.registerDevice(key, digest("registration"))).wait();
    assert.equal(Number(await base.deviceCount()), before + 1);
    const r = await base.getRecord(key, 0);
    assert.equal(r.prevHash, ZERO_HASH);
    assert.equal(r.actor, walletFor(id("registrar")).address);
    assert.equal(Number(r.recordType), 0);
    const recomputed = computeRecordHash(chainId, await base.getAddress(), key, {
      seq: 0, recordType: 0, prevHash: r.prevHash, payloadDigest: r.payloadDigest, actor: r.actor,
      timestamp: Number(r.timestamp), refSeq: Number(r.refSeq), outcome: Number(r.outcome),
    });
    assert.equal(recomputed, r.recordHash, "off-chain hash re-implementation must match the contract");
  });

  it("rejects registration by unauthorized accounts, duplicates and invalid input", async () => {
    const key = deviceKeyFor("PL-TEST-0002");
    await expectRevert(c["repairer-a"].registerDevice(key, digest("x")), "NotAuthorized", base);
    await expectRevert(c.outsider.registerDevice(key, digest("x")), "NotAuthorized", base);
    await expectRevert(c.auditor.registerDevice(key, digest("x")), "NotAuthorized", base);
    await expectRevert(c.registrar.registerDevice(ZERO_HASH, digest("x")), "InvalidDeviceKey", base);
    await expectRevert(c.registrar.registerDevice(key, ZERO_HASH), "EmptyPayloadDigest", base);
    await (await c.registrar.registerDevice(key, digest("x"))).wait();
    await expectRevert(c.registrar.registerDevice(key, digest("y")), "DeviceAlreadyRegistered", base);
  });

  it("lets an authorized repairer append a repair that links to the previous head", async () => {
    const key = await register("repair");
    const h0 = await head(key);
    const seq = await append("repairer-a", key, T.REPAIR);
    assert.equal(seq, 1);
    const r = await base.getRecord(key, 1);
    assert.equal(r.prevHash, h0);
    assert.equal(r.actor, walletFor(id("repairer-a")).address);
  });

  it("rejects unauthorized writes for every protected record type", async () => {
    const key = await register("unauth");
    const h = await head(key);
    await expectRevert(c.outsider.appendRecord(key, T.REPAIR, h, digest("a"), NO_REF, 0), "NotAuthorized", base);
    await expectRevert(c.buyer.appendRecord(key, T.REPAIR, h, digest("a"), NO_REF, 0), "NotAuthorized", base);
    await expectRevert(c.auditor.appendRecord(key, T.COMP, h, digest("a"), NO_REF, 0), "NotAuthorized", base);
    await expectRevert(c["repairer-a"].appendRecord(key, T.INSP, h, digest("a"), NO_REF, 0), "NotAuthorized", base);
    await expectRevert(c.buyer.appendRecord(key, T.CUSTODY, h, digest("a"), NO_REF, 0), "NotAuthorized", base);
    await expectRevert(c.outsider.appendRecord(key, T.CHAL, h, digest("a"), 0, 0), "NotAuthorized", base);
    await expectRevert(c["repairer-a"].grantRole(walletFor(id("outsider")).address, ROLE.AUDITOR), "NotAdmin", base);
    await expectRevert(c.registrar.appendRecord(key, 0, h, digest("a"), NO_REF, 0), "InvalidRecordType", base);
    await expectRevert(c.registrar.appendRecord(key, 42, h, digest("a"), NO_REF, 0), "InvalidRecordType", base);
    assert.equal(Number(await base.recordCount(key)), 1, "no rejected write may change the history");
  });

  it("rejects an invalid or stale preceding-record hash", async () => {
    const key = await register("prev");
    const h0 = await head(key);
    await append("repairer-a", key, T.DIAG);
    // building on the old head (an attempt to fork/overwrite history) fails
    await expectRevert(c["repairer-a"].appendRecord(key, T.REPAIR, h0, digest("fork"), NO_REF, 0), "StalePrevHash", base);
    await expectRevert(c["repairer-a"].appendRecord(key, T.REPAIR, digest("random"), digest("x"), NO_REF, 0), "StalePrevHash", base);
    await expectRevert(c["repairer-a"].appendRecord(deviceKeyFor("nope"), T.REPAIR, ZERO_HASH, digest("x"), NO_REF, 0), "UnknownDevice", base);
  });

  it("validates references for record types", async () => {
    const key = await register("refs");
    const h = await head(key);
    await expectRevert(c["repairer-a"].appendRecord(key, T.REPAIR, h, digest("x"), 0, 0), "ReferenceNotAllowed", base);
    await expectRevert(c.buyer.appendRecord(key, T.CHAL, h, digest("x"), NO_REF, 0), "ReferenceRequired", base);
    await expectRevert(c.buyer.appendRecord(key, T.CHAL, h, digest("x"), 9, 0), "InvalidReference", base);
    await expectRevert(c["repairer-a"].appendRecord(key, T.REPAIR, h, digest("x"), NO_REF, 1), "InvalidOutcome", base);
  });

  it("preserves older records when a correction is appended", async () => {
    const key = await register("corr");
    const s1 = await append("repairer-a", key, T.DIAG);
    const original = await base.getRecord(key, s1);
    // another repairer cannot correct someone else's claim
    await expectRevert(
      c["repairer-b"].appendRecord(key, T.CORR, await head(key), digest("c"), s1, 0), "NotOriginalActor", base);
    const s2 = await append("repairer-a", key, T.CORR, s1);
    const after = await base.getRecord(key, s1);
    assert.deepEqual([...after], [...original], "the corrected record must be unchanged");
    const [, supersededBy] = await base.recordState(key, s1);
    assert.equal(Number(supersededBy), s2);
    assert.equal(Number((await base.getRecord(key, s2)).refSeq), s1);
    await expectRevert(c["repairer-a"].appendRecord(key, T.CORR, await head(key), digest("c2"), s1, 0), "AlreadySuperseded", base);
    // the correction itself can be corrected (by an auditor here)
    await append("auditor", key, T.CORR, s2);
    assert.equal(Number(await base.recordCount(key)), 4);
  });

  it("enforces corroboration and evidence-attachment independence rules", async () => {
    const key = await register("corrob");
    const s1 = await append("repairer-a", key, T.COMP);
    await expectRevert(c["repairer-a"].appendRecord(key, T.CORROB, await head(key), digest("x"), s1, 0), "NotAuthorized", base);
    await expectRevert(c["repairer-b"].appendRecord(key, T.EVID, await head(key), digest("x"), s1, 0), "NotOriginalActor", base);
    await append("repairer-a", key, T.EVID, s1);
    await append("inspector", key, T.CORROB, s1);
    const s4 = await append("inspector", key, T.INSP);
    await expectRevert(c.inspector.appendRecord(key, T.CORROB, await head(key), digest("x"), s4, 0), "SelfCorroboration", base);
  });

  it("handles disputes: no self-challenge, no duplicate, no self-resolution, auditor-only resolution", async () => {
    const key = await register("dispute");
    const claim = await append("repairer-a", key, T.COMP);
    await expectRevert(c["repairer-a"].appendRecord(key, T.CHAL, await head(key), digest("x"), claim, 0), "SelfChallenge", base);
    const chal = await append("buyer", key, T.CHAL, claim);
    assert.equal(Number(await base.openDisputeCount(key)), 1);
    const [openSeq] = await base.recordState(key, claim);
    assert.equal(Number(openSeq), chal);
    await expectRevert(c["repairer-b"].appendRecord(key, T.CHAL, await head(key), digest("x"), claim, 0), "DisputeAlreadyOpen", base);
    // challenge/resolution records cannot themselves be challenged
    await expectRevert(c["repairer-b"].appendRecord(key, T.CHAL, await head(key), digest("x"), chal, 0), "InvalidReference", base);

    // unauthorized resolution attempts
    await expectRevert(c.buyer.appendRecord(key, T.RES, await head(key), digest("r"), chal, 2), "NotAuthorized", base);
    await expectRevert(c["repairer-a"].appendRecord(key, T.RES, await head(key), digest("r"), chal, 1), "NotAuthorized", base);
    await expectRevert(c.outsider.appendRecord(key, T.RES, await head(key), digest("r"), chal, 1), "NotAuthorized", base);

    // a repairer who is ALSO granted the auditor role still cannot resolve a dispute about their own claim
    const repA = walletFor(id("repairer-a")).address;
    await (await c.registrar.grantRole(repA, ROLE.AUDITOR)).wait();
    await expectRevert(c["repairer-a"].appendRecord(key, T.RES, await head(key), digest("r"), chal, 1), "SelfResolution", base);
    await (await c.registrar.revokeRole(repA, ROLE.AUDITOR)).wait();

    // an auditor who raised the challenge cannot resolve it either
    const aud = walletFor(id("auditor")).address;
    await (await c.registrar.grantRole(aud, ROLE.VERIFIER)).wait();
    const claim2 = await append("repairer-b", key, T.REPAIR);
    const chal2 = await append("auditor", key, T.CHAL, claim2);
    await expectRevert(c.auditor.appendRecord(key, T.RES, await head(key), digest("r"), chal2, 1), "ConflictOfInterest", base);
    await (await c.registrar.revokeRole(aud, ROLE.VERIFIER)).wait();

    // authorized resolution
    await expectRevert(c.auditor.appendRecord(key, T.RES, await head(key), digest("r"), chal, 0), "InvalidOutcome", base);
    await expectRevert(c.auditor.appendRecord(key, T.RES, await head(key), digest("r"), claim, 1), "InvalidReference", base);
    const claimBefore = await base.getRecord(key, claim);
    const chalBefore = await base.getRecord(key, chal);
    const res = await append("auditor", key, T.RES, chal, 2);
    assert.equal(Number(await base.openDisputeCount(key)), 1, "only the second dispute remains open");
    const [, , resolved] = await base.recordState(key, chal);
    assert.equal(resolved, true);
    assert.deepEqual([...(await base.getRecord(key, claim))], [...claimBefore], "disputed claim must remain");
    assert.deepEqual([...(await base.getRecord(key, chal))], [...chalBefore], "challenge must remain");
    assert.equal(Number((await base.getRecord(key, res)).outcome), 2);
    await expectRevert(c.auditor.appendRecord(key, T.RES, await head(key), digest("r"), chal, 1), "DisputeNotOpen", base);
    // a fresh challenge on the same claim is possible after resolution
    await append("repairer-b", key, T.CHAL, claim);
  });

  it("keeps sequence numbers, links and chronology verifiable", async () => {
    const key = await register("seq");
    for (const [who, t] of [["repairer-a", T.DIAG], ["repairer-a", T.REPAIR], ["inspector", T.INSP], ["registrar", T.CUSTODY]] as const) {
      await append(who, key, t);
    }
    const recs = await base.getRecords(key);
    assert.equal(recs.length, 5);
    const addr = await base.getAddress();
    let prev = ZERO_HASH;
    let lastTs = 0;
    recs.forEach((r: any, i: number) => {
      assert.equal(r.prevHash, prev, `record ${i} links to its predecessor`);
      assert.ok(Number(r.timestamp) >= lastTs);
      const h = computeRecordHash(chainId, addr, key, {
        seq: i, recordType: Number(r.recordType), prevHash: r.prevHash, payloadDigest: r.payloadDigest,
        actor: r.actor, timestamp: Number(r.timestamp), refSeq: Number(r.refSeq), outcome: Number(r.outcome),
      });
      assert.equal(h, r.recordHash);
      prev = r.recordHash;
      lastTs = Number(r.timestamp);
    });
    const [ok, bad] = await base.verifyChain(key);
    assert.equal(ok, true);
    assert.equal(Number(bad), NO_REF);
    assert.equal(await base.headHash(key), prev);
  });

  it("exposes no function that can edit or delete a record", () => {
    const mutating: string[] = [];
    base.interface.forEachFunction((f) => {
      if (f.stateMutability !== "view" && f.stateMutability !== "pure") mutating.push(f.name);
    });
    assert.deepEqual(mutating.sort(), ["appendRecord", "grantRole", "registerDevice", "revokeRole", "transferAdmin"]);
  });
});
