// API client. The session is an HttpOnly cookie set by POST /api/session (simulated sign-in).
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

async function request<T>(method: string, url: string, body?: unknown, form?: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, { method, headers, credentials: "same-origin", body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw new ApiError(`Cannot reach the VulnSeal server at ${window.location.origin}. Is ./run.sh still running?`, 0);
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
  del: <T,>(url: string) => request<T>("DELETE", url),
  upload: <T,>(url: string, form: FormData) => request<T>("POST", url, undefined, form),
};

/** Fetch a JSON download endpoint and save it via a blob (keeps cookies, works for 403 messages). */
export async function downloadJson(url: string, fallbackName: string) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body?.error ?? `Download failed (${res.status})`, res.status, body);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return name;
}

export interface Identity {
  id: string;
  label: string;
  kind: "governor" | "researcher" | "program-admin" | "reviewer" | "arbitrator" | "auditor" | "outsider";
  roles: string[];
  programId: number;
  programName?: string | null;
  address: string;
  note?: string;
}
export interface Program {
  id: number;
  slug: string;
  name: string;
  short: string;
  blurb: string;
}
export interface Meta {
  identities: Identity[];
  programs: Program[];
  statuses: string[];
  relations: string[];
  disputeKinds: string[];
  decisions: Record<string, string>;
  decisionsForKind: Record<string, number[]>;
  reasonCodes: Record<string, string>;
  logKinds: Record<string, string>;
  severities: string[];
  demoLab: boolean;
}
export interface Actor {
  id: string | null;
  label: string;
  kind: string;
  address: string;
}
export interface LedgerEvent {
  seq: number;
  kind: number;
  kindName: string;
  subject: string;
  actor: Actor;
  at: string;
  dataHash: string;
  entryHash: string;
  txHash: string;
  blockNumber: number;
}
export interface AssociationView {
  aid: number;
  cidA: number;
  cidB: number;
  refA: string;
  refB: string;
  programs: string[];
  relation: number;
  relationName: string;
  effectiveRelation: number;
  effectiveRelationName: string;
  status: number;
  statusName: string;
  decidedRelation: number;
  family: string | null;
  proposer: Actor;
  reviewer: Actor | null;
  rationaleDigest: string | null;
  rationale: string | null;
  reviews: { reviewer: string; approve: boolean; digest: string; rationale: string | null; tx: string; at: string }[];
  tx: string | null;
}
export interface DisputeSummary {
  did: number;
  kind: number;
  kindName: string;
  status: number;
  statusName: string;
  round: number;
  subject: number;
  refs: string[];
  programs: string[];
  decision: number | null;
  decisionName: string | null;
  reasonCode: number | null;
  openedAt: string | null;
  decidedAt: string | null;
}
