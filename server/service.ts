// Domain service: builds canonical payloads, commits them to the chain, stores
// details off-chain, and derives evidence status, conflicts and integrity
// findings from the combination of both.
import { randomBytes } from "node:crypto";
import { canonicalize, payloadDigest } from "./canonical.ts";
import { Ledger, LedgerError, type OnChainRecord, type WriteResult } from "./chain.ts";
import { Store, type DeviceRow, type EventRow, type EvidenceRow } from "./db.ts";
import {
  COMPONENTS,
  EVIDENCE_KINDS,
  IDENTITIES,
  OUTCOMES,
  OUTCOME_LABEL,
  RECORD_TYPES,
  RECORD_TYPE_LABEL,
  REF_TYPES,
  identityById,
  isClaimType,
  typeCode,
  typeName,
  type Outcome,
  type RecordType,
} from "./domain.ts";
import { ALLOWED_MIME, EvidenceVault, MAX_EVIDENCE_BYTES, randomCode, type IntegrityResult } from "./evidence.ts";
import { computeRecordHash, deviceKeyFor, NO_REF, ZERO_HASH } from "./ledger-hash.ts";

export class ServiceError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status = 400, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const CATEGORIES = [
  "battery",
  "power",
  "storage",
  "memory",
  "display",
  "keyboard",
  "thermal",
  "board-level",
  "chassis",
  "software",
  "general",
] as const;
export const RESULTS = ["pass", "fail", "repaired", "replaced", "partial", "not-repaired", "observed"] as const;
export const PART_ORIGINS = ["new-oem", "new-compatible", "refurbished", "salvaged", "unknown"] as const;
export const FORM_FACTORS = ["laptop", "2-in-1", "ultrabook", "workstation", "chromebook"] as const;

export type Category =
  | "self-reported"
  | "evidence-attached"
  | "corroborated"
  | "disputed"
  | "superseded"
  | "evidence-failed"
  | "dispute-record";

export const CATEGORY_LABEL: Record<Category, string> = {
  "self-reported": "Self-reported",
  "evidence-attached": "Evidence attached",
  corroborated: "Independently corroborated",
  disputed: "Disputed",
  superseded: "Corrected / superseded",
  "evidence-failed": "Evidence integrity failed",
  "dispute-record": "Dispute record",
};

export interface EventInput {
  type: string;
  claimedAt?: string;
  category?: string;
  description?: string;
  component?: string;
  result?: string;
  partOrigin?: string;
  componentAssertions?: { component: string; state: string }[];
  measurements?: Record<string, number | string>;
  fromParty?: string;
  toParty?: string;
  evidenceIds?: string[];
  refSeq?: number;
  outcome?: string;
  reason?: string;
  expectedPrevHash?: string;
}

export interface DeviceInput {
  brand: string;
  model: string;
  year?: number;
  formFactor?: string;
  synthetic?: boolean;
}

// ---------------------------------------------------------------------------
// validation helpers
// ---------------------------------------------------------------------------
function str(v: unknown, name: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new ServiceError(`${name} is required`, 422);
    return undefined;
  }
  if (typeof v !== "string") throw new ServiceError(`${name} must be text`, 422);
  const t = v.trim();
  if (opts.required && !t) throw new ServiceError(`${name} is required`, 422);
  if (t.length > (opts.max ?? 2000)) throw new ServiceError(`${name} must be at most ${opts.max ?? 2000} characters`, 422);
  return t || undefined;
}
function oneOf<T extends string>(v: unknown, list: readonly T[], name: string, required = false): T | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ServiceError(`${name} is required`, 422);
    return undefined;
  }
  if (!list.includes(v as T)) throw new ServiceError(`${name} must be one of: ${list.join(", ")}`, 422);
  return v as T;
}
function isoDate(v: unknown, name: string): string | undefined {
  const s = str(v, name, { max: 10 });
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T00:00:00Z"))) throw new ServiceError(`${name} must be a date (YYYY-MM-DD)`, 422);
  if (Date.parse(s + "T00:00:00Z") > Date.now() + 86_400_000) throw new ServiceError(`${name} cannot be in the future`, 422);
  return s;
}

const nowIso = () => new Date().toISOString();
const nonce = () => randomBytes(16).toString("hex");

export function newPublicId(): string {
  return `PL-${randomCode(4)}-${randomCode(4)}`;
}

// ---------------------------------------------------------------------------
// derived views
// ---------------------------------------------------------------------------
export interface EvidenceView {
  id: string;
  kind: string;
  sha256: string;
  mime: string;
  size: number;
  filename: string;
  description: string;
  uploadedBy: { id: string; label: string };
  access: string;
  committedInSeq: number;
  committedSha256: string;
  integrity: IntegrityResult["status"] | "commitment-mismatch" | "unknown-evidence";
  canViewContent: boolean;
  reusedElsewhere: { id: string; publicId: string; seq: number | null }[];
}

export interface EventView {
  seq: number;
  type: RecordType;
  typeLabel: string;
  payload: Record<string, any>;
  claimedAt: string | null;
  recordedAt: string;
  actor: { id: string; label: string; description: string; address: string };
  recordHash: string;
  prevHash: string;
  payloadDigest: string;
  txHash: string;
  blockNumber: number;
  gasUsed: number;
  refSeq: number | null;
  outcome: Outcome;
  outcomeLabel: string;
  evidence: EvidenceView[];
  category: Category;
  categoryLabel: string;
  flags: string[];
  openChallengeSeq: number | null;
  challenges: { seq: number; resolvedBySeq: number | null; outcome: Outcome | null }[];
  supersededBySeq: number | null;
  corroboratedBySeqs: number[];
  anchor: "anchored" | "digest-mismatch" | "hash-mismatch" | "payload-not-canonical" | "not-on-chain" | "chain-unavailable";
}

export interface Conflict {
  component: string;
  replacedSeq: number;
  assertedOriginalSeq: number;
  status: "open" | "addressed";
  note: string;
}

export interface Finding {
  severity: "error" | "warning" | "info";
  code: string;
  seq?: number;
  evidenceId?: string;
  message: string;
}

export interface IntegrityReport {
  publicId: string;
  deviceKey: string;
  checkedAt: string;
  ok: boolean;
  chain: { contract: string; chainId: number; onChainRecords: number; offChainRecords: number; headHash: string | null; contractVerifyChain: boolean | null };
  evidenceChecked: number;
  findings: Finding[];
}

export class PatchLedgerService {
  readonly store: Store;
  readonly ledger: Ledger;
  readonly vault: EvidenceVault;

  constructor(store: Store, ledger: Ledger, vault: EvidenceVault) {
    this.store = store;
    this.ledger = ledger;
    this.vault = vault;
  }

  // -- identities ------------------------------------------------------------
  identityByAddress(address: string) {
    const a = address.toLowerCase();
    const id = IDENTITIES.find((i) => this.ledger.addressOf(i.id).toLowerCase() === a);
    return id
      ? { id: id.id, label: id.label, description: id.description, address }
      : { id: "unknown", label: "Unknown account", description: "Address not in the demo identity table", address };
  }

