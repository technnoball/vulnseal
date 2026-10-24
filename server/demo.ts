// Guided demonstration: a fictional cross-program priority dispute from first commitment
// to final adjudication. Every step performs real service calls (contract transactions
// signed by the named demo identities) and records what actually happened, including
// the rejections the scenario expects. Nothing here is pre-recorded.
import { DECISION, DISPUTE_KIND, RELATION, reportRef } from "./domain.ts";
import { auditReport } from "./integrity.ts";
import { keccak256, toUtf8Bytes } from "ethers";
import type { Viewer, VulnSealService } from "./service.ts";

interface Action {
  label: string;
  actor: string;
  ok: boolean;
  expectedFailure?: boolean;
  tx?: string;
  detail?: string;
}
interface StepResult {
  step: number;
  title: string;
  at: string;
  actions: Action[];
}
interface DemoState {
  next: number;
  run: number;
  cidA?: number;
  cidC?: number;
  aid?: number;
  did?: number;
  results: StepResult[];
}

const REPORT_A = {
  title: "Partner SDK keeps a session valid after sign-out (synthetic)",
  description:
    "SYNTHETIC DEMO REPORT. In the fictional checkout app, signing out does not invalidate the session issued through the shared partner SDK, so a copied session identifier keeps working for a while.",
  impact: "A person who obtained a copy of the session identifier could keep using it after the user signed out (fictional).",
  reproduction: "1. Sign in to the fictional test account. 2. Note the session identifier. 3. Sign out. 4. Reuse the identifier; it is still accepted for some minutes.",
  scope: "checkout.ashgrove.example (fictional) via partner SDK 4.2",
  severity: "high",
};
const REPORT_C = {
  title: "Mobile app session survives logout when using partner SDK (synthetic)",
  description:
    "SYNTHETIC DEMO REPORT. In the fictional banking app, the partner SDK session remains usable after logout. Observed on the fictional Android build 7.1.",
  impact: "Session reuse after logout on a shared device (fictional).",
  reproduction: "1. Log in on the fictional test build. 2. Capture the SDK session token from the test proxy. 3. Log out. 4. Replay a request; it succeeds.",
  scope: "Tamarind Android 7.1 (fictional), partner SDK 4.2",
  severity: "medium",
};

export class DemoRunner {
  private svc: VulnSealService;
  constructor(svc: VulnSealService) {
    this.svc = svc;
  }

  static readonly STEPS = [
    "Researcher basalt commits a confidential report to Program A (Ashgrove)",
    "Researcher nightjar commits an overlapping report to Program C (Tamarind)",
    "Both programs acknowledge the commitments and request reveals",
    "nightjar first reveals an altered copy: verification fails and the mismatch is recorded",
    "Both researchers reveal the reports they committed: verification matches",
    "Researchers allow the other program to read their revealed report",
    "Program A's reviewer proposes that both reports concern the same issue",
    "Program C's reviewer independently confirms; a pseudonymous issue-family token is assigned",
    "nightjar disputes which report should have priority",
    "Unauthorized adjudication attempts: a conflicted arbitrator and a program admin try to vote",
    "Independent arbitrators Holm and Okafor decide: priority to the earlier, matching commitment",
    "nightjar appeals the decision",
    "A fresh panel (Vance, Sato) hears the appeal; the dispute becomes final",
    "The auditor verifies the whole history and records an attestation on-chain",
  ];

  private load(): DemoState {
    const raw = this.svc.store.getMeta("demo_state");
    return raw ? JSON.parse(raw) : { next: 0, run: 1, results: [] };
  }
  private save(s: DemoState) {
    this.svc.store.setMeta("demo_state", JSON.stringify(s));
  }

  state() {
    const s = this.load();
    return { steps: DemoRunner.STEPS, ...s, done: s.next >= DemoRunner.STEPS.length, refs: { a: s.cidA ? reportRef(s.cidA) : null, c: s.cidC ? reportRef(s.cidC) : null } };
  }

  reset() {
    const s = this.load();
    this.save({ next: 0, run: s.run + 1, results: [] });
    return this.state();
  }

  private v(id: string): Viewer {
    return this.svc.viewer(id)!;
  }

