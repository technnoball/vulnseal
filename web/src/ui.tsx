// Reusable design-system components.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BookLock, Lock, Network, CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { ApiError } from "./api.ts";
import { useSession } from "./identity.tsx";

export function PageHead({ kicker, title, lede, actions }: { kicker: string; title: ReactNode; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <div className="kicker">{kicker}</div>
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Sheet({ tab, aside, children, flush, id }: { tab?: ReactNode; aside?: ReactNode; children: ReactNode; flush?: boolean; id?: string }) {
  return (
    <section className={"sheet" + (flush ? " flush" : "")} id={id} aria-label={typeof tab === "string" ? tab : undefined}>
      {tab && (
        <div className="tab">
          <span>{tab}</span>
          {aside && <span>{aside}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Confidential material: only rendered for viewers the server authorised. */
export function Sealed({ title, reason, children }: { title: string; reason: string; children: ReactNode }) {
  return (
    <section className="sealed" aria-label={title}>
      <div className="sealed-head">
        <BookLock size={16} aria-hidden="true" />
        <span>{title}</span>
        <span className="spacer" />
        <span className="sealed-tag">confidential · off-chain · encrypted at rest</span>
      </div>
      <p className="sealed-reason">{reason}</p>
      <div className="sealed-body">{children}</div>
    </section>
  );
}

export function Withheld({ title, reason }: { title: string; reason: string }) {
  return (
    <section className="sealed withheld" aria-label={title}>
      <div className="sealed-head">
        <Lock size={16} aria-hidden="true" />
        <span>{title}</span>
        <span className="spacer" />
        <span className="sealed-tag">withheld</span>
      </div>
      <p className="sealed-reason">{reason}</p>
    </section>
  );
}

/** Consortium-visible record: what every participant of the shared ledger can see. */
export function LedgerPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ledger-panel" aria-label={title}>
      <div className="ledger-head">
        <Network size={15} aria-hidden="true" />
        <span>{title}</span>
        <span className="spacer" />
        <span className="ledger-tag">consortium-visible · on-chain</span>
      </div>
      <div className="ledger-body">{children}</div>
    </section>
  );
}

const STATUS_CLASS: Record<string, string> = {
  anchored: "st-pending",
  acknowledged: "st-pending",
  "reveal requested": "st-progress",
  revealed: "st-verified",
  "pending triage": "st-progress",
  "needs info": "st-progress",
  valid: "st-strong",
  invalid: "st-muted",
  finalized: "st-final",
  superseded: "st-muted",
  // disputes
  open: "st-disputed",
  decided: "st-progress",
  appealed: "st-disputed",
  final: "st-final",
  // associations
  proposed: "st-pending",
  confirmed: "st-verified",
  rejected: "st-muted",
  disputed: "st-disputed",
  upheld: "st-strong",
  overturned: "st-final",
  // reveal outcomes
  match: "st-verified",
  mismatch: "st-failed",
  missing: "st-progress",
  "invalid-encoding": "st-failed",
  "not revealed": "st-pending",
};

export function StateStamp({ state, label }: { state: string; label?: string }) {
  return (
    <span className={`stamp ${STATUS_CLASS[state] ?? "st-pending"}`} title={label ?? state}>
      {label ?? state}
    </span>
  );
}

export function Check({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <span className={`check ${ok === null ? "warn" : ok ? "ok" : "bad"}`}>
      {ok === null ? <TriangleAlert size={14} aria-hidden="true" /> : ok ? <CircleCheck size={14} aria-hidden="true" /> : <CircleX size={14} aria-hidden="true" />}
      <span>{children}</span>
    </span>
  );
}

export function Hash({ value, full }: { value: string | null | undefined; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">—</span>;
  const shown = full || value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
  return (
    <button
      type="button"
      className="hash-btn"
      title={copied ? "Copied" : `${value} (click to copy)`}
      aria-label={`${value}. Click to copy.`}
      onClick={() =>
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => undefined,
        )
      }
    >
      <span className="hash">{copied ? "copied" : shown}</span>
    </button>
  );
}

export function Notice({ kind = "info", title, children }: { kind?: "info" | "error" | "ok" | "warn"; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {title && <strong>{title} </strong>}
      {children}
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const title =
    e.onChain && e.status === 403 ? "Rejected by the smart contract." : e.onChain ? "The contract refused this." : e.status === 403 ? "Not permitted." : e.status === 401 ? "No identity selected." : e.status === 503 ? "Service unavailable." : e.status === 409 ? "Not possible right now." : "Error.";
  return (
    <Notice kind="error" title={title}>
      {e.message}
      {e.contractError && (
        <span className="code">
          revert {e.contractError.name}({e.contractError.args.join(", ")})
        </span>
      )}
    </Notice>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <div className="loading" role="status">
      {what}
    </div>
  );
}

export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="err">{error}</div>}
    </div>
  );
}

/** Load data; reloads when deps change or the signed-in identity changes. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const { version } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, [...deps, version]);
  const reload = useCallback(() => {
    setLoading(true);
    return run()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => {
        setError(e);
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [run]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload };
}

/** Run an action with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<ReactNode>(null);
  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>, ok?: (r: T) => ReactNode) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      const r = await fn();
      if (ok) setMessage(ok(r));
      return r;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, message, run, setError, setMessage };
}

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-IN", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";
export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
export const short = (h: string | null | undefined, n = 10) => (h ? `${h.slice(0, n)}…` : "—");