  async identities() {
    return Promise.all(
      IDENTITIES.map(async (i) => {
        const address = this.ledger.addressOf(i.id);
        let onChainRoleMask: number | null = null;
        try {
          onChainRoleMask = await this.ledger.roleMask(address);
        } catch {
          /* chain down: still list identities */
        }
        return { ...i, address, onChainRoleMask };
      }),
    );
  }

  private requireActor(actorId: string | undefined): string {
    if (!actorId || !identityById(actorId)) throw new ServiceError("Select a demonstration identity first (X-Demo-Actor header missing or unknown).", 401);
    return actorId;
  }

  private requireDevice(publicId: string): DeviceRow {
    const d = this.store.getDevice(publicId);
    if (!d) throw new ServiceError(`Device ${publicId} not found`, 404);
    return d;
  }

  // -- writes ----------------------------------------------------------------
  async registerDevice(actorId: string | undefined, input: DeviceInput) {
    const actor = this.requireActor(actorId);
    const brand = str(input.brand, "Brand", { required: true, max: 40 })!;
    const model = str(input.model, "Model", { required: true, max: 60 })!;
    const formFactor = oneOf(input.formFactor ?? "laptop", FORM_FACTORS, "Form factor", true)!;
    let year: number | undefined;
    if (input.year !== undefined && input.year !== null && String(input.year) !== "") {
      year = Number(input.year);
      if (!Number.isInteger(year) || year < 1990 || year > new Date().getFullYear() + 1) throw new ServiceError("Year must be a valid model year", 422);
    }
    const publicId = newPublicId();
    const deviceKey = deviceKeyFor(publicId);
    const payload = {
      schema: "patchledger.registration.v1",
      type: "REGISTRATION",
      device: publicId,
      brand,
      model,
      year,
      formFactor,
      synthetic: input.synthetic ? true : undefined,
      nonce: nonce(),
    };
    const canonical = canonicalize(payload);
    const digest = payloadDigest(canonical);
    const res = await this.ledger.registerDevice(actor, deviceKey, digest);
    const created = nowIso();
    this.store.transaction(() => {
      this.store.insertDevice({
        public_id: publicId,
        device_key: deviceKey,
        brand,
        model,
        year: year ?? null,
        form_factor: formFactor,
        synthetic: input.synthetic ? 1 : 0,
        created_at: created,
      });
      this.insertEventRow(publicId, "REGISTRATION", canonical, digest, actor, res, null, 0);
    });
    return { publicId, deviceKey, tx: res };
  }

  private insertEventRow(publicId: string, type: RecordType, canonical: string, digest: string, actor: string, res: WriteResult, refSeq: number | null, outcome: number) {
    this.store.insertEvent({
      public_id: publicId,
      seq: res.seq,
      type,
      payload: canonical,
      payload_digest: digest,
      record_hash: res.recordHash,
      prev_hash: res.prevHash,
      actor_address: this.ledger.addressOf(actor),
      actor_id: actor,
      ref_seq: refSeq,
      outcome,
      chain_ts: res.timestamp,
      tx_hash: res.txHash,
      block_number: res.blockNumber,
      gas_used: res.gasUsed,
      created_at: nowIso(),
    });
  }

  uploadEvidence(
    actorId: string | undefined,
    publicId: string,
    file: { buffer: Uint8Array; originalname: string; mimetype: string } | undefined,
    meta: { kind?: string; description?: string; access?: string },
  ) {
    const actor = this.requireActor(actorId);
    this.requireDevice(publicId);
    if (!file) throw new ServiceError("No file was uploaded", 422);
    if (!ALLOWED_MIME.has(file.mimetype)) throw new ServiceError(`File type ${file.mimetype} is not accepted. Allowed: PDF, PNG, JPEG, WebP, SVG, text, CSV, JSON.`, 415);
    if (file.buffer.byteLength === 0) throw new ServiceError("The uploaded file is empty", 422);
    if (file.buffer.byteLength > MAX_EVIDENCE_BYTES) throw new ServiceError("Evidence files are limited to 10 MB", 413);
    const kind = oneOf(meta.kind ?? "other", EVIDENCE_KINDS, "Evidence kind", true)!;
    const description = str(meta.description, "Evidence description", { max: 300 }) ?? "";
    const access = oneOf(meta.access ?? "restricted", ["restricted", "shareable"] as const, "Access", true)!;
    const filename = (file.originalname || "evidence").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    const id = `EV-${randomCode(10)}`;
    const { storedName, sha256, size } = this.vault.store(id, file.mimetype, file.buffer);
    const prior = this.store.evidenceBySha(sha256);
    const row: EvidenceRow = {
      id,
      public_id: publicId,
      filename,
      stored_name: storedName,
      mime: file.mimetype,
      size,
      sha256,
      kind,
      description,
      uploaded_by: actor,
      access,
      linked_seq: null,
      created_at: nowIso(),
    };
    this.store.insertEvidence(row);
    const warnings = prior.length
      ? [
          `Digest reuse warning: an identical file (SHA-256 ${sha256.slice(0, 12)}…) was already submitted as ${prior
            .map((p) => `${p.id} for ${p.public_id}${p.linked_seq !== null ? ` record #${p.linked_seq}` : ""}`)
            .join(", ")}. Re-using one document for several claims may indicate a recycled or copied receipt.`,
        ]
      : [];
    return { evidence: this.evidenceView(row, actor, -1, sha256), warnings };
  }

