// Fictional demonstration data, created through the real service: every record below is
// an actual contract transaction signed by the named demo identity. Programs, people,
// hosts and findings are invented; no real vulnerability or exploit material is used.
import { DECISION, DISPUTE_KIND, RELATION } from "../server/domain.ts";
import type { VulnSealService, Viewer } from "../server/service.ts";

const evidenceText = (title: string, lines: string[]) =>
  Buffer.from(["SYNTHETIC DEMO EVIDENCE - fictional program, fictional host, no real target", title, "", ...lines, ""].join("\n"));

export async function seedDemo(svc: VulnSealService) {
  const v = (id: string): Viewer => svc.viewer(id)!;
  const commit = async (who: string, programId: number, f: Record<string, string>, evidence?: { name: string; lines: string[] }) => {
    const evidenceIds = evidence ? [svc.uploadEvidence(v(who), { buffer: evidenceText(f.title, evidence.lines), originalname: evidence.name, mimetype: "text/plain" }).id] : [];
    return (await svc.commitReport(v(who), { ...f, programId, evidenceIds })).cid;
  };
  const revealAndVerify = async (cid: number, who: string, reviewer: string) => {
    await svc.acknowledge(v(reviewer), cid);
    await svc.requestReveal(v(reviewer), cid);
    const r = await svc.submitReveal(v(who), cid, { mode: "vault" });
    await svc.verifyReveal(v(reviewer), r.revealId);
  };

  svc.setPrivateIdentity("basalt", { payoutName: "Asha Basu (fictional)", contact: "basalt@researchers.example", country: "IN" });
  svc.setPrivateIdentity("quillfox", { payoutName: "Quentin Fox (fictional)", contact: "quillfox@researchers.example", country: "GB" });
  svc.setPrivateIdentity("nightjar", { payoutName: "Nadia Jaramillo (fictional)", contact: "nightjar@researchers.example", country: "MX" });

  // R1: straightforward valid report, finalized
  const r1 = await commit(
    "basalt",
    1,
    {
      title: "Coupon code reflected without encoding on the order summary (synthetic)",
      description: "SYNTHETIC. The fictional order summary page repeats the coupon code typed by the shopper without HTML encoding.",
      impact: "Markup can be injected into the shopper's own order summary (fictional).",
      reproduction: "1. Add any item on the fictional test store. 2. Enter a coupon containing angle brackets. 3. Observe it rendered as markup on the summary.",
      scope: "checkout.ashgrove.example (fictional)",
      severity: "medium",
    },
    { name: "observation-log.txt", lines: ["10:02 opened fictional test store", "10:04 coupon field echoed on summary", "10:05 markup rendered (screenshot omitted in synthetic data)"] },
  );
  await revealAndVerify(r1, "basalt", "ashgrove-triage");
  await svc.triage(v("ashgrove-triage"), r1, "pending-triage", "Reproduced on the fictional staging store.");
  await svc.triage(v("ashgrove-triage"), r1, "valid", "Valid, in scope under policy v1.");
  await svc.finalizeReport(v("ashgrove-admin"), r1, "Rewarded under Ashgrove policy v1 (fictional amount).");

  // R2/R3: same-issue pair across Programs B and C, priority dispute with appeal -> final
  const r2 = await commit("quillfox", 2, {
    title: "Image preview service crashes on an oversized metadata block (synthetic)",
    description: "SYNTHETIC. The fictional shared image library used by the preview service stops responding when an image carries an unusually large metadata block.",
    impact: "Preview service unavailable for all tenants until restart (fictional).",
    reproduction: "1. Upload the synthetic test image with an oversized metadata block. 2. Request a preview. 3. Service stops responding.",
    scope: "console.kestrel.example preview service (fictional)",
    severity: "high",
  });
  const r3 = await commit("nightjar", 3, {
    title: "Profile photo upload hangs on oversized image metadata (synthetic)",
    description: "SYNTHETIC. Uploading a profile photo with a very large metadata block makes the fictional upload service hang; the same shared image library is involved.",
    impact: "Profile photo uploads fail for everyone until the worker restarts (fictional).",
    reproduction: "1. In the fictional test app, choose the synthetic test image. 2. Upload it as a profile photo. 3. The upload never completes.",
    scope: "api.tamarind.example upload worker (fictional)",
    severity: "medium",
  });
  await revealAndVerify(r2, "quillfox", "kestrel-triage");
  await revealAndVerify(r3, "nightjar", "tamarind-triage");
  await svc.triage(v("kestrel-triage"), r2, "pending-triage", "");
  await svc.grantDisclosure(v("quillfox"), r2, 3);
  await svc.grantDisclosure(v("nightjar"), r3, 2);
  const a1 = (
    await svc.proposeAssociation(v("kestrel-triage"), r2, r3, RELATION.SAME_ISSUE, "Both trace to the same shared image library's metadata parser; the fix is a single bounds check in that library.")
  ).aid;
  await svc.reviewAssociation(v("tamarind-triage"), a1, true, "Confirmed after reading both revealed reports: same library, same fix.");
  const d1 = (await svc.openDispute(v("nightjar"), DISPUTE_KIND.PRIORITY, a1, "My report showed the mobile upload path; I request shared priority.")).did;
  await svc.vote(v("arb-holm"), d1, DECISION.PRIORITY_FIRST, 100, "Earlier commitment, reveal matched, reproducible; same root cause.");
  await svc.vote(v("arb-okafor"), d1, DECISION.PRIORITY_FIRST, 100, "Agree: earlier matching commitment covers the root cause.");
  await svc.appeal(v("nightjar"), d1, "The first report did not cover the mobile upload path.");
  await svc.vote(v("arb-vance"), d1, DECISION.PRIORITY_FIRST, 100, "Different entry point, same root cause and fix; priority stays with the earlier report.");
  await svc.vote(v("arb-sato"), d1, DECISION.PRIORITY_FIRST, 100, "Upholding the first-round decision.");

  // R4/R5: proposed as the same issue, rejected by the other program, now disputed (open)
  const r4 = await commit(
    "basalt",
    1,
    {
      title: "Merchant CSV export includes other merchants' rows when the filter is empty (synthetic)",
      description: "SYNTHETIC. With an empty date filter the fictional merchant export returns rows belonging to other merchants.",
      impact: "Cross-merchant data exposure in the export (fictional).",
      reproduction: "1. Sign in as the fictional test merchant. 2. Open Exports. 3. Clear the date filter and export. 4. Rows from other test merchants appear.",
      scope: "merchants.ashgrove.example exports (fictional)",
      severity: "high",
    },
    { name: "export-sample.txt", lines: ["merchant_id,rows", "test-merchant-1,12", "test-merchant-2,9  <- not ours (synthetic)"] },
  );
  const r5 = await commit("quillfox", 2, {
    title: "Console export ignores the tenant filter on an empty query (synthetic)",
    description: "SYNTHETIC. The fictional storage console's usage export returns other tenants' rows when the query box is empty.",
    impact: "Cross-tenant usage data exposure (fictional).",
    reproduction: "1. Sign in to the fictional console. 2. Open Usage export. 3. Leave the query empty and export.",
    scope: "console.kestrel.example usage export (fictional)",
    severity: "high",
  });
  await revealAndVerify(r4, "basalt", "ashgrove-triage");
  await revealAndVerify(r5, "quillfox", "kestrel-triage");
  await svc.grantDisclosure(v("basalt"), r4, 2);
  await svc.grantDisclosure(v("quillfox"), r5, 1);
  const a2 = (
    await svc.proposeAssociation(v("ashgrove-triage"), r4, r5, RELATION.SAME_ISSUE, "Both reports describe an export that drops the owner filter when the query is empty; we believe both use the same reporting component.")
  ).aid;
  await svc.reviewAssociation(v("kestrel-triage"), a2, false, "Different services and different fixes: our export is built in-house; the empty-query bug is in our own code.");
  const d2 = (await svc.openDispute(v("basalt"), DISPUTE_KIND.RELATIONSHIP, a2, "The two exports share the vendor reporting component (same error text in both); please decide whether this is the same issue.")).did;

  // R6: a reveal that first fails verification, then matches; triage asks for more info
  const r6 = await commit("nightjar", 1, {
    title: "Password reset e-mail shows the full card number (synthetic)",
    description: "SYNTHETIC. The fictional password reset e-mail includes the full stored card number instead of the last four digits.",
    impact: "Card number exposure to anyone reading the e-mail (fictional).",
    reproduction: "1. Request a password reset for the fictional test account. 2. Open the e-mail. 3. The full test card number is shown.",
    scope: "checkout.ashgrove.example account e-mails (fictional)",
    severity: "high",
  });
  await svc.acknowledge(v("ashgrove-triage"), r6);
  await svc.requestReveal(v("ashgrove-triage"), r6);
  const bad = await svc.submitReveal(v("nightjar"), r6, { mode: "edited", edits: { severity: "critical", impact: "Card number exposure plus account takeover (claimed after the fact)." } });
  await svc.verifyReveal(v("ashgrove-triage"), bad.revealId);
  const good = await svc.submitReveal(v("nightjar"), r6, { mode: "vault" });
  await svc.verifyReveal(v("ashgrove-triage"), good.revealId);
  await svc.triage(v("ashgrove-triage"), r6, "pending-triage", "");
  await svc.triage(v("ashgrove-triage"), r6, "needs-info", "Which e-mail template version? Our staging template masks the number.");

  // R7 -> R8: a revision that keeps the original on record
  const r7 = await commit("basalt", 3, {
    title: "Transfer limit bypass with a negative amount (synthetic)",
    description: "SYNTHETIC. The fictional transfer screen accepts a negative amount.",
    impact: "Limit checks may be skipped (fictional).",
    reproduction: "1. Open Transfers in the fictional test app. 2. Enter a negative amount.",
    scope: "Tamarind iOS 7.1 (fictional)",
    severity: "medium",
  });
  const r8 = (
    await svc.reviseReport(v("basalt"), r7, {
      title: "Transfer limit bypass with a negative amount (synthetic, revised)",
      description: "SYNTHETIC. The fictional transfer screen accepts a negative amount; the server also accepts it. Revised with server-side confirmation.",
      impact: "Daily limit checks are skipped for negative transfers (fictional).",
      reproduction: "1. Open Transfers in the fictional test app. 2. Enter a negative amount. 3. Confirm; the server records the transfer.",
      scope: "Tamarind iOS 7.1 and api.tamarind.example (fictional)",
      severity: "high",
    })
  ).cid;

  // R9: anchored only; R10: reveal requested, waiting for the researcher
  const r9 = await commit("quillfox", 1, {
    title: "Merchant logo upload accepts any file type (synthetic)",
    description: "SYNTHETIC. The fictional merchant logo upload does not check the file type.",
    impact: "Unexpected file types stored on the asset host (fictional).",
    reproduction: "1. Open merchant settings. 2. Upload a non-image file as logo.",
    scope: "merchants.ashgrove.example settings (fictional)",
    severity: "low",
  });
  const r10 = await commit("nightjar", 2, {
    title: "Share link keeps working after the object is made private (synthetic)",
    description: "SYNTHETIC. In the fictional console, a share link created while an object was public continues to work after the object is made private.",
    impact: "Objects remain reachable after access is withdrawn (fictional).",
    reproduction: "1. Make an object public and create a share link. 2. Make the object private. 3. Open the link.",
    scope: "storage API share links (fictional)",
    severity: "medium",
  });
  await svc.acknowledge(v("kestrel-triage"), r10);
  await svc.requestReveal(v("kestrel-triage"), r10);

  return { reports: { r1, r2, r3, r4, r5, r6, r7, r8, r9, r10 }, associations: { a1, a2 }, disputes: { d1, d2 } };
}
