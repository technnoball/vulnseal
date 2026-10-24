// Vocabulary shared by the server, scripts and tests. Numbers mirror VulnSeal.sol.

export const ROLE = { RESEARCHER: 1, PROGRAM_ADMIN: 2, REVIEWER: 4, ARBITRATOR: 8, AUDITOR: 16 } as const;
export type RoleName = keyof typeof ROLE;

export const STATUS = ["", "anchored", "acknowledged", "reveal requested", "revealed", "pending triage", "needs info", "valid", "invalid", "finalized"] as const;
export const ST = { ANCHORED: 1, ACKNOWLEDGED: 2, REVEAL_REQUESTED: 3, REVEALED: 4, PENDING_TRIAGE: 5, NEEDS_INFO: 6, VALID: 7, INVALID: 8, FINALIZED: 9 } as const;
export const TRIAGE_TARGETS = { "pending-triage": ST.PENDING_TRIAGE, "needs-info": ST.NEEDS_INFO, valid: ST.VALID, invalid: ST.INVALID } as const;

export const REVEAL = { MATCH: 1, MISMATCH: 2, MISSING: 3, BAD_ENCODING: 4 } as const;
export const REVEAL_NAMES = ["", "match", "mismatch", "missing", "invalid-encoding"] as const;
export type RevealOutcome = "match" | "mismatch" | "missing" | "invalid-encoding";

export const RELATION = { SAME_ISSUE: 1, RELATED: 2, DISTINCT: 3 } as const;
export const RELATION_NAMES = ["", "same issue", "related, distinct", "distinct"] as const;
export const ASSOC_STATUS = ["", "proposed", "confirmed", "rejected", "disputed", "upheld", "overturned"] as const;

export const DISPUTE_KIND = { RELATIONSHIP: 1, PRIORITY: 2, VALIDITY: 3 } as const;
export const DISPUTE_KIND_NAMES = ["", "relationship", "priority", "validity"] as const;
export const DISPUTE_STATUS = ["", "open", "decided", "appealed", "final"] as const;

export const DECISION = {
  UPHOLD: 1,
  SAME_ISSUE: 2,
  RELATED: 3,
  DISTINCT: 4,
  PRIORITY_FIRST: 5,
  PRIORITY_SECOND: 6,
  SHARED: 7,
  VALID: 8,
  INVALID: 9,
  INCONCLUSIVE: 10,
} as const;
export const DECISION_NAMES: Record<number, string> = {
  1: "uphold the recorded outcome",
  2: "same underlying issue",
  3: "related but distinct",
  4: "distinct issues",
  5: "priority to the first report",
  6: "priority to the second report",
  7: "shared priority",
  8: "report is valid",
  9: "report is invalid",
  10: "inconclusive",
};
export const DECISIONS_FOR_KIND: Record<number, number[]> = {
  1: [1, 2, 3, 4, 10],
  2: [5, 6, 7, 4, 10],
  3: [1, 8, 9, 10],
};

/** Reason codes refer to clauses of the fictional shared policy (see docs/commitment-protocol.md). */
export const REASON_CODES: Record<number, string> = {
  100: "Earlier commitment, reveal matched, reproducible",
  110: "Earlier report incomplete when committed; later report first actionable",
  120: "Same root cause and same fix",
  130: "Different root cause or different fix",
  140: "Out of scope under the applicable policy version",
  150: "Not reproducible with the revealed steps",
  160: "Insufficient evidence to decide",
  170: "Reviewer decision stands",
};

export const LOG_KINDS: Record<number, string> = {
  1: "program registered",
  2: "policy published",
  3: "participant registered",
  4: "commitment anchored",
  5: "revision anchored",
  6: "acknowledged",
  7: "reveal requested",
  8: "reveal checked",
  9: "triage",
  10: "disclosure granted",
  11: "association proposed",
  12: "association reviewed",
  13: "dispute opened",
  14: "vote",
  15: "recusal",
  16: "decision",
  17: "appeal",
  18: "dispute closed",
  19: "disposition",
  20: "audit attestation",
};

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export interface ProgramDef {
  id: number;
  slug: string;
  name: string;
  short: string;
  blurb: string;
}

