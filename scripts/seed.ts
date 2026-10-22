// Seed clearly-labelled synthetic demonstration data through the real service
// (every record is committed to the local chain exactly as the UI would).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openContext } from "../server/context.ts";
import type { EventInput, PatchLedgerService } from "../server/service.ts";
import { makeComponentSvg, makePdf, makeText } from "./lib/synthetic-docs.ts";

type Doc = { name: string; mime: string; data: Buffer; kind: string; description: string; access?: "restricted" | "shareable" };

export async function seed(svc: PatchLedgerService) {
  const upload = (actor: string, publicId: string, d: Doc) =>
    svc.uploadEvidence(actor, publicId, { buffer: d.data, originalname: d.name, mimetype: d.mime }, { kind: d.kind, description: d.description, access: d.access ?? "restricted" });
  const add = async (actor: string, publicId: string, input: EventInput, docs: Doc[] = []) => {
    const ids = docs.map((d) => upload(actor, publicId, d).evidence.id);
    return svc.appendEvent(actor, publicId, { ...input, evidenceIds: ids });
  };
  const pdf = (name: string, kind: string, description: string, title: string, lines: string[], access?: "restricted" | "shareable"): Doc => ({
    name,
    mime: "application/pdf",
    data: makePdf(title, lines),
    kind,
    description,
    access,
  });

  // ---------------------------------------------------------------- Device A
  const a = (await svc.registerDevice("registrar", { brand: "Lenovo", model: "ThinkPad T480", year: 2018, formFactor: "laptop", synthetic: true })).publicId;
  await add(
    "repairer-a",
    a,
    {
      type: "DIAGNOSTIC",
      claimedAt: "2025-02-03",
      category: "chassis",
      component: "hinge",
      description: "Intake diagnostic. Left display hinge cracked at the mounting bracket; lid wobbles. Installed memory recorded as 16 GB. Keyboard, ports and battery functional.",
      result: "fail",
      measurements: { memoryGb: 16, batteryHealthPct: 88 },
      componentAssertions: [{ component: "battery", state: "original" }],
    },
    [pdf("intake-diagnostic-T480.pdf", "inspection-report", "Intake diagnostic sheet", "Kiran Bench Repairs - Intake Diagnostic", [
      `Device: ${a}  Lenovo ThinkPad T480`,
      "Date: 2025-02-03",
      "Hinge (left): CRACKED at bracket",
      "Memory: 16 GB (as read at intake)",
      "Battery health: 88 %",
      "Ports / keyboard: OK",
    ])],
  );
  await add(
    "repairer-a",
    a,
    { type: "REPAIR", claimedAt: "2025-02-05", category: "chassis", component: "hinge", description: "Replaced cracked left hinge bracket and re-seated display hinge screws. Lid tension tested through 50 open/close cycles.", result: "repaired" },
    [
      pdf("invoice-KBR-0412.pdf", "repair-invoice", "Repair invoice (synthetic)", "Kiran Bench Repairs - Invoice KBR-0412", [
        `Device: ${a}`,
        "Line 1: Hinge bracket (left), compatible part ....... INR 650",
        "Line 2: Labour ...................................... INR 400",
        "Total ............................................... INR 1050",
      ], "shareable"),
      { name: "hinge-after-repair.svg", mime: "image/svg+xml", data: makeComponentSvg("Hinge bracket after repair", "hinge", `${a} - left hinge, new bracket fitted`), kind: "component-photo", description: "Photograph (synthetic drawing) of the repaired hinge", access: "shareable" },
    ],
  );
  await add("repairer-a", a, {
    type: "CORRECTION",
    refSeq: 1,
    reason: "Memory was mis-recorded at intake as 16 GB; the device has 8 GB (one 8 GB SODIMM). The original diagnostic remains in the history.",
    description: "Intake diagnostic. Left display hinge cracked at the mounting bracket. Installed memory 8 GB. Keyboard, ports and battery functional.",
    component: "hinge",
    result: "fail",
    componentAssertions: [{ component: "battery", state: "original" }],
  });
  await add(
    "inspector",
    a,
    {
      type: "INSPECTION",
      claimedAt: "2025-02-12",
      category: "general",
      description: "Refurbishment inspection: cosmetic grade A-, hinge firm, 8 GB memory confirmed, original battery at 87 % health.",
      result: "pass",
      componentAssertions: [{ component: "battery", state: "original" }, { component: "hinge", state: "replaced" }],
      measurements: { memoryGb: 8, batteryHealthPct: 87 },
    },
    [pdf("inspection-RC-2291.pdf", "inspection-report", "Refurbishment inspection report", "ReCircuit Refurbishers - Inspection RC-2291", [
      `Device: ${a}`,
      "Cosmetic grade: A-",
      "Hinge: firm, bracket replaced (matches repair record)",
      "Memory: 8 GB",
      "Battery: original, 87 % health",
    ], "shareable")],
  );
  await add(
    "inspector",
    a,
    { type: "CORROBORATION", refSeq: 2, claimedAt: "2025-02-12", description: "Hinge bracket inspected: part and screws consistent with invoice KBR-0412.", result: "observed" },
    [{ name: "hinge-inspection.svg", mime: "image/svg+xml", data: makeComponentSvg("Inspector photo - hinge bracket", "hinge", `${a} - bracket consistent with invoice`), kind: "component-photo", description: "Inspector's photograph (synthetic drawing)", access: "shareable" }],
  );
  await add("inspector", a, { type: "CUSTODY_TRANSFER", claimedAt: "2025-02-20", fromParty: "ReCircuit Refurbishers", toParty: "Retail buyer (identity not recorded)", description: "Sold as refurbished, grade A-." });

  // ---------------------------------------------------------------- Device B
  const b = (await svc.registerDevice("registrar", { brand: "Dell", model: "Latitude 7490", year: 2018, formFactor: "laptop", synthetic: true })).publicId;
  const receipt = pdf("cell-pack-receipt-SV-77.pdf", "purchase-receipt", "Component purchase receipt", "Sunrise Electronics Supply - Receipt SV-77", [
    "Item: Replacement battery 60Wh, compatible (synthetic SKU BAT-7490-C)",
    "Qty: 1   Price: INR 3400",
    "Sold to: Sahyadri Laptop Clinic",
  ]);
  await add(
    "repairer-b",
    b,
    {
      type: "DIAGNOSTIC",
      claimedAt: "2025-03-10",
      category: "battery",
      component: "battery",
      description: "Battery wear test: full-charge capacity 52 % of design capacity after 812 cycles. Runtime under 1 h at moderate load.",
      result: "fail",
      measurements: { designCapacityMwh: 60000, fullChargeCapacityMwh: 31200, cycleCount: 812 },
      componentAssertions: [{ component: "battery", state: "original" }],
    },
    [pdf("battery-report-before.pdf", "battery-diagnostic", "Battery report before replacement", "Battery Report (before)", [
      `Device: ${b}`,
      "Design capacity:      60,000 mWh",
      "Full charge capacity: 31,200 mWh",
      "Cycle count:          812",
    ], "shareable")],
  );
  await add(
    "repairer-b",
    b,
    { type: "COMPONENT_REPLACEMENT", claimedAt: "2025-03-11", component: "battery", partOrigin: "new-compatible", description: "Replaced worn battery with new compatible 60 Wh pack. Old pack sent to e-waste collection.", result: "replaced" },
    [
      pdf("invoice-SLC-1188.pdf", "repair-invoice", "Repair invoice", "Sahyadri Laptop Clinic - Invoice SLC-1188", [`Device: ${b}`, "Battery replacement (part + labour) ..... INR 4200"], "shareable"),
      { name: "new-battery.svg", mime: "image/svg+xml", data: makeComponentSvg("Replacement battery pack", "battery", `${b} - new compatible pack before fitting`), kind: "component-photo", description: "Photograph (synthetic drawing) of the new pack", access: "shareable" },
      receipt,
    ],
  );
  await add(
    "repairer-b",
    b,
    {
      type: "DIAGNOSTIC",
      claimedAt: "2025-03-11",
      category: "battery",
      component: "battery",
      description: "Post-replacement battery report: full-charge capacity 98.5 % of design.",
      result: "pass",
      measurements: { designCapacityMwh: 60000, fullChargeCapacityMwh: 59100, cycleCount: 3 },
      componentAssertions: [{ component: "battery", state: "replaced" }],
    },
    [pdf("battery-report-after.pdf", "battery-diagnostic", "Battery report after replacement", "Battery Report (after)", [`Device: ${b}`, "Design capacity:      60,000 mWh", "Full charge capacity: 59,100 mWh", "Cycle count:          3"], "shareable")],
  );
  await add(
    "inspector",
    b,
    { type: "CORROBORATION", refSeq: 2, claimedAt: "2025-03-18", description: "Opened chassis: battery label and capacity readout consistent with a new compatible pack; matches invoice SLC-1188.", result: "observed" },
    [pdf("inspection-RC-2307.pdf", "inspection-report", "Independent inspection of battery", "ReCircuit Refurbishers - Inspection RC-2307", [`Device: ${b}`, "Battery: compatible 60Wh pack, 4 cycles", "Consistent with replacement record"], "shareable")],
  );
  await add("inspector", b, {
    type: "INSPECTION",
    claimedAt: "2025-03-18",
    category: "general",
    description: "Refurbishment inspection: grade B+, replaced battery confirmed, original SSD.",
    result: "pass",
    componentAssertions: [{ component: "battery", state: "replaced" }, { component: "storage", state: "original" }],
  });

  // ---------------------------------------------------------------- Device C (conflict + open dispute)
  const c = (await svc.registerDevice("registrar", { brand: "HP", model: "EliteBook 840 G5", year: 2019, formFactor: "laptop", synthetic: true })).publicId;
  await add(
    "repairer-a",
    c,
    { type: "DIAGNOSTIC", claimedAt: "2025-04-02", category: "battery", component: "battery", description: "Battery visibly swollen, lifting the touchpad. Unsafe; replacement required.", result: "fail", componentAssertions: [{ component: "battery", state: "original" }] },
    [{ name: "swollen-battery.svg", mime: "image/svg+xml", data: makeComponentSvg("Swollen battery at intake", "battery", `${c} - swollen pack lifting touchpad`), kind: "component-photo", description: "Intake photograph (synthetic drawing)" }],
  );
  await add(
    "repairer-a",
    c,
    { type: "COMPONENT_REPLACEMENT", claimedAt: "2025-04-03", component: "battery", partOrigin: "refurbished", description: "Replaced swollen battery with a refurbished pack.", result: "replaced" },
    // byte-identical to Device B's receipt: triggers the evidence-reuse warning
    [{ ...receipt, name: "receipt.pdf", description: "Component purchase receipt" }],
  );
  await add(
    "inspector",
    c,
    {
      type: "INSPECTION",
      claimedAt: "2025-04-20",
      category: "general",
      description: "Pre-sale inspection: OEM battery label intact; listed as 'original battery'. Grade A.",
      result: "pass",
      componentAssertions: [{ component: "battery", state: "original" }],
    },
    [pdf("inspection-RC-2350.pdf", "inspection-report", "Pre-sale inspection report", "ReCircuit Refurbishers - Inspection RC-2350", [`Device: ${c}`, "Battery: OEM label intact (listed as original)", "Grade: A"])],
  );
  await add("buyer", c, {
    type: "CHALLENGE",
    refSeq: 3,
    reason: "The listing and inspection #3 state the original battery, but record #2 says Kiran Bench Repairs replaced it with a refurbished pack. Requesting an independent audit before purchase.",
  });

  // ---------------------------------------------------------------- Device D (self-reported only)
  const d = (await svc.registerDevice("registrar", { brand: "Acer", model: "Aspire 5 A515", year: 2021, formFactor: "laptop", synthetic: true })).publicId;
  await add("repairer-b", d, { type: "REPAIR", claimedAt: "2025-05-06", category: "keyboard", component: "keyboard", description: "Cleaned liquid residue under keyboard; three sticky keys now respond.", result: "repaired" });

  return { straightforward: a, batteryReplacement: b, disputed: c, selfReported: d };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ctx = openContext();
  if (ctx.store.listDevices().length) {
    console.log("[seed] database already contains devices; skipping seed");
  } else {
    const ids = await seed(ctx.svc);
    fs.writeFileSync(path.join(ctx.cfg.dataDir, "seed-summary.json"), JSON.stringify({ seededAt: new Date().toISOString(), synthetic: true, devices: ids }, null, 2));
    const stats = await ctx.ledger.stats();
    console.log(`[seed] synthetic demo data committed: ${stats.devices} devices, ${stats.records} on-chain records, ${stats.openDisputes} open dispute(s)`);
    console.log(`[seed] ${JSON.stringify(ids)}`);
  }
  ctx.store.close();
  ctx.ledger.provider.destroy();
}