  async appendEvent(actorId: string | undefined, publicId: string, input: EventInput) {
    const actor = this.requireActor(actorId);
    const device = this.requireDevice(publicId);
    const type = input.type as RecordType;
    if (!RECORD_TYPES.includes(type) || type === "REGISTRATION") throw new ServiceError(`Unsupported record type "${input.type}"`, 422);

    const rows = this.store.listEvents(publicId);
    let ref: EventRow | undefined;
    if (REF_TYPES.includes(type)) {
      if (input.refSeq === undefined || input.refSeq === null || !Number.isInteger(Number(input.refSeq)))
        throw new ServiceError(`${RECORD_TYPE_LABEL[type]} must reference an earlier record`, 422);
      ref = rows.find((r) => r.seq === Number(input.refSeq));
      if (!ref) throw new ServiceError(`Record #${input.refSeq} does not exist for ${publicId}`, 422);
    } else if (input.refSeq !== undefined && input.refSeq !== null) {
      throw new ServiceError(`${RECORD_TYPE_LABEL[type]} records cannot reference another record`, 422);
    }

    // evidence: must exist, belong to this device, be unlinked and uploaded by the submitter
    const evIds = [...new Set(input.evidenceIds ?? [])];
    if (evIds.length > 10) throw new ServiceError("At most 10 evidence files per record", 422);
    const evRows = evIds.map((id) => {
      const e = this.store.getEvidence(id);
      if (!e || e.public_id !== publicId) throw new ServiceError(`Evidence ${id} not found for this device`, 422);
      if (e.linked_seq !== null) throw new ServiceError(`Evidence ${id} is already committed in record #${e.linked_seq}`, 409);
      if (e.uploaded_by !== actor) throw new ServiceError(`Evidence ${id} was uploaded by another identity; each party commits its own evidence`, 403);
      const check = this.vault.verify(e.stored_name, e.sha256);
      if (check.status !== "match") throw new ServiceError(`Evidence ${id} failed its integrity check (${check.status}); refusing to commit it`, 409);
      return e;
    });
    if (type === "EVIDENCE_ATTACHMENT" && evRows.length === 0) throw new ServiceError("Attach at least one evidence file", 422);

    const payload = this.buildPayload(device, type, input, evRows, ref);
    const canonical = canonicalize(payload);
    const digest = payloadDigest(canonical);
    const outcome = type === "RESOLUTION" ? OUTCOMES.indexOf(payload.outcome as Outcome) : 0;
    const expected = input.expectedPrevHash ? str(input.expectedPrevHash, "expectedPrevHash", { max: 66 }) : undefined;

    const res = await this.ledger.appendRecord(actor, {
      deviceKey: device.device_key,
      recordType: typeCode(type),
      expectedPrevHash: expected,
      payloadDigest: digest,
      refSeq: ref ? ref.seq : NO_REF,
      outcome,
    });
    this.store.transaction(() => {
      this.insertEventRow(publicId, type, canonical, digest, actor, res, ref ? ref.seq : null, outcome);
      this.store.linkEvidence(evIds, res.seq);
    });
    const warnings = evRows.flatMap((e) =>
      this.store.evidenceBySha(e.sha256).filter((o) => o.id !== e.id).length
        ? [`Evidence ${e.id} has the same digest as a file submitted elsewhere — flagged as reused.`]
        : [],
    );
    return { seq: res.seq, recordHash: res.recordHash, tx: res, warnings };
  }

  private buildPayload(device: DeviceRow, type: RecordType, input: EventInput, evRows: EvidenceRow[], ref?: EventRow): Record<string, unknown> {
    const base: Record<string, unknown> = {
      schema: "patchledger.event.v1",
      type,
      device: device.public_id,
      nonce: nonce(),
      evidence: evRows.map((e) => ({ id: e.id, kind: e.kind, sha256: e.sha256 })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
    if (ref) base.ref = { seq: ref.seq, recordHash: ref.record_hash, type: ref.type };
    const assertions = () =>
      (input.componentAssertions ?? []).slice(0, 12).map((a) => ({
        component: oneOf(a.component, COMPONENTS, "Asserted component", true)!,
        state: oneOf(a.state, ["original", "replaced"] as const, "Asserted state", true)!,
      }));
    const measurements = () => {
      if (!input.measurements) return undefined;
      const out: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(input.measurements).slice(0, 12)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) throw new ServiceError(`Invalid measurement name "${k}"`, 422);
        if (typeof v === "number") {
          if (!Number.isSafeInteger(v)) throw new ServiceError(`Measurement ${k} must be an integer (record decimals as text)`, 422);
          out[k] = v;
        } else out[k] = str(v, `Measurement ${k}`, { max: 60 }) ?? "";
      }
      return Object.keys(out).length ? out : undefined;
    };
    const claimedAt = isoDate(input.claimedAt, "Date performed");

    switch (type) {
      case "DIAGNOSTIC":
        return {
          ...base,
          claimedAt,
          category: oneOf(input.category, CATEGORIES, "Category", true),
          component: oneOf(input.component, COMPONENTS, "Component"),
          description: str(input.description, "Description", { required: true, max: 1500 }),
          result: oneOf(input.result, RESULTS, "Result", true),
          componentAssertions: assertions(),
          measurements: measurements(),
        };
      case "REPAIR":
        return {
          ...base,
          claimedAt,
          category: oneOf(input.category, CATEGORIES, "Category", true),
          component: oneOf(input.component, COMPONENTS, "Component"),
          description: str(input.description, "Description", { required: true, max: 1500 }),
          result: oneOf(input.result, RESULTS, "Result", true),
          componentAssertions: assertions(),
        };
      case "COMPONENT_REPLACEMENT": {
        const component = oneOf(input.component, COMPONENTS, "Component", true)!;
        return {
          ...base,
          claimedAt,
          category: oneOf(input.category, CATEGORIES, "Category") ?? (component === "battery" ? "battery" : "general"),
          component,
          partOrigin: oneOf(input.partOrigin, PART_ORIGINS, "Part origin", true),
          description: str(input.description, "Description", { required: true, max: 1500 }),
          result: oneOf(input.result ?? "replaced", RESULTS, "Result", true),
          componentAssertions: [{ component, state: "replaced" }],
        };
      }
      case "INSPECTION":
        return {
          ...base,
          claimedAt,
          category: oneOf(input.category ?? "general", CATEGORIES, "Category", true),
          description: str(input.description, "Description", { required: true, max: 1500 }),
          result: oneOf(input.result, RESULTS, "Result", true),
          componentAssertions: assertions(),
          measurements: measurements(),
        };
      case "CUSTODY_TRANSFER":
        return {
          ...base,
          claimedAt,
          fromParty: str(input.fromParty, "From (organisation or role)", { required: true, max: 80 }),
          toParty: str(input.toParty, "To (organisation or role)", { required: true, max: 80 }),
          description: str(input.description, "Note", { max: 500 }),
        };
      case "EVIDENCE_ATTACHMENT":
        return { ...base, description: str(input.description, "Description", { max: 500 }) };
      case "CORROBORATION":
        return {
          ...base,
          claimedAt,
          description: str(input.description, "Corroboration note", { required: true, max: 1000 }),
          result: oneOf(input.result ?? "observed", RESULTS, "Result", true),
        };
      case "CHALLENGE":
        return { ...base, reason: str(input.reason, "Reason for the challenge", { required: true, max: 1500 }) };
      case "RESOLUTION": {
        if (ref?.type !== "CHALLENGE") throw new ServiceError("A resolution must reference a challenge record", 422);
        const outcome = oneOf(input.outcome, ["CLAIM_UPHELD", "CLAIM_REJECTED", "INCONCLUSIVE"] as const, "Outcome", true);
        return { ...base, outcome, reason: str(input.reason, "Resolution reasoning", { required: true, max: 1500 }) };
      }
      case "CORRECTION":
        return {
          ...base,
          reason: str(input.reason, "What is being corrected and why", { required: true, max: 1000 }),
          corrected: {
            description: str(input.description, "Corrected description", { max: 1500 }),
            component: oneOf(input.component, COMPONENTS, "Component"),
            result: oneOf(input.result, RESULTS, "Result"),
            componentAssertions: assertions(),
          },
        };
      default:
        throw new ServiceError(`Unsupported record type ${type}`, 422);
    }
  }

