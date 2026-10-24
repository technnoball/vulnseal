// Contract tests against a real local Hardhat node (fresh deployment per suite).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toUtf8Bytes, ZeroHash } from "ethers";
import { anchor, freshDeployment, reveal, sampleReport, type Deployment } from "../fixture.ts";
import { computeCommitment, fieldsDigest, logEntryHash, newNonce, revealDigest } from "../../server/commitment.ts";
import { ASSOC_STATUS, DECISION, DISPUTE_KIND, REVEAL, ROLE, ST } from "../../server/domain.ts";
import { expectRevert } from "../helpers.ts";

let d: Deployment;
const digest = (s: string) => keccak256(toUtf8Bytes(s));
const send = (who: string, fn: string, args: unknown[]) => d.ledger.send(who, fn, args);
const read = <T = any,>(fn: string, ...args: unknown[]) => d.ledger.read<T>(fn, ...args);

describe("VulnSeal contract", () => {
  before(async () => {
    d = await freshDeployment(3600);
  });
  after(async () => {
    await d?.stop();
  });

  describe("registration and roles", () => {
    it("only the governor registers programs and participants", async () => {
      await expectRevert(send("ashgrove-admin", "registerProgram", [digest("x"), digest("p")]), "NotGovernor");
      await expectRevert(send("basalt", "registerParticipant", [d.keyring.address("outsider"), ROLE.ARBITRATOR, 0]), "NotGovernor");
      const p = await read("participants", d.keyring.address("arb-reyes"));
      assert.equal(Number(p.roles), ROLE.ARBITRATOR);
      assert.equal(Number(p.programId), 1, "Reyes is affiliated with program 1");
    });

    it("anchors an authorized commitment and rejects unregistered or non-researcher accounts", async () => {
      const a = await anchor(d.ledger, "basalt", 1);
      const c = await read("getCommitment", a.cid);
      assert.equal(c.commitment, a.commitment);
      assert.equal(c.researcher, d.keyring.address("basalt"));
      assert.equal(Number(c.status), ST.ANCHORED);
      await expectRevert(send("outsider", "anchorCommitment", [digest("o"), 1, 1]), "NotAuthorized");
      await expectRevert(send("ashgrove-admin", "anchorCommitment", [digest("o"), 1, 1]), "NotAuthorized");
      await expectRevert(send("basalt", "anchorCommitment", [ZeroHash, 1, 1]), "EmptyDigest");
      await expectRevert(send("basalt", "anchorCommitment", [digest("o"), 9, 1]), "UnknownProgram");
      await expectRevert(send("basalt", "anchorCommitment", [digest("o"), 1, 5]), "UnknownPolicy");
    });

    it("binds commitments to the current policy version", async () => {
      await send("tamarind-admin", "publishPolicy", [3, digest("tamarind policy v2")]);
      await expectRevert(send("nightjar", "anchorCommitment", [digest("stale"), 3, 1]), "StalePolicy");
      await expectRevert(send("ashgrove-admin", "publishPolicy", [3, digest("x")]), "WrongProgram");
      const c = await anchor(d.ledger, "nightjar", 3, sampleReport(), 2);
      assert.equal(Number((await read("getCommitment", c.cid)).policyVersion), 2);
    });
  });

  describe("commitments and reveals", () => {
    it("verifies a matching opening and rejects altered content or a wrong nonce", async () => {
      const a = await anchor(d.ledger, "basalt", 1);
      assert.equal(await read("verifyOpening", a.cid, a.digest, a.nonce), true);
      const altered = fieldsDigest({ ...a.report, impact: a.report.impact + " (edited later)" });
      assert.equal(await read("verifyOpening", a.cid, altered, a.nonce), false);
      assert.equal(await read("verifyOpening", a.cid, a.digest, newNonce()), false);
      // the Solidity and TypeScript constructions agree
      const ctx = { chainId: d.ledger.chainId, contract: d.ledger.address, researcher: d.keyring.address("basalt"), programId: 1, policyVersion: 1 };
      assert.equal(await read("computeCommitment", ctx.researcher, 1, 1, a.digest, a.nonce), computeCommitment(ctx, a.digest, a.nonce));
    });

    it("rejects a replayed commitment, and a copied commitment cannot be opened by the copier", async () => {
      const a = await anchor(d.ledger, "basalt", 1);
      await expectRevert(send("basalt", "anchorCommitment", [a.commitment, 1, 1]), "ReplayedCommitment");
      const copy = await send("quillfox", "anchorCommitment", [a.commitment, 1, 1]);
      const copyCid = Number(copy.events.find((e) => e.name === "CommitmentAnchored")!.args.cid);
      assert.equal(await read("verifyOpening", copyCid, a.digest, a.nonce), false, "the researcher address is inside the commitment");
      assert.equal(await read("verifyOpening", a.cid, a.digest, a.nonce), true);
    });

    it("records reveal checks append-only: mismatches are counted and kept, a later match is accepted", async () => {
      const a = await anchor(d.ledger, "quillfox", 2);
      await expectRevert(send("kestrel-triage", "recordReveal", [a.cid, REVEAL.MATCH, revealDigest(a.cid, a.digest, a.nonce)]), "InvalidTransition");
      await send("kestrel-triage", "acknowledge", [a.cid]);
      await send("kestrel-triage", "requestReveal", [a.cid]);
      await expectRevert(send("ashgrove-triage", "recordReveal", [a.cid, REVEAL.MATCH, revealDigest(a.cid, a.digest, a.nonce)]), "WrongProgram");
      await expectRevert(send("kestrel-triage", "recordReveal", [a.cid, 9, ZeroHash]), "InvalidOutcome");
      await send("kestrel-triage", "recordReveal", [a.cid, REVEAL.MISMATCH, revealDigest(a.cid, digest("tampered"), a.nonce)]);
      let c = await read("getCommitment", a.cid);
      assert.equal(Number(c.status), ST.REVEAL_REQUESTED);
      assert.equal(Number(c.mismatches), 1);
      await send("kestrel-triage", "recordReveal", [a.cid, REVEAL.MATCH, revealDigest(a.cid, a.digest, a.nonce)]);
      c = await read("getCommitment", a.cid);
      assert.equal(Number(c.status), ST.REVEALED);
      assert.equal(Number(c.mismatches), 1, "the earlier mismatch is not erased");
      await expectRevert(send("kestrel-triage", "recordReveal", [a.cid, REVEAL.MATCH, revealDigest(a.cid, a.digest, a.nonce)]), "InvalidTransition");
    });

    it("prevents a reviewer from checking their own submission", async () => {
      // a Kestrel reviewer who also self-registers as a researcher
      await send("kestrel-triage", "registerResearcher", []);
      const own = await anchor(d.ledger, "kestrel-triage", 2);
      await send("kestrel-admin", "acknowledge", [own.cid]);
      await send("kestrel-admin", "requestReveal", [own.cid]);
      await expectRevert(send("kestrel-triage", "recordReveal", [own.cid, REVEAL.MATCH, revealDigest(own.cid, own.digest, own.nonce)]), "SelfReview");
    });

    it("preserves the original when a report is revised", async () => {
      const a = await anchor(d.ledger, "basalt", 1);
      const before = await read("getCommitment", a.cid);
      const revised = computeCommitment(
        { chainId: d.ledger.chainId, contract: d.ledger.address, researcher: d.keyring.address("basalt"), programId: 1, policyVersion: 1 },
        fieldsDigest(sampleReport({ title: "revised" })),
        newNonce(),
      );
      await expectRevert(send("quillfox", "reviseCommitment", [a.cid, revised, 1]), "NotCommitmentOwner");
      const tx = await send("basalt", "reviseCommitment", [a.cid, revised, 1]);
      const newCid = Number(tx.events.find((e) => e.name === "CommitmentAnchored")!.args.cid);
      const old = await read("getCommitment", a.cid);
      assert.equal(old.commitment, before.commitment);
      assert.equal(old.anchoredAt, before.anchoredAt);
      assert.equal(Number(old.supersededBy), newCid);
      assert.equal(Number((await read("getCommitment", newCid)).supersedes), a.cid);
      assert.equal(await read("verifyOpening", a.cid, a.digest, a.nonce), true, "the original can still be opened");
      await expectRevert(send("basalt", "reviseCommitment", [a.cid, digest("again"), 1]), "AlreadySuperseded");
      await expectRevert(send("ashgrove-triage", "acknowledge", [a.cid]), "CommitmentSuperseded");
    });
  });

  describe("triage state machine", () => {
    it("allows only documented transitions by the right program's staff", async () => {
      const a = await anchor(d.ledger, "nightjar", 1);
      await expectRevert(send("kestrel-triage", "acknowledge", [a.cid]), "WrongProgram");
      await expectRevert(send("nightjar", "acknowledge", [a.cid]), "NotAuthorized");
      await expectRevert(send("ashgrove-triage", "requestReveal", [a.cid]), "InvalidTransition");
      await reveal(d.ledger, a, "ashgrove-triage");
      await expectRevert(send("ashgrove-triage", "setTriage", [a.cid, ST.VALID, digest("n")]), "InvalidTransition");
      await send("ashgrove-triage", "setTriage", [a.cid, ST.PENDING_TRIAGE, digest("n")]);
      await send("ashgrove-triage", "setTriage", [a.cid, ST.NEEDS_INFO, digest("n")]);
      await send("ashgrove-triage", "setTriage", [a.cid, ST.VALID, digest("n")]);
      await expectRevert(send("ashgrove-triage", "setTriage", [a.cid, ST.INVALID, digest("n")]), "InvalidTransition");
      await expectRevert(send("ashgrove-triage", "finalizeReport", [a.cid, digest("f")]), "NotAuthorized");
      await send("ashgrove-admin", "finalizeReport", [a.cid, digest("f")]);
      assert.equal(Number((await read("getCommitment", a.cid)).status), ST.FINALIZED);
      await expectRevert(send("ashgrove-admin", "setTriage", [a.cid, ST.PENDING_TRIAGE, digest("n")]), "InvalidTransition");
    });

    it("lets the owner or program admin grant disclosure only after reveal", async () => {
      const a = await anchor(d.ledger, "basalt", 1);
      await expectRevert(send("basalt", "grantDisclosure", [a.cid, 2]), "RevealRequired");
      await reveal(d.ledger, a, "ashgrove-triage");
      await expectRevert(send("kestrel-admin", "grantDisclosure", [a.cid, 2]), "NotAParty");
      await expectRevert(send("basalt", "grantDisclosure", [a.cid, 1]), "SameProgram");
      await send("basalt", "grantDisclosure", [a.cid, 2]);
      assert.equal(await read("disclosedTo", a.cid, 2), true);
    });
  });

  describe("associations and disputes", () => {
    let a: Awaited<ReturnType<typeof anchor>>;
    let b: Awaited<ReturnType<typeof anchor>>;
    let aid = 0;
    let did = 0;

    it("requires revealed reports in different programs, and review by the other program", async () => {
      a = await anchor(d.ledger, "basalt", 1);
      b = await anchor(d.ledger, "quillfox", 2);
      await reveal(d.ledger, a, "ashgrove-triage");
      await expectRevert(send("ashgrove-triage", "proposeAssociation", [a.cid, b.cid, 1, digest("why")]), "RevealRequired");
      await reveal(d.ledger, b, "kestrel-triage");
      const c = await anchor(d.ledger, "nightjar", 1);
      await reveal(d.ledger, c, "ashgrove-triage");
      await expectRevert(send("ashgrove-triage", "proposeAssociation", [a.cid, c.cid, 1, digest("why")]), "SameProgram");
      await expectRevert(send("tamarind-triage", "proposeAssociation", [a.cid, b.cid, 1, digest("why")]), "WrongProgram");
      await expectRevert(send("basalt", "proposeAssociation", [a.cid, b.cid, 1, digest("why")]), "NotAuthorized");
      const tx = await send("ashgrove-triage", "proposeAssociation", [a.cid, b.cid, 1, digest("same root cause")]);
      aid = Number(tx.events.find((e) => e.name === "AssociationProposed")!.args.aid);
      await expectRevert(send("ashgrove-admin", "proposeAssociation", [b.cid, a.cid, 2, digest("dup")]), "AssociationExists");
      await expectRevert(send("ashgrove-triage", "reviewAssociation", [aid, true, digest("ok")]), "ProposerCannotReview");
      await expectRevert(send("ashgrove-admin", "reviewAssociation", [aid, true, digest("ok")]), "WrongProgram");
      await send("kestrel-triage", "reviewAssociation", [aid, true, digest("agreed after reading both")]);
      const s = await read("getAssociation", aid);
      assert.equal(ASSOC_STATUS[Number(s.status)], "confirmed");
      const fa = (await read("getCommitment", a.cid)).family;
      assert.notEqual(fa, ZeroHash);
      assert.equal((await read("getCommitment", b.cid)).family, fa, "both reports share a pseudonymous issue-family token");
      await expectRevert(send("kestrel-admin", "reviewAssociation", [aid, false, digest("late")]), "AssociationNotPending");
    });

    it("only parties open disputes, and conflicted, duplicate or unregistered voters are rejected", async () => {
      await expectRevert(send("nightjar", "openDispute", [DISPUTE_KIND.RELATIONSHIP, aid, digest("x")]), "NotAParty");
      await expectRevert(send("tamarind-admin", "openDispute", [DISPUTE_KIND.RELATIONSHIP, aid, digest("x")]), "NotAParty");
      const tx = await send("quillfox", "openDispute", [DISPUTE_KIND.RELATIONSHIP, aid, digest("these are different root causes")]);
      did = Number(tx.events.find((e) => e.name === "DisputeOpened")!.args.did);
      assert.equal(ASSOC_STATUS[Number((await read("getAssociation", aid)).status)], "disputed");
      await expectRevert(send("basalt", "openDispute", [DISPUTE_KIND.RELATIONSHIP, aid, digest("y")]), "DisputeExists");
      await expectRevert(send("arb-reyes", "vote", [did, DECISION.DISTINCT, 130, digest("r")]), "ConflictedArbitrator");
      await expectRevert(send("ashgrove-admin", "vote", [did, DECISION.DISTINCT, 130, digest("r")]), "NotAuthorized");
      await expectRevert(send("outsider", "vote", [did, DECISION.DISTINCT, 130, digest("r")]), "NotAuthorized");
      await expectRevert(send("arb-holm", "vote", [did, DECISION.PRIORITY_FIRST, 100, digest("r")]), "InvalidDecision");
      await send("arb-holm", "vote", [did, DECISION.SAME_ISSUE, 120, digest("same fix")]);
      await expectRevert(send("arb-holm", "vote", [did, DECISION.SAME_ISSUE, 120, digest("again")]), "AlreadyVoted");
      // the original relationship and family stay in place while the dispute is open
      assert.equal(Number((await read("getDispute", did)).status), 1);
    });

    it("decides at the threshold, accepts an appeal heard by a fresh panel, and keeps both rounds", async () => {
      await send("arb-okafor", "vote", [did, DECISION.SAME_ISSUE, 120, digest("same fix")]);
      let dd = await read("getDispute", did);
      assert.equal(Number(dd.status), 2, "decided");
      assert.equal(Number(dd.firstDecision), DECISION.SAME_ISSUE);
      await expectRevert(send("arb-vance", "vote", [did, DECISION.SAME_ISSUE, 120, digest("late")]), "NotOpenForVoting");
      await expectRevert(send("nightjar", "appeal", [did, digest("x")]), "NotAParty");
      await send("quillfox", "appeal", [did, digest("new evidence: different patch commits")]);
      dd = await read("getDispute", did);
      assert.equal(Number(dd.status), 3, "appealed");
      await expectRevert(send("arb-holm", "vote", [did, DECISION.DISTINCT, 130, digest("r")]), "PriorPanelMember");
      await send("arb-sato", "recuse", [did]);
      await expectRevert(send("arb-sato", "vote", [did, DECISION.DISTINCT, 130, digest("r")]), "ArbitratorRecused");
      await send("arb-vance", "vote", [did, DECISION.DISTINCT, 130, digest("different root cause")]);
      // a split vote does not decide
      assert.equal(Number((await read("getDispute", did)).status), 3);
      // need a second independent arbitrator who did not sit in round 1: register one
      await send("governor", "registerParticipant", [d.keyring.address("outsider"), ROLE.ARBITRATOR, 0]);
      await send("outsider", "vote", [did, DECISION.DISTINCT, 130, digest("different root cause")]);
      dd = await read("getDispute", did);
      assert.equal(Number(dd.status), 4, "final");
      assert.equal(dd.reversed, true);
      assert.equal(Number(dd.firstDecision), DECISION.SAME_ISSUE, "round-1 decision is kept");
      assert.equal(Number(dd.decision), DECISION.DISTINCT);
      const s = await read("getAssociation", aid);
      assert.equal(ASSOC_STATUS[Number(s.status)], "overturned");
      assert.equal(Number(s.relation), 1, "the proposed relation is kept");
      assert.equal(Number(s.decidedRelation), 3);
      assert.equal((await read("getCommitment", a.cid)).family, ZeroHash, "family token withdrawn after the decision");
      await expectRevert(send("basalt", "appeal", [did, digest("again")]), "NotDecided");
    });

    it("enforces the appeal window, and validity disputes change triage status only through arbitration", async () => {
      const r = await anchor(d.ledger, "nightjar", 2);
      await reveal(d.ledger, r, "kestrel-triage");
      await send("kestrel-triage", "setTriage", [r.cid, ST.PENDING_TRIAGE, digest("n")]);
      await send("kestrel-triage", "setTriage", [r.cid, ST.INVALID, digest("not reproducible")]);
      const tx = await send("nightjar", "openDispute", [DISPUTE_KIND.VALIDITY, r.cid, digest("reproduces on build 2.3")]);
      const vd = Number(tx.events.find((e) => e.name === "DisputeOpened")!.args.did);
      await expectRevert(send("kestrel-admin", "finalizeReport", [r.cid, digest("f")]), "DisputeOpen");
      await send("arb-holm", "vote", [vd, DECISION.VALID, 100, digest("reproduced")]);
      await send("arb-reyes", "vote", [vd, DECISION.VALID, 100, digest("reproduced")]); // Reyes is affiliated with program 1, not involved here
      await expectRevert(send("basalt", "closeDispute", [vd]), "AppealWindowOpen");
      await d.ledger.provider.send("evm_increaseTime", [3601]);
      await d.ledger.provider.send("evm_mine", []);
      await expectRevert(send("kestrel-admin", "appeal", [vd, digest("late")]), "AppealWindowClosed");
      await send("basalt", "closeDispute", [vd]);
      assert.equal(Number((await read("getCommitment", r.cid)).status), ST.VALID, "arbitration overrode the triage result");
      await send("kestrel-admin", "finalizeReport", [r.cid, digest("rewarded per policy v1")]);
    });

    it("priority disputes need a same-issue relation and record who gets priority", async () => {
      const x = await anchor(d.ledger, "basalt", 2);
      const y = await anchor(d.ledger, "nightjar", 3, sampleReport(), 2);
      await reveal(d.ledger, x, "kestrel-triage");
      await reveal(d.ledger, y, "tamarind-triage");
      let tx = await send("tamarind-triage", "proposeAssociation", [x.cid, y.cid, 2, digest("related")]);
      const rel = Number(tx.events.find((e) => e.name === "AssociationProposed")!.args.aid);
      await send("kestrel-triage", "reviewAssociation", [rel, true, digest("ok")]);
      await expectRevert(send("basalt", "openDispute", [DISPUTE_KIND.PRIORITY, rel, digest("p")]), "InvalidSubject");
      const x2 = await anchor(d.ledger, "quillfox", 2);
      const y2 = await anchor(d.ledger, "nightjar", 3, sampleReport(), 2);
      await reveal(d.ledger, x2, "kestrel-triage");
      await reveal(d.ledger, y2, "tamarind-triage");
      tx = await send("kestrel-triage", "proposeAssociation", [x2.cid, y2.cid, 1, digest("same")]);
      const same = Number(tx.events.find((e) => e.name === "AssociationProposed")!.args.aid);
      await send("tamarind-admin", "reviewAssociation", [same, true, digest("ok")]);
      tx = await send("nightjar", "openDispute", [DISPUTE_KIND.PRIORITY, same, digest("mine was first actionable")]);
      const pd = Number(tx.events.find((e) => e.name === "DisputeOpened")!.args.did);
      await send("arb-holm", "vote", [pd, DECISION.PRIORITY_FIRST, 100, digest("earlier commitment, matched reveal")]);
      await send("arb-okafor", "vote", [pd, DECISION.PRIORITY_FIRST, 100, digest("agree")]);
      await d.ledger.provider.send("evm_increaseTime", [3601]);
      await d.ledger.provider.send("evm_mine", []);
      await send("auditor", "closeDispute", [pd]);
      assert.equal(Number((await read("getDispute", pd)).priorityTo), Math.min(x2.cid, y2.cid));
    });
  });

  describe("append-only log", () => {
    it("hash-chains every state change and exposes no edit or delete function", async () => {
      await send("auditor", "attest", [digest("audit report 1")]);
      await expectRevert(send("basalt", "attest", [digest("x")]), "NotAuthorized");
      const logs = await d.ledger.contract.queryFilter(d.ledger.contract.filters.LogAppended(), 0, "latest");
      const count = Number(await read("logCount"));
      assert.equal(logs.length, count);
      let prev = ZeroHash;
      for (const l of logs as any[]) {
        const a = l.args;
        assert.equal(a.prevHash, prev, `entry ${a.seq} links to its predecessor`);
        const h = logEntryHash(d.ledger.chainId, d.ledger.address, {
          seq: Number(a.seq), kind: Number(a.kind), subject: a.subject, actor: a.actor, timestamp: Number(a.timestamp), dataHash: a.dataHash, prevHash: a.prevHash,
        });
        assert.equal(h, a.entryHash);
        assert.equal(await read("logEntries", a.seq), h);
        prev = h;
      }
      assert.equal(await read("logHead"), prev);
      const mutating: string[] = [];
      d.ledger.contract.interface.forEachFunction((f) => {
        if (f.stateMutability !== "view" && f.stateMutability !== "pure") mutating.push(f.name);
      });
      assert.ok(!mutating.some((n) => /delete|remove|edit|update|overwrite|set(Commitment|Status)$/i.test(n)), mutating.join(","));
    });
  });
});
