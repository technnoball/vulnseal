import { useRef, useState, type FormEvent } from "react";
import { Download, Upload } from "lucide-react";
import { api, downloadJson } from "../api.ts";
import { useSession } from "../identity.tsx";
import { Link, useLocation } from "../router.tsx";
import { ErrorNotice, Field, Hash, LedgerPanel, Notice, PageHead, Sheet, fmtBytes, useAction } from "../ui.tsx";

interface Committed {
  cid: number;
  ref: string;
  commitment: string;
  policyVersion: number;
  tx: { hash: string; blockNumber: number; gasUsed: number };
  receipt: { statement: { proves: string; doesNotProve: string }; logSeq: number; blockHash: string };
}

const EMPTY = { programId: "1", title: "", severity: "medium", scope: "", description: "", impact: "", reproduction: "", privateNotes: "" };

export function NewReport() {
  const { me, meta } = useSession();
  const { search } = useLocation();
  const revise = search.get("revise");
  const [f, setF] = useState({ ...EMPTY, programId: search.get("program") ?? "1" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<{ id: string; filename: string; sha256: string; size: number }[]>([]);
  const [done, setDone] = useState<Committed | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const act = useAction();
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return act.setError(new Error("Choose a file first."));
    const fd = new FormData();
    fd.append("file", file);
    const r = await act.run("upload", () => api.upload<{ id: string; filename: string; sha256: string; size: number }>("/api/evidence", fd));
    if (r) {
      setEvidence([...evidence, r]);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const [k, label] of [["title", "a title"], ["scope", "the scope"], ["description", "a description"], ["impact", "the impact"], ["reproduction", "reproduction notes"]] as const) {
      if (!f[k].trim()) errs[k] = `Enter ${label}.`;
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      setTimeout(() => (document.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus(), 0);
      return;
    }
    const body = { ...f, programId: Number(f.programId), evidenceIds: evidence.map((x) => x.id) };
    const r = await act.run("commit", () => (revise ? api.post<Committed>(`/api/reports/${revise}/revise`, body) : api.post<Committed>("/api/reports", body)));
    if (r) setDone(r);
  }

  if (me?.kind !== "researcher") {
    return (
      <>
        <PageHead kicker="Researcher workspace" title="New confidential report" />
        <Notice kind="warn" title="Sign in as a researcher (basalt, quillfox or nightjar) to write a report.">
          Program staff, arbitrators and auditors cannot commit reports: the contract only accepts commitments from registered researcher addresses.
        </Notice>
      </>
    );
  }

  if (done) {
    return (
      <>
        <PageHead kicker="Commitment recorded" title={`${done.ref} is anchored on the shared ledger`} lede="Only the commitment hash went on-chain. The report and the secret nonce stay in your encrypted vault." />
        <div className="grid-2">
          <LedgerPanel title="Ledger record">
            <dl className="kv">
              <dt>Commitment</dt>
              <dd>
                <Hash value={done.commitment} full />
              </dd>
              <dt>Transaction</dt>
              <dd>
                <Hash value={done.tx.hash} /> <span className="mono small">block {done.tx.blockNumber} · {done.tx.gasUsed} gas</span>
              </dd>
              <dt>Block hash</dt>
              <dd>
                <Hash value={done.receipt.blockHash} />
              </dd>
              <dt>Log position</dt>
              <dd className="mono">#{done.receipt.logSeq}</dd>
              <dt>Policy version</dt>
              <dd className="mono">v{done.policyVersion}</dd>
            </dl>
            <div className="actions" style={{ marginTop: 16 }}>
              <button className="btn primary" onClick={() => act.run("receipt", () => downloadJson(`/api/reports/${done.cid}/receipt`, "receipt.json"))}>
                <Download size={16} aria-hidden="true" /> Download receipt
              </button>
              <button className="btn" onClick={() => act.run("recovery", () => downloadJson(`/api/reports/${done.cid}/recovery`, "reveal-package.json"))}>
                <Download size={16} aria-hidden="true" /> Download private reveal package
              </button>
              <Link className="btn" to={`/reports/${done.cid}`}>
                Open {done.ref}
              </Link>
            </div>
            <ErrorNotice error={act.error} />
          </LedgerPanel>
          <div>
            <Notice kind="ok" title="The receipt proves:">
              {done.receipt.statement.proves}
            </Notice>
            <Notice kind="warn" title="It does not prove:">
              {done.receipt.statement.doesNotProve}
            </Notice>
            <Notice kind="warn" title="Keep the reveal package private and safe.">
              It contains the secret nonce. Anyone holding it can reveal your report, and without it (or this vault) the commitment can never be opened.
            </Notice>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        kicker={revise ? `Revision of VS-${revise.padStart(4, "0")}` : "Researcher workspace"}
        title={revise ? "Revise a committed report" : "New confidential report"}
        lede={
          revise
            ? "A revision is a new commitment that references the original. The original stays on the ledger and keeps its own time; the revision does not inherit it."
            : "Use synthetic content only. Do not enter real undisclosed vulnerabilities or exploit code in this demonstration."
        }
      />
      <div className="grid-2">
        <Sheet tab="Report — sealed in your vault, committed by hash" aside={`as ${me.label}`}>
          <ErrorNotice error={act.error} />
          <form className="form" onSubmit={submit} noValidate>
            <div className="form-row">
              {!revise && (
                <Field label="Program" htmlFor="prog">
                  <select id="prog" value={f.programId} onChange={set("programId")}>
                    {meta?.programs.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.short} — {p.name} (fictional)
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Claimed severity" htmlFor="sev">
                <select id="sev" value={f.severity} onChange={set("severity")}>
                  {meta?.severities.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Title" htmlFor="title" error={errors.title}>
              <input id="title" value={f.title} onChange={set("title")} maxLength={140} aria-invalid={!!errors.title} />
            </Field>
            <Field label="Scope / affected asset" htmlFor="scope" error={errors.scope} hint="Fictional hosts only, e.g. checkout.ashgrove.example">
              <input id="scope" value={f.scope} onChange={set("scope")} maxLength={300} aria-invalid={!!errors.scope} />
            </Field>
            <Field label="Description" htmlFor="desc" error={errors.description}>
              <textarea id="desc" value={f.description} onChange={set("description")} maxLength={4000} aria-invalid={!!errors.description} />
            </Field>
            <Field label="Impact summary" htmlFor="impact" error={errors.impact}>
              <textarea id="impact" value={f.impact} onChange={set("impact")} maxLength={1500} aria-invalid={!!errors.impact} />
            </Field>
            <Field label="Reproduction notes" htmlFor="repro" error={errors.reproduction}>
              <textarea id="repro" value={f.reproduction} onChange={set("reproduction")} maxLength={4000} aria-invalid={!!errors.reproduction} />
            </Field>
            <Field label="Private notes (not committed, never shared)" htmlFor="notes">
              <textarea id="notes" value={f.privateNotes} onChange={set("privateNotes")} maxLength={2000} style={{ minHeight: 60 }} />
            </Field>
            <fieldset>
              <legend>Evidence (SHA-256 of each file is committed)</legend>
              <div className="row">
                <label className="visually-hidden" htmlFor="ev">
                  Evidence file
                </label>
                <input id="ev" type="file" ref={fileRef} accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,.json" />
                <button type="button" className="btn quiet" onClick={upload} disabled={act.busy === "upload"}>
                  <Upload size={14} aria-hidden="true" /> {act.busy === "upload" ? "Encrypting…" : "Upload and hash"}
                </button>
              </div>
              {evidence.map((x) => (
                <div key={x.id} className="small row" style={{ marginTop: 6 }}>
                  <span className="mono">{x.id}</span> {x.filename} · {fmtBytes(x.size)} <Hash value={x.sha256} />
                  <button type="button" className="btn quiet" onClick={() => setEvidence(evidence.filter((y) => y.id !== x.id))}>
                    remove
                  </button>
                </div>
              ))}
            </fieldset>
            <div className="row">
              <button className="btn primary" disabled={act.busy === "commit"}>
                {act.busy === "commit" ? "Committing on-chain…" : revise ? "Commit revision" : "Commit to the ledger"}
              </button>
              {Object.keys(errors).length > 0 && (
                <span className="small" role="alert" style={{ color: "var(--vermilion-ink)", fontWeight: 500 }}>
                  {Object.keys(errors).length} field(s) need attention.
                </span>
              )}
            </div>
          </form>
        </Sheet>
        <Sheet tab="What happens when you commit">
          <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
            <li>Each text field is hashed separately (keccak256 of NFC text); evidence files contribute their SHA-256 values.</li>
            <li>The field hashes are combined with a schema tag into a fields digest.</li>
            <li>A fresh 256-bit secret nonce is generated. The commitment binds the digest and nonce to your address, the program, its policy version, the chain and the contract.</li>
            <li>Your key signs <code>anchorCommitment()</code>. Only the hash, program id and policy version go on-chain.</li>
            <li>The report and nonce are sealed in your vault (AES-256-GCM). The program sees nothing until you reveal.</li>
          </ol>
        </Sheet>
      </div>
    </>
  );
}