  // -- reads -----------------------------------------------------------------
  listDevices() {
    return this.store.listDevices().map((d) => {
      const evs = this.store.listEvents(d.public_id);
      const open = this.openChallengeSeqs(evs);
      return {
        publicId: d.public_id,
        brand: d.brand,
        model: d.model,
        year: d.year,
        formFactor: d.form_factor,
        synthetic: !!d.synthetic,
        records: evs.length,
        openDisputes: open.size,
        lastRecordedAt: evs.length ? new Date(evs[evs.length - 1].chain_ts * 1000).toISOString() : null,
      };
    });
  }

  private openChallengeSeqs(evs: EventRow[]): Set<number> {
    const resolved = new Set(evs.filter((e) => e.type === "RESOLUTION").map((e) => e.ref_seq));
    return new Set(evs.filter((e) => e.type === "CHALLENGE" && !resolved.has(e.seq)).map((e) => e.seq));
  }

  canViewEvidence(viewer: string | undefined, e: EvidenceRow): boolean {
    if (!viewer || !identityById(viewer)) return false;
    if (viewer === e.uploaded_by || viewer === "auditor" || viewer === "registrar" || viewer === "inspector") return true;
    return e.access === "shareable" && viewer !== "outsider";
  }

  private evidenceView(e: EvidenceRow | undefined, viewer: string | undefined, seq: number, committedSha: string, ref?: { id: string; kind: string }): EvidenceView {
    if (!e) {
      return {
        id: ref?.id ?? "?",
        kind: ref?.kind ?? "other",
        sha256: committedSha,
        mime: "",
        size: 0,
        filename: "",
        description: "",
        uploadedBy: { id: "unknown", label: "unknown" },
        access: "restricted",
        committedInSeq: seq,
        committedSha256: committedSha,
        integrity: "unknown-evidence",
        canViewContent: false,
        reusedElsewhere: [],
      };
    }
    const check = this.vault.verify(e.stored_name, e.sha256);
    const uploader = identityById(e.uploaded_by);
    return {
      id: e.id,
      kind: e.kind,
      sha256: e.sha256,
      mime: e.mime,
      size: e.size,
      filename: e.filename,
      description: e.description,
      uploadedBy: { id: e.uploaded_by, label: uploader?.label ?? e.uploaded_by },
      access: e.access,
      committedInSeq: seq,
      committedSha256: committedSha,
      integrity: committedSha !== e.sha256 ? "commitment-mismatch" : check.status,
      canViewContent: this.canViewEvidence(viewer, e),
      reusedElsewhere: this.store
        .evidenceBySha(e.sha256)
        .filter((o) => o.id !== e.id)
        .map((o) => ({ id: o.id, publicId: o.public_id, seq: o.linked_seq })),
    };
  }

  /** Build the decorated timeline from off-chain rows and (if reachable) the chain. */
  async getPassport(publicId: string, viewer?: string) {
    const device = this.requireDevice(publicId);
    const rows = this.store.listEvents(publicId);
    let chainRecs: OnChainRecord[] | null = null;
    let chainError: string | null = null;
    try {
      chainRecs = await this.ledger.getRecords(device.device_key);
    } catch (e) {
      chainError = (e as Error).message;
    }
    const events = this.decorate(rows, chainRecs, viewer);
    const conflicts = detectConflicts(events);
    for (const c of conflicts) {
      if (c.status === "open") {
        for (const s of [c.replacedSeq, c.assertedOriginalSeq]) events[s]?.flags.push(`Conflicting claim about the ${c.component} (see records #${c.replacedSeq} and #${c.assertedOriginalSeq})`);
      }
    }
    const head = rows.length ? rows[rows.length - 1].record_hash : null;
    return {
      device: {
        publicId: device.public_id,
        deviceKey: device.device_key,
        brand: device.brand,
        model: device.model,
        year: device.year,
        formFactor: device.form_factor,
        synthetic: !!device.synthetic,
        createdAt: device.created_at,
      },
      headHash: head,
      onChainHeadHash: chainRecs && chainRecs.length ? chainRecs[chainRecs.length - 1].recordHash : null,
      onChainRecords: chainRecs?.length ?? null,
      chainError,
      events,
      conflicts,
      openDisputes: events.filter((e) => e.type === "CHALLENGE" && e.challenges.length === 0 && !events.some((r) => r.type === "RESOLUTION" && r.refSeq === e.seq)).length,
      pendingEvidence: this.store
        .evidenceForDevice(publicId)
        .filter((e) => e.linked_seq === null && (!viewer || e.uploaded_by === viewer))
        .map((e) => this.evidenceView(e, viewer, -1, e.sha256)),
    };
  }

