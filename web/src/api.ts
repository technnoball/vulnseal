// API client. The demo identity travels in X-Demo-Actor (demonstration only, not authentication).
export class ApiError extends Error {
  status: number;
  contractError?: { name: string; args: string[] } | null;
  onChain?: boolean;
  constructor(message: string, status: number, body?: any) {
    super(message);
    this.status = status;
    this.contractError = body?.contractError;
    this.onChain = body?.onChain;
  }
}

let currentActor = "";
export const setApiActor = (id: string) => (currentActor = id);
export const getApiActor = () => currentActor;

async function request<T>(method: string, url: string, body?: unknown, form?: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (currentActor) headers["X-Demo-Actor"] = currentActor;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw new ApiError("Cannot reach the PatchLedger server at " + window.location.origin + ". Is ./run.sh still running?", 0);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status, data);
  return data as T;
}

export const api = {
  get: <T,>(url: string) => request<T>("GET", url),
  post: <T,>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  upload: <T,>(url: string, form: FormData) => request<T>("POST", url, undefined, form),
};

// ---- shared types (mirror server responses) ----
export interface Identity {
  id: string;
  index: number;
  label: string;
  description: string;
  roles: string[];
  address: string;
}
export interface Meta {
  identities: Identity[];
  recordTypes: Record<string, string>;
  categories: string[];
  results: string[];
  components: string[];
  partOrigins: string[];
  formFactors: string[];
  evidenceKinds: string[];
  evidenceCategories: Record<string, string>;
  demoLab: boolean;
  publicBaseUrl: string;
}
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
  integrity: string;
  canViewContent: boolean;
  reusedElsewhere: { id: string; publicId: string; seq: number | null }[];
}
export interface EventView {
  seq: number;
  type: string;
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
  outcome: string;
  outcomeLabel: string;
  evidence: EvidenceView[];
  category: string;
  categoryLabel: string;
  flags: string[];
  openChallengeSeq: number | null;
  challenges: { seq: number; resolvedBySeq: number | null; outcome: string | null }[];
  supersededBySeq: number | null;
  corroboratedBySeqs: number[];
  anchor: string;
}
export interface Conflict {
  component: string;
  replacedSeq: number;
  assertedOriginalSeq: number;
  status: string;
  note: string;
}
export interface Passport {
  device: { publicId: string; deviceKey: string; brand: string; model: string; year: number | null; formFactor: string; synthetic: boolean; createdAt: string };
  headHash: string | null;
  onChainHeadHash: string | null;
  onChainRecords: number | null;
  chainError: string | null;
  events: EventView[];
  conflicts: Conflict[];
  openDisputes: number;
  pendingEvidence: EvidenceView[];
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
export interface DeviceSummary {
  publicId: string;
  brand: string;
  model: string;
  year: number | null;
  formFactor: string;
  synthetic: boolean;
  records: number;
  openDisputes: number;
  lastRecordedAt: string | null;
}