/** Fictional programs. Policy texts live in scripts/fixtures and are hashed at init. */
export const PROGRAMS: ProgramDef[] = [
  { id: 1, slug: "ashgrove", name: "Ashgrove Payments", short: "Program A", blurb: "Card checkout and merchant dashboard" },
  { id: 2, slug: "kestrel", name: "Kestrel Cloud", short: "Program B", blurb: "Hosted object storage and console" },
  { id: 3, slug: "tamarind", name: "Tamarind Mobile", short: "Program C", blurb: "Consumer banking app (iOS, Android)" },
];

export type IdentityKind = "governor" | "researcher" | "program-admin" | "reviewer" | "arbitrator" | "auditor" | "outsider";

export interface IdentityDef {
  id: string;
  label: string;
  kind: IdentityKind;
  roles: RoleName[];
  programId: number; // affiliation, 0 = none
  note?: string;
}

export const IDENTITY_DEFS: IdentityDef[] = [
  { id: "governor", label: "Consortium desk", kind: "governor", roles: [], programId: 0, note: "registers programs and participants" },
  { id: "basalt", label: "basalt", kind: "researcher", roles: ["RESEARCHER"], programId: 0 },
  { id: "quillfox", label: "quillfox", kind: "researcher", roles: ["RESEARCHER"], programId: 0 },
  { id: "nightjar", label: "nightjar", kind: "researcher", roles: ["RESEARCHER"], programId: 0 },
  { id: "ashgrove-admin", label: "Ashgrove admin", kind: "program-admin", roles: ["PROGRAM_ADMIN"], programId: 1 },
  { id: "ashgrove-triage", label: "Ashgrove triage", kind: "reviewer", roles: ["REVIEWER"], programId: 1 },
  { id: "kestrel-admin", label: "Kestrel admin", kind: "program-admin", roles: ["PROGRAM_ADMIN"], programId: 2 },
  { id: "kestrel-triage", label: "Kestrel triage", kind: "reviewer", roles: ["REVIEWER"], programId: 2 },
  { id: "tamarind-admin", label: "Tamarind admin", kind: "program-admin", roles: ["PROGRAM_ADMIN"], programId: 3 },
  { id: "tamarind-triage", label: "Tamarind triage", kind: "reviewer", roles: ["REVIEWER"], programId: 3 },
  { id: "arb-holm", label: "Arbitrator Holm", kind: "arbitrator", roles: ["ARBITRATOR"], programId: 0 },
  { id: "arb-okafor", label: "Arbitrator Okafor", kind: "arbitrator", roles: ["ARBITRATOR"], programId: 0 },
  { id: "arb-vance", label: "Arbitrator Vance", kind: "arbitrator", roles: ["ARBITRATOR"], programId: 0 },
  { id: "arb-sato", label: "Arbitrator Sato", kind: "arbitrator", roles: ["ARBITRATOR"], programId: 0 },
  { id: "arb-reyes", label: "Arbitrator Reyes", kind: "arbitrator", roles: ["ARBITRATOR"], programId: 1, note: "affiliated with Ashgrove" },
  { id: "auditor", label: "Consortium auditor", kind: "auditor", roles: ["AUDITOR"], programId: 0 },
  { id: "outsider", label: "Unregistered visitor", kind: "outsider", roles: [], programId: 0 },
];

export const roleMask = (roles: RoleName[]) => roles.reduce((m, r) => m | ROLE[r], 0);
export const identityDef = (id: string | undefined) => IDENTITY_DEFS.find((i) => i.id === id);
export const programDef = (id: number) => PROGRAMS.find((p) => p.id === id);
export const reportRef = (cid: number) => `VS-${String(cid).padStart(4, "0")}`;