  private decorate(rows: EventRow[], chainRecs: OnChainRecord[] | null, viewer?: string): EventView[] {
    const parsed = rows.map((r) => JSON.parse(r.payload) as Record<string, any>);
    const byRef = (type: RecordType, seq: number) => rows.filter((r) => r.type === type && r.ref_seq === seq);
    const contract = this.ledger.address;
    const chainId = this.ledger.chainId;

    const views: EventView[] = rows.map((r, i) => {
      const type = r.type as RecordType;
      const p = parsed[i];
      // anchor status
      let anchor: EventView["anchor"] = "chain-unavailable";
      if (chainRecs) {
        const c = chainRecs[r.seq];
        if (!c) anchor = "not-on-chain";
        else if (canonicalize(p) !== r.payload) anchor = "payload-not-canonical";
        else if (payloadDigest(r.payload) !== c.payloadDigest) anchor = "digest-mismatch";
        else if (r.record_hash !== c.recordHash) anchor = "hash-mismatch";
        else anchor = "anchored";
      }
      // evidence: own + attachments
      const evidence: EvidenceView[] = [];
      const collect = (payload: Record<string, any>, seq: number) => {
        for (const ev of (payload.evidence ?? []) as { id: string; kind: string; sha256: string }[]) {
          evidence.push(this.evidenceView(this.store.getEvidence(ev.id), viewer, seq, ev.sha256, ev));
        }
      };
      collect(p, r.seq);
      for (const a of byRef("EVIDENCE_ATTACHMENT", r.seq)) collect(parsed[a.seq], a.seq);

      const challenges = byRef("CHALLENGE", r.seq).map((c) => {
        const res = byRef("RESOLUTION", c.seq)[0];
        return { seq: c.seq, resolvedBySeq: res ? res.seq : null, outcome: res ? (OUTCOMES[res.outcome] as Outcome) : null };
      });
      const open = challenges.find((c) => c.resolvedBySeq === null);
      const correction = byRef("CORRECTION", r.seq)[0];
      const corroborations = byRef("CORROBORATION", r.seq).filter((c) => c.actor_address.toLowerCase() !== r.actor_address.toLowerCase());
      const flags: string[] = [];

      let category: Category;
      const evOk = evidence.length > 0 && evidence.every((e) => e.integrity === "match");
      const evBad = evidence.some((e) => e.integrity !== "match");
      if (!isClaimType(type)) category = "dispute-record";
      else if (open) category = "disputed";
      else if (correction) category = "superseded";
      else if (evBad) category = "evidence-failed";
      else if (
        corroborations.some((c) => {
          const cp = parsed[c.seq];
          return (cp.evidence ?? []).length > 0 && (cp.evidence as { id: string; sha256: string }[]).every((ev) => {
            const row = this.store.getEvidence(ev.id);
            return row && row.sha256 === ev.sha256 && this.vault.verify(row.stored_name, row.sha256).status === "match";
          });
        })
      )
        category = "corroborated";
      else if (evOk) category = "evidence-attached";
      else category = "self-reported";

      if (evBad) flags.push("One or more evidence files no longer match their committed SHA-256 digest");
      if (evidence.some((e) => e.reusedElsewhere.length)) flags.push("Evidence digest reused in another submission");
      const rejected = challenges.find((c) => c.outcome === "CLAIM_REJECTED");
      if (rejected) flags.push(`Auditor judged this claim inaccurate (resolution #${rejected.resolvedBySeq})`);
      if (corroborations.length && category !== "corroborated" && category !== "disputed" && category !== "superseded")
        flags.push("Corroborated without supporting evidence (acknowledgement only)");
      if (anchor !== "anchored" && anchor !== "chain-unavailable") flags.push(`Off-chain record does not match on-chain commitment (${anchor})`);

      return {
        seq: r.seq,
        type,
        typeLabel: RECORD_TYPE_LABEL[type],
        payload: p,
        claimedAt: (p.claimedAt as string) ?? null,
        recordedAt: new Date(r.chain_ts * 1000).toISOString(),
        actor: this.identityByAddress(r.actor_address),
        recordHash: r.record_hash,
        prevHash: r.prev_hash,
        payloadDigest: r.payload_digest,
        txHash: r.tx_hash,
        blockNumber: r.block_number,
        gasUsed: r.gas_used,
        refSeq: r.ref_seq,
        outcome: OUTCOMES[r.outcome] as Outcome,
        outcomeLabel: OUTCOME_LABEL[OUTCOMES[r.outcome] as Outcome],
        evidence,
        category,
        categoryLabel: CATEGORY_LABEL[category],
        flags,
        openChallengeSeq: open ? open.seq : null,
        challenges,
        supersededBySeq: correction ? correction.seq : null,
        corroboratedBySeqs: corroborations.map((c) => c.seq),
        anchor,
      };
    });
    // the chain may contain records with no off-chain row (e.g. deleted from the DB)
    if (chainRecs && chainRecs.length > rows.length) {
      // surfaced by the integrity checker; nothing to decorate here
    }
    return views;
  }

  /** Public, read-only view: structured fields only, no free text, filenames or file contents. */
  async getPublicView(publicId: string) {
    const passport = await this.getPassport(publicId, undefined);
    const integrity = await this.checkIntegrity(publicId);
    return {
      device: {
        publicId: passport.device.publicId,
        brand: passport.device.brand,
        model: passport.device.model,
        year: passport.device.year,
        formFactor: passport.device.formFactor,
        synthetic: passport.device.synthetic,
      },
      events: passport.events.map((e) => ({
        seq: e.seq,
        type: e.type,
        typeLabel: e.typeLabel,
        recordedAt: e.recordedAt,
        claimedAt: e.claimedAt,
        actorLabel: e.actor.label,
        actorRole: e.actor.description,
        category: e.payload.category ?? null,
        component: e.payload.component ?? null,
        result: e.payload.result ?? null,
        partOrigin: e.payload.partOrigin ?? null,
        outcome: e.type === "RESOLUTION" ? e.outcomeLabel : null,
        refSeq: e.refSeq,
        evidenceCategory: e.category,
        evidenceCategoryLabel: e.categoryLabel,
        openChallengeSeq: e.openChallengeSeq,
        supersededBySeq: e.supersededBySeq,
        flags: e.flags,
        anchor: e.anchor,
        recordHash: e.recordHash,
        evidence: e.evidence.map((v) => ({ kind: v.kind, sha256: v.sha256, integrity: v.integrity })),
      })),
      conflicts: passport.conflicts,
      openDisputes: passport.openDisputes,
      integrity: {
        ok: integrity.ok,
        checkedAt: integrity.checkedAt,
        errors: integrity.findings.filter((f) => f.severity === "error").length,
        warnings: integrity.findings.filter((f) => f.severity === "warning").length,
        findings: integrity.findings.map((f) => ({ severity: f.severity, code: f.code, seq: f.seq, message: f.message })),
        headHash: integrity.chain.headHash,
        contract: integrity.chain.contract,
      },
    };
  }

  getEvidenceDetail(id: string, viewer?: string) {
    const e = this.store.getEvidence(id);
    if (!e) throw new ServiceError(`Evidence ${id} not found`, 404);
    let committedSha = e.sha256;
    if (e.linked_seq !== null) {
      const row = this.store.listEvents(e.public_id).find((r) => r.seq === e.linked_seq);
      const ev = row ? ((JSON.parse(row.payload).evidence ?? []) as { id: string; sha256: string }[]).find((x) => x.id === id) : undefined;
      if (ev) committedSha = ev.sha256;
    }
    const view = this.evidenceView(e, viewer, e.linked_seq ?? -1, committedSha);
    return { ...view, publicId: e.public_id, linkedSeq: e.linked_seq, createdAt: e.created_at };
  }

  evidenceFile(id: string, viewer?: string): { path: string; mime: string; filename: string } {
    const e = this.store.getEvidence(id);
    if (!e) throw new ServiceError(`Evidence ${id} not found`, 404);
    if (!this.canViewEvidence(viewer, e))
      throw new ServiceError("Your current identity may see this evidence's metadata and digest, but not its contents.", 403);
    return { path: this.vault.pathOf(e.stored_name), mime: e.mime, filename: e.filename };
  }

  verifyEvidence(id: string) {
    const e = this.store.getEvidence(id);
    if (!e) throw new ServiceError(`Evidence ${id} not found`, 404);
    const file = this.vault.verify(e.stored_name, e.sha256);
    let commitment: { seq: number; committedSha256: string; matchesDatabase: boolean; onChainPayloadMatches: boolean | null } | null = null;
    if (e.linked_seq !== null) {
      const row = this.store.listEvents(e.public_id).find((r) => r.seq === e.linked_seq);
      const committed = row ? ((JSON.parse(row.payload).evidence ?? []) as { id: string; sha256: string }[]).find((x) => x.id === id) : undefined;
      commitment = {
        seq: e.linked_seq,
        committedSha256: committed?.sha256 ?? "",
        matchesDatabase: committed?.sha256 === e.sha256,
        onChainPayloadMatches: null,
      };
    }
    const fileMatchesCommitment = commitment ? file.actual === commitment.committedSha256 : null;
    return {
      evidenceId: id,
      file,
      commitment,
      fileMatchesCommitment,
      verdict:
        file.status === "match" && (commitment === null || commitment.matchesDatabase)
          ? "The stored file is byte-for-byte identical to the file originally submitted. This shows integrity, not that its contents are true."
          : file.status === "missing"
            ? "The evidence file is missing from local storage."
            : "The stored file or its recorded digest has changed since submission.",
    };
  }

