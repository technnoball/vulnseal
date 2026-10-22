// Shared domain vocabulary: record types, roles, outcomes and demo identities.

export const ROLE = { REGISTRAR: 1, REPAIRER: 2, INSPECTOR: 4, VERIFIER: 8, AUDITOR: 16 } as const;
export type RoleName = keyof typeof ROLE;

export const RECORD_TYPES = [
  "REGISTRATION",
  "DIAGNOSTIC",
  "REPAIR",
  "COMPONENT_REPLACEMENT",
  "INSPECTION",
  "CUSTODY_TRANSFER",
  "EVIDENCE_ATTACHMENT",
  "CORROBORATION",
  "CHALLENGE",
  "RESOLUTION",
  "CORRECTION",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export const typeCode = (t: RecordType): number => RECORD_TYPES.indexOf(t);
export const typeName = (code: number): RecordType => {
  const t = RECORD_TYPES[code];
  if (!t) throw new Error(`unknown record type code ${code}`);
  return t;
};

export const RECORD_TYPE_LABEL: Record<RecordType, string> = {
  REGISTRATION: "Registration",
  DIAGNOSTIC: "Diagnostic",
  REPAIR: "Repair",
  COMPONENT_REPLACEMENT: "Component replacement",
  INSPECTION: "Inspection",
  CUSTODY_TRANSFER: "Custody transfer",
  EVIDENCE_ATTACHMENT: "Evidence attachment",
  CORROBORATION: "Corroboration",
  CHALLENGE: "Challenge",
  RESOLUTION: "Dispute resolution",
  CORRECTION: "Correction",
};

/** Records that assert something about the device (i.e. can be challenged). */
export const isClaimType = (t: RecordType) => t !== "CHALLENGE" && t !== "RESOLUTION";
/** Records that need a reference to an earlier record. */
export const REF_TYPES: RecordType[] = ["EVIDENCE_ATTACHMENT", "CORROBORATION", "CHALLENGE", "RESOLUTION", "CORRECTION"];
/** Free-standing claims created from the "new event" form. */
export const EVENT_FORM_TYPES: RecordType[] = ["DIAGNOSTIC", "REPAIR", "COMPONENT_REPLACEMENT", "INSPECTION", "CUSTODY_TRANSFER"];

export const OUTCOMES = ["NONE", "CLAIM_UPHELD", "CLAIM_REJECTED", "INCONCLUSIVE"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_LABEL: Record<Outcome, string> = {
  NONE: "—",
  CLAIM_UPHELD: "Claim upheld (challenge dismissed)",
  CLAIM_REJECTED: "Claim rejected (challenge upheld)",
  INCONCLUSIVE: "Inconclusive",
};

export const COMPONENTS = ["battery", "storage", "memory", "display", "keyboard", "motherboard", "hinge", "charger", "fan", "other"] as const;
export type Component = (typeof COMPONENTS)[number];

export const EVIDENCE_KINDS = [
  "battery-diagnostic",
  "repair-invoice",
  "component-photo",
  "inspection-report",
  "purchase-receipt",
  "other",
] as const;

export interface Identity {
  id: string;
  index: number; // HD-wallet index of the well-known Hardhat development mnemonic
  label: string;
  description: string;
  roles: RoleName[];
}

/** Fictional demonstration identities. Keys are derived from the public Hardhat
 * test mnemonic and must never be used on any public network. */
export const IDENTITIES: Identity[] = [
  { id: "registrar", index: 0, label: "Registry Desk", description: "Registrar / administrator (fictional)", roles: ["REGISTRAR"] },
  { id: "repairer-a", index: 1, label: "Kiran Bench Repairs", description: "Independent repair technician (fictional)", roles: ["REPAIRER"] },
  { id: "repairer-b", index: 2, label: "Sahyadri Laptop Clinic", description: "Independent repair technician (fictional)", roles: ["REPAIRER"] },
  { id: "inspector", index: 3, label: "ReCircuit Refurbishers", description: "Refurbisher / inspection provider (fictional)", roles: ["INSPECTOR"] },
  { id: "buyer", index: 4, label: "Demo Buyer", description: "Buyer / public verifier (fictional)", roles: ["VERIFIER"] },
  { id: "auditor", index: 5, label: "Open Audit Collective", description: "Independent auditor / dispute resolver (fictional)", roles: ["AUDITOR"] },
  { id: "outsider", index: 6, label: "Unregistered Account", description: "Holds no role — used to show on-chain rejection", roles: [] },
];

export const HARDHAT_TEST_MNEMONIC = "test test test test test test test test test test test junk";

export function identityById(id: string | undefined): Identity | undefined {
  return IDENTITIES.find((i) => i.id === id);
}
