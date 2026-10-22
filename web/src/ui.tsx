// Reusable design-system components.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "./api.ts";

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

export function Stamp({ category, label }: { category: string; label: string }) {
  return (
    <span className={`stamp ${category}`} title={`Evidence status: ${label}`}>
      {label}
    </span>
  );
}

export function Mark({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: ReactNode }) {
  return <span className={`mark ${ok ? "ok" : warn ? "warn" : "bad"}`}>{children}</span>;
}

export function integrityMark(status: string) {
  if (status === "match") return <Mark ok>digest matches</Mark>;
  if (status === "missing") return <Mark>file missing</Mark>;
  if (status === "commitment-mismatch") return <Mark>digest differs from commitment</Mark>;
  if (status === "unknown-evidence") return <Mark>unknown evidence</Mark>;
  return <Mark>digest mismatch</Mark>;
}

export function anchorMark(anchor: string) {
  if (anchor === "anchored") return <Mark ok>anchored on-chain</Mark>;
  if (anchor === "chain-unavailable") return <Mark warn>chain unavailable</Mark>;
  return <Mark>{anchor.replace(/-/g, " ")}</Mark>;
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
      aria-label={`Hash ${value}. Click to copy.`}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => undefined,
        );
      }}
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
  const title = e.status === 403 && e.onChain ? "Rejected by the smart contract." : e.status === 503 ? "Service unavailable." : e.status === 409 ? "Conflict." : "Error.";
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
      {hint && !error && <div className="hint" id={`${htmlFor}-hint`}>{hint}</div>}
      {error && (
        <div className="err" id={`${htmlFor}-err`}>
          {error}
        </div>
      )}
    </div>
  );
}

export function SyntheticTag() {
  return <span className="synthetic-tag">synthetic demo record</span>;
}

/** Load data with reload support. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(() => {
    setLoading(true);
    return run()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [run]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-IN", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";
export const fmtDate = (d: string | null | undefined) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" }) : "—");
export const pad = (n: number) => "#" + String(n).padStart(3, "0");
export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