  async verifyEvidenceOnChain(id: string) {
    const base = this.verifyEvidence(id);
    if (base.commitment) {
      const e = this.store.getEvidence(id)!;
      const device = this.store.getDevice(e.public_id)!;
      const row = this.store.listEvents(e.public_id).find((r) => r.seq === e.linked_seq)!;
      const recs = await this.ledger.getRecords(device.device_key);
      base.commitment.onChainPayloadMatches = recs[row.seq]?.payloadDigest === payloadDigest(row.payload);
    }
    return base;
  }

  async disputes() {
    const out: any[] = [];
    for (const d of this.store.listDevices()) {
      const rows = this.store.listEvents(d.public_id);
      for (const c of rows.filter((r) => r.type === "CHALLENGE")) {
        const target = rows.find((r) => r.seq === c.ref_seq);
        const res = rows.find((r) => r.type === "RESOLUTION" && r.ref_seq === c.seq);
        const cp = JSON.parse(c.payload);
        const tp = target ? JSON.parse(target.payload) : {};
        out.push({
          publicId: d.public_id,
          device: `${d.brand} ${d.model}`,
          challengeSeq: c.seq,
          targetSeq: c.ref_seq,
          targetType: target?.type,
          targetTypeLabel: target ? RECORD_TYPE_LABEL[target.type as RecordType] : "",
          targetSummary: tp.description ?? tp.reason ?? "",
          targetActor: target ? this.identityByAddress(target.actor_address) : null,
          challenger: this.identityByAddress(c.actor_address),
          reason: cp.reason,
          evidenceCount: (cp.evidence ?? []).length,
          raisedAt: new Date(c.chain_ts * 1000).toISOString(),
          status: res ? "resolved" : "open",
          resolution: res
            ? {
                seq: res.seq,
                outcome: OUTCOMES[res.outcome],
                outcomeLabel: OUTCOME_LABEL[OUTCOMES[res.outcome] as Outcome],
                reason: JSON.parse(res.payload).reason,
                auditor: this.identityByAddress(res.actor_address),
                resolvedAt: new Date(res.chain_ts * 1000).toISOString(),
              }
            : null,
        });
      }
    }
    return out.sort((a, b) => (a.status === b.status ? (a.raisedAt < b.raisedAt ? 1 : -1) : a.status === "open" ? -1 : 1));
  }

  async dashboard() {
    const devices = this.store.listDevices();
    let chain: any = null;
    let chainError: string | null = null;
    try {
      chain = { ...(await this.ledger.stats()), contract: this.ledger.address, chainId: this.ledger.chainId, rpcUrl: this.ledger.rpcUrl };
    } catch (e) {
      chainError = (e as Error).message;
    }
    let repairEvents = 0,
      evidenceBacked = 0,
      claims = 0,
      openDisputes = 0,
      conflicts = 0,
      evidenceFiles = 0;
    const categoryCounts: Record<string, number> = {};
    for (const d of devices) {
      const rows = this.store.listEvents(d.public_id);
      const events = this.decorate(rows, null, undefined);
      for (const e of events) {
        if (["DIAGNOSTIC", "REPAIR", "COMPONENT_REPLACEMENT"].includes(e.type)) repairEvents++;
        if (isClaimType(e.type) && e.type !== "REGISTRATION") {
          claims++;
          categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;
          if (e.category === "evidence-attached" || e.category === "corroborated") evidenceBacked++;
        }
      }
      openDisputes += this.openChallengeSeqs(rows).size;
      conflicts += detectConflicts(events).filter((c) => c.status === "open").length;
      evidenceFiles += this.store.evidenceForDevice(d.public_id).filter((e) => e.linked_seq !== null).length;
    }
    const recent = this.store.recentEvents(12).map((r) => {
      const d = this.store.getDevice(r.public_id)!;
      const p = JSON.parse(r.payload);
      return {
        publicId: r.public_id,
        device: `${d.brand} ${d.model}`,
        seq: r.seq,
        type: r.type,
        typeLabel: RECORD_TYPE_LABEL[r.type as RecordType],
        actor: this.identityByAddress(r.actor_address),
        recordedAt: new Date(r.chain_ts * 1000).toISOString(),
        summary: p.description ?? p.reason ?? (r.type === "REGISTRATION" ? `${p.brand} ${p.model} registered` : ""),
        recordHash: r.record_hash,
      };
    });
    return {
      totals: { devices: devices.length, repairEvents, claims, evidenceBacked, openDisputes, openConflicts: conflicts, evidenceFiles },
      categoryCounts,
      chain,
      chainError,
      recent,
    };
  }