  private async attempt(actions: Action[], label: string, actor: string, fn: () => Promise<any>, expectedFailure = false) {
    try {
      const r = await fn();
      actions.push({ label, actor, ok: true, tx: r?.tx?.hash ?? r?.tx ?? r?.hash ?? undefined, detail: r?.detail });
      return r;
    } catch (e: any) {
      if (!expectedFailure) throw e;
      actions.push({ label, actor, ok: false, expectedFailure: true, detail: e.message });
      return null;
    }
  }

  async runNext(_viewer?: Viewer) {
    const s = this.load();
    if (s.next >= DemoRunner.STEPS.length) return this.state();
    const actions: Action[] = [];
    const svc = this.svc;
    const step = s.next;
    switch (step) {
      case 0: {
        const r = await this.attempt(actions, "commitReport → anchorCommitment()", "basalt", () => svc.commitReport(this.v("basalt"), { ...REPORT_A, title: `${REPORT_A.title} #${s.run}`, programId: 1 }));
        s.cidA = r.cid;
        actions[0].detail = `${r.ref}: commitment ${r.commitment.slice(0, 18)}… in block ${r.tx.blockNumber}`;
        break;
      }
      case 1: {
        const r = await this.attempt(actions, "commitReport → anchorCommitment()", "nightjar", () =>
          svc.commitReport(this.v("nightjar"), { ...REPORT_C, title: `${REPORT_C.title} #${s.run}`, programId: 3 }),
        );
        s.cidC = r.cid;
        actions[0].detail = `${r.ref}: commitment ${r.commitment.slice(0, 18)}… in block ${r.tx.blockNumber}`;
        break;
      }
      case 2: {
        await this.attempt(actions, `acknowledge(${reportRef(s.cidA!)})`, "Ashgrove triage", () => svc.acknowledge(this.v("ashgrove-triage"), s.cidA!));
        await this.attempt(actions, `requestReveal(${reportRef(s.cidA!)})`, "Ashgrove triage", () => svc.requestReveal(this.v("ashgrove-triage"), s.cidA!));
        await this.attempt(actions, `acknowledge(${reportRef(s.cidC!)})`, "Tamarind triage", () => svc.acknowledge(this.v("tamarind-triage"), s.cidC!));
        await this.attempt(actions, `requestReveal(${reportRef(s.cidC!)})`, "Tamarind triage", () => svc.requestReveal(this.v("tamarind-triage"), s.cidC!));
        break;
      }
      case 3: {
        const sub = await this.attempt(actions, "reveal an edited copy (impact changed after committing)", "nightjar", () =>
          svc.submitReveal(this.v("nightjar"), s.cidC!, { mode: "edited", edits: { impact: "Full account takeover on every device (exaggerated after the fact)." } }),
        );
        actions[0].detail = `pre-check: ${sub.precheck.outcome}`;
        const ver = await this.attempt(actions, "verify reveal → recordReveal(MISMATCH)", "Tamarind triage", () => svc.verifyReveal(this.v("tamarind-triage"), sub.revealId));
        actions[1].detail = `recorded outcome: ${ver.outcome}`;
        break;
      }
      case 4: {
        for (const [cid, who, reviewer, label] of [
          [s.cidA!, "basalt", "ashgrove-triage", "Ashgrove triage"],
          [s.cidC!, "nightjar", "tamarind-triage", "Tamarind triage"],
        ] as const) {
          const sub = await this.attempt(actions, `reveal ${reportRef(cid)} from the sealed original`, who, () => svc.submitReveal(this.v(who), cid, { mode: "vault" }));
          const ver = await this.attempt(actions, `verify reveal → recordReveal(MATCH)`, label, () => svc.verifyReveal(this.v(reviewer), sub.revealId));
          actions[actions.length - 1].detail = `recorded outcome: ${ver.outcome}`;
        }
        break;
      }
      case 5: {
        await this.attempt(actions, `grantDisclosure(${reportRef(s.cidA!)} → Program C)`, "basalt", () => svc.grantDisclosure(this.v("basalt"), s.cidA!, 3));
        await this.attempt(actions, `grantDisclosure(${reportRef(s.cidC!)} → Program A)`, "nightjar", () => svc.grantDisclosure(this.v("nightjar"), s.cidC!, 1));
        break;
      }
      case 6: {
        const r = await this.attempt(actions, "proposeAssociation(same issue)", "Ashgrove triage", () =>
          svc.proposeAssociation(this.v("ashgrove-triage"), s.cidA!, s.cidC!, RELATION.SAME_ISSUE, "Both describe the partner SDK 4.2 session not being revoked on sign-out; same component, same fix (revoke on logout)."),
        );
        s.aid = r.aid;
        await this.attempt(actions, "the proposer reviews its own proposal", "Ashgrove triage", () => svc.reviewAssociation(this.v("ashgrove-triage"), r.aid, true, "self-approval"), true);
        break;
      }
      case 7: {
        await this.attempt(actions, "reviewAssociation(approve)", "Tamarind triage", () =>
          svc.reviewAssociation(this.v("tamarind-triage"), s.aid!, true, "Read both revealed reports: same SDK session handling, same fix. Confirmed."),
        );
        const a = await svc.associationView(this.v("auditor"), s.aid!);
        actions.push({ label: "issue-family token", actor: "contract", ok: !!a.family, detail: a.family ? `${a.family.slice(0, 18)}… (links the two commitments, reveals nothing else)` : "none" });
        break;
      }
      case 8: {
        const r = await this.attempt(actions, "openDispute(PRIORITY)", "nightjar", () =>
          svc.openDispute(this.v("nightjar"), DISPUTE_KIND.PRIORITY, s.aid!, "My report includes the mobile reproduction the program needed; I ask for shared priority under policy clause 'first actionable report'."),
        );
        s.did = r.did;
        break;
      }
      case 9: {
        await this.attempt(actions, "vote (affiliated with Program A, which is a party)", "Arbitrator Reyes", () =>
          svc.vote(this.v("arb-reyes"), s.did!, DECISION.PRIORITY_FIRST, 100, "Program A's report was first."), true);
        await this.attempt(actions, "vote (program admin, not an arbitrator)", "Tamarind admin", () =>
          svc.vote(this.v("tamarind-admin"), s.did!, DECISION.PRIORITY_SECOND, 110, "Our researcher should win."), true);
        break;
      }
      case 10: {
        for (const who of ["arb-holm", "arb-okafor"]) {
          await this.attempt(actions, "vote: priority to the first report, reason 100", this.v(who).label, () =>
            svc.vote(this.v(who), s.did!, DECISION.PRIORITY_FIRST, 100, "Earlier commitment; its reveal matched first time and reproduces under policy v1."),
          );
        }
        break;
      }
      case 11: {
        await this.attempt(actions, "appeal()", "nightjar", () => svc.appeal(this.v("nightjar"), s.did!, "The first report did not cover the mobile client; please reconsider shared priority."));
        await this.attempt(actions, "a round-1 arbitrator tries to sit on the appeal", "Arbitrator Holm", () =>
          svc.vote(this.v("arb-holm"), s.did!, DECISION.PRIORITY_FIRST, 100, "Same as before."), true);
        break;
      }
      case 12: {
        for (const who of ["arb-vance", "arb-sato"]) {
          await this.attempt(actions, "appeal vote: priority to the first report, reason 100", this.v(who).label, () =>
            svc.vote(this.v(who), s.did!, DECISION.PRIORITY_FIRST, 100, "The root cause and fix are shared; the earlier matching commitment keeps priority. Mobile details noted for the bounty decision."),
          );
        }
        const d = await svc.disputeView(this.v("auditor"), s.did!);
        actions.push({ label: "final state", actor: "contract", ok: d.statusName === "final", detail: `${d.statusName}; priority to ${d.priorityTo}; round 1 and appeal both recorded` });
        break;
      }
      case 13: {
        const r = await auditReport(svc);
        actions.push({ label: "integrity check", actor: "Consortium auditor", ok: r.ok, detail: `${r.counts.logEntries} log entries, ${r.findings.length} finding(s)` });
        const digest = keccak256(toUtf8Bytes(JSON.stringify({ head: r.chain.logHead, count: r.chain.logCount, ok: r.ok })));
        await this.attempt(actions, "attest(audit digest)", "Consortium auditor", () => svc.tx("auditor", "attest", [digest]));
        break;
      }
    }
    s.results.push({ step, title: DemoRunner.STEPS[step], at: new Date().toISOString(), actions });
    s.next = step + 1;
    this.save(s);
    return this.state();
  }
}