  // -- integrity -------------------------------------------------------------
  async checkIntegrity(publicId: string): Promise<IntegrityReport> {
    const device = this.requireDevice(publicId);
    const rows = this.store.listEvents(publicId);
    const findings: Finding[] = [];
    const report: IntegrityReport = {
      publicId,
      deviceKey: device.device_key,
      checkedAt: nowIso(),
      ok: false,
      chain: { contract: this.ledger.address, chainId: this.ledger.chainId, onChainRecords: 0, offChainRecords: rows.length, headHash: null, contractVerifyChain: null },
      evidenceChecked: 0,
      findings,
    };
    if (deviceKeyFor(publicId) !== device.device_key)
      findings.push({ severity: "error", code: "DEVICE_KEY_MISMATCH", message: "Stored device key does not derive from the public ID" });

    let recs: OnChainRecord[];
    try {
      recs = await this.ledger.getRecords(device.device_key);
      const v = await this.ledger.verifyChain(device.device_key);
      report.chain.contractVerifyChain = v.ok;
      if (!v.ok) findings.push({ severity: "error", code: "ONCHAIN_CHAIN_INVALID", seq: v.firstBadSeq, message: `Contract verifyChain() failed at record #${v.firstBadSeq}` });
    } catch (e) {
      findings.push({ severity: "error", code: "CHAIN_UNAVAILABLE", message: (e as Error).message });
      report.ok = false;
      return report;
    }
    report.chain.onChainRecords = recs.length;
    report.chain.headHash = recs.length ? recs[recs.length - 1].recordHash : null;
    if (recs.length === 0) findings.push({ severity: "error", code: "NOT_REGISTERED_ONCHAIN", message: "Device has no on-chain records" });

    // 1. on-chain chain structure, recomputed locally
    let prev = ZERO_HASH;
    for (const c of recs) {
      const h = computeRecordHash(this.ledger.chainId, this.ledger.address, device.device_key, c);
      if (h !== c.recordHash) findings.push({ severity: "error", code: "ONCHAIN_HASH_MISMATCH", seq: c.seq, message: `On-chain record #${c.seq} hash does not recompute` });
      if (c.prevHash !== prev) findings.push({ severity: "error", code: "ONCHAIN_LINK_BROKEN", seq: c.seq, message: `On-chain record #${c.seq} does not link to #${c.seq - 1}` });
      prev = c.recordHash;
    }

    // 2. off-chain rows vs commitments
    const bySeq = new Map(rows.map((r) => [r.seq, r]));
    for (const c of recs) {
      const r = bySeq.get(c.seq);
      if (!r) {
        findings.push({ severity: "error", code: "OFFCHAIN_RECORD_MISSING", seq: c.seq, message: `Record #${c.seq} exists on-chain but its off-chain payload is missing (deleted or never stored)` });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.payload);
      } catch {
        findings.push({ severity: "error", code: "PAYLOAD_UNPARSEABLE", seq: c.seq, message: `Record #${c.seq} payload is not valid JSON` });
        continue;
      }
      if (canonicalize(parsed) !== r.payload)
        findings.push({ severity: "error", code: "PAYLOAD_NOT_CANONICAL", seq: c.seq, message: `Record #${c.seq} payload is not in canonical form (re-serialised or edited)` });
      const digest = payloadDigest(r.payload);
      if (digest !== c.payloadDigest)
        findings.push({ severity: "error", code: "PAYLOAD_DIGEST_MISMATCH", seq: c.seq, message: `Record #${c.seq} off-chain payload does not match the digest committed on-chain — the stored details were altered` });
      if (r.payload_digest !== c.payloadDigest)
        findings.push({ severity: "warning", code: "STORED_DIGEST_MISMATCH", seq: c.seq, message: `Record #${c.seq} stored digest column differs from on-chain commitment` });
      if (r.record_hash !== c.recordHash)
        findings.push({ severity: "error", code: "RECORD_HASH_MISMATCH", seq: c.seq, message: `Record #${c.seq} stored record hash differs from on-chain` });
      if (r.actor_address.toLowerCase() !== c.actor.toLowerCase())
        findings.push({ severity: "error", code: "ACTOR_MISMATCH", seq: c.seq, message: `Record #${c.seq} attributes a different actor off-chain than on-chain` });
      if (typeName(c.recordType) !== r.type)
        findings.push({ severity: "error", code: "TYPE_MISMATCH", seq: c.seq, message: `Record #${c.seq} type differs between database (${r.type}) and chain (${typeName(c.recordType)})` });
      const refOn = c.refSeq === NO_REF ? null : c.refSeq;
      if (refOn !== r.ref_seq) findings.push({ severity: "error", code: "REFERENCE_MISMATCH", seq: c.seq, message: `Record #${c.seq} reference differs between database and chain` });
      if (c.outcome !== r.outcome) findings.push({ severity: "error", code: "OUTCOME_MISMATCH", seq: c.seq, message: `Record #${c.seq} resolution outcome differs between database and chain` });

      // 3. evidence committed in this payload
      for (const ev of ((parsed as any).evidence ?? []) as { id: string; sha256: string }[]) {
        report.evidenceChecked++;
        const row = this.store.getEvidence(ev.id);
        if (!row) {
          findings.push({ severity: "error", code: "EVIDENCE_ROW_MISSING", seq: c.seq, evidenceId: ev.id, message: `Evidence ${ev.id} committed in #${c.seq} has no database row` });
          continue;
        }
        if (row.sha256 !== ev.sha256)
          findings.push({ severity: "error", code: "EVIDENCE_DIGEST_EDITED", seq: c.seq, evidenceId: ev.id, message: `Evidence ${ev.id}: database digest differs from the digest committed in #${c.seq}` });
        const chk = this.vault.verify(row.stored_name, ev.sha256);
        if (chk.status === "missing") findings.push({ severity: "error", code: "EVIDENCE_FILE_MISSING", seq: c.seq, evidenceId: ev.id, message: `Evidence ${ev.id} file is missing` });
        else if (chk.status === "mismatch")
          findings.push({ severity: "error", code: "EVIDENCE_FILE_ALTERED", seq: c.seq, evidenceId: ev.id, message: `Evidence ${ev.id} file no longer matches the SHA-256 committed in #${c.seq}` });
        const reuse = this.store.evidenceBySha(row.sha256).filter((o) => o.id !== row.id);
        if (reuse.length)
          findings.push({ severity: "warning", code: "EVIDENCE_DIGEST_REUSED", seq: c.seq, evidenceId: ev.id, message: `Evidence ${ev.id} is byte-identical to ${reuse.map((o) => `${o.id} (${o.public_id})`).join(", ")}` });
      }
    }
    for (const r of rows) {
      if (r.seq >= recs.length)
        findings.push({ severity: "error", code: "UNANCHORED_RECORD", seq: r.seq, message: `Database record #${r.seq} has no on-chain commitment (inserted outside the ledger)` });
    }
    // 4. device metadata vs registration payload
    const reg = bySeq.get(0);
    if (reg) {
      try {
        const p = JSON.parse(reg.payload);
        if (p.brand !== device.brand || p.model !== device.model)
          findings.push({ severity: "error", code: "DEVICE_METADATA_EDITED", seq: 0, message: "Device brand/model in the database differ from the registered (committed) values" });
      } catch {
        /* reported above */
      }
    }
    report.ok = !findings.some((f) => f.severity === "error");
    return report;
  }

  async checkAll() {
    const out = [];
    for (const d of this.store.listDevices()) out.push(await this.checkIntegrity(d.public_id));
    return { checkedAt: nowIso(), devices: out.length, ok: out.every((r) => r.ok), reports: out };
  }

  // -- export ----------------------------------------------------------------
  async exportHistory(publicId: string) {
    const device = this.requireDevice(publicId);
    const rows = this.store.listEvents(publicId);
    const integrity = await this.checkIntegrity(publicId);
    const evIds = new Set<string>();
    for (const r of rows) for (const e of JSON.parse(r.payload).evidence ?? []) evIds.add(e.id);
    return {
      format: "patchledger.export.v1",
      generatedAt: nowIso(),
      notice: "Synthetic research prototype data. A valid hash chain shows the history was not altered after recording; it does not prove the recorded claims are true.",
      hashSpec: {
        payloadDigest: "keccak256(utf8(canonicalPayload)); canonical = sorted keys, no whitespace, NFC strings, integer-only numbers",
        recordHash:
          "keccak256(abi.encode(keccak256('PatchLedger.Record.v1'), chainId, contract, deviceKey, seq:uint32, recordType:uint8, prevHash, payloadDigest, actor, timestamp:uint40, refSeq:uint32, outcome:uint8))",
        deviceKey: "keccak256(utf8('patchledger:device:' + publicId))",
        evidenceDigest: "SHA-256 over raw file bytes (hex)",
        noRef: NO_REF,
      },
      chain: { chainId: this.ledger.chainId, contract: this.ledger.address, network: "local Hardhat development chain (not a public network)" },
      device: { publicId, deviceKey: device.device_key, brand: device.brand, model: device.model, year: device.year, formFactor: device.form_factor, synthetic: !!device.synthetic },
      headHash: rows.length ? rows[rows.length - 1].record_hash : null,
      records: rows.map((r) => ({
        seq: r.seq,
        type: r.type,
        recordType: typeCode(r.type as RecordType),
        refSeq: r.ref_seq === null ? NO_REF : r.ref_seq,
        outcome: r.outcome,
        actor: r.actor_address,
        actorLabel: this.identityByAddress(r.actor_address).label,
        timestamp: r.chain_ts,
        recordedAt: new Date(r.chain_ts * 1000).toISOString(),
        prevHash: r.prev_hash,
        recordHash: r.record_hash,
        payloadDigest: r.payload_digest,
        canonicalPayload: r.payload,
        txHash: r.tx_hash,
        blockNumber: r.block_number,
      })),
      evidence: [...evIds].map((id) => {
        const e = this.store.getEvidence(id);
        return e ? { id, kind: e.kind, sha256: e.sha256, size: e.size, mime: e.mime, storedName: e.stored_name } : { id, missing: true };
      }),
      verification: integrity,
    };
  }

  async verificationReport(publicId: string): Promise<string> {
    const x = await this.exportHistory(publicId);
    const passport = await this.getPassport(publicId);
    const v = x.verification;
    const lines: string[] = [];
    lines.push(`# PatchLedger verification report — ${x.device.publicId}`);
    lines.push("");
    lines.push(`Generated: ${x.generatedAt}  `);
    lines.push(`Device: ${x.device.brand} ${x.device.model}${x.device.year ? ` (${x.device.year})` : ""}${x.device.synthetic ? " — SYNTHETIC DEMO RECORD" : ""}  `);
    lines.push(`Device key: \`${x.device.deviceKey}\`  `);
    lines.push(`Contract: \`${x.chain.contract}\` on chain ${x.chain.chainId} (${x.chain.network})  `);
    lines.push(`Head hash: \`${x.headHash}\``);
    lines.push("");
    lines.push(`> ${x.notice}`);
    lines.push("");
    lines.push(`## Verdict: ${v.ok ? "PASS — off-chain history matches on-chain commitments" : "FAIL — integrity findings below"}`);
    lines.push("");
    lines.push(`- On-chain records: ${v.chain.onChainRecords}; off-chain records: ${v.chain.offChainRecords}`);
    lines.push(`- Contract verifyChain(): ${v.chain.contractVerifyChain}`);
    lines.push(`- Evidence commitments checked: ${v.evidenceChecked}`);
    lines.push(`- Open disputes: ${passport.openDisputes}; open component conflicts: ${passport.conflicts.filter((c) => c.status === "open").length}`);
    lines.push("");
    lines.push("## Findings");
    lines.push("");
    if (!v.findings.length) lines.push("No findings.");
    for (const f of v.findings) lines.push(`- **${f.severity.toUpperCase()}** \`${f.code}\`${f.seq !== undefined ? ` (record #${f.seq})` : ""}: ${f.message}`);
    lines.push("");
    lines.push("## Event sequence");
    lines.push("");
    lines.push("| # | Type | Actor | Recorded (chain time) | Ref | Evidence status | Record hash | Payload digest |");
    lines.push("|---|------|-------|-----------------------|-----|-----------------|-------------|----------------|");
    for (const e of passport.events) {
      lines.push(
        `| ${e.seq} | ${e.typeLabel}${e.type === "RESOLUTION" ? ` — ${e.outcomeLabel}` : ""} | ${e.actor.label} | ${e.recordedAt} | ${e.refSeq ?? ""} | ${e.categoryLabel} | \`${e.recordHash}\` | \`${e.payloadDigest}\` |`,
      );
    }
    lines.push("");
    lines.push("## Evidence digests (SHA-256)");
    lines.push("");
    lines.push("| Evidence | Kind | Committed in | SHA-256 | Integrity |");
    lines.push("|----------|------|--------------|---------|-----------|");
    for (const e of passport.events.flatMap((ev) => ev.evidence.filter((x) => x.committedInSeq === ev.seq)))
      lines.push(`| ${e.id} | ${e.kind} | #${e.committedInSeq} | \`${e.sha256}\` | ${e.integrity} |`);
    if (passport.conflicts.length) {
      lines.push("");
      lines.push("## Conflicting claims");
      lines.push("");
      for (const c of passport.conflicts) lines.push(`- ${c.component}: replacement in #${c.replacedSeq} vs. "original" asserted in #${c.assertedOriginalSeq} — ${c.status} (${c.note})`);
    }
    lines.push("");
    lines.push("## How to re-verify independently");
    lines.push("");
    lines.push("Export the JSON history and run `npm run verify-export -- <file.json> [--rpc http://127.0.0.1:8545]`. The script recomputes every payload digest and record hash without using the PatchLedger server.");
    return lines.join("\n") + "\n";
  }
}

/** Component lineage check: a component asserted "original" after a recorded replacement. */
export function detectConflicts(events: EventView[]): Conflict[] {
  const conflicts: Conflict[] = [];
  // all earlier replacement claims per component, in order
  const replaced = new Map<string, number[]>();
  const inactive = (seq: number) => {
    const e = events[seq];
    return !!e && (e.supersededBySeq !== null || e.challenges.some((c) => c.outcome === "CLAIM_REJECTED"));
  };
  for (const e of events) {
    if (!isClaimType(e.type)) continue;
    const assertions: { component: string; state: string }[] = [
      ...((e.payload.componentAssertions ?? []) as { component: string; state: string }[]),
      ...((e.payload.corrected?.componentAssertions ?? []) as { component: string; state: string }[]),
    ];
    for (const a of assertions) {
      if (a.state === "replaced") replaced.set(a.component, [...(replaced.get(a.component) ?? []), e.seq]);
      const prior = replaced.get(a.component) ?? [];
      if (a.state === "original" && prior.length) {
        // compare with the latest replacement that still stands; fall back to the latest one overall
        const active = prior.filter((s) => !inactive(s));
        const r = active.length ? active[active.length - 1] : prior[prior.length - 1];
        const addressed = inactive(r) || inactive(e.seq);
        conflicts.push({
          component: a.component,
          replacedSeq: r,
          assertedOriginalSeq: e.seq,
          status: addressed ? "addressed" : "open",
          note: addressed
            ? "one side has since been corrected or rejected by an auditor; both records remain in the history"
            : "a later record asserts the original part although an earlier record claims it was replaced",
        });
      }
    }
  }
  return conflicts;
}

export { LedgerError };
