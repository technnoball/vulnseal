import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, type EvidenceView, type Passport } from "../api.ts";
import { roleText, useIdentity } from "../identity.tsx";
import { Link, navigate, useLocation } from "../router.tsx";
import { ErrorNotice, Field, Hash, Loading, Notice, PageHead, Sheet, Stamp, fmtBytes, pad, useLoad } from "../ui.tsx";

const FREE_TYPES = ["DIAGNOSTIC", "REPAIR", "COMPONENT_REPLACEMENT", "INSPECTION", "CUSTODY_TRANSFER"];
const REF_TYPES = ["EVIDENCE_ATTACHMENT", "CORROBORATION", "CHALLENGE", "RESOLUTION", "CORRECTION"];

const RULES: Record<string, { roles: string[]; text: string }> = {
  DIAGNOSTIC: { roles: ["REPAIRER", "INSPECTOR"], text: "REPAIRER or INSPECTOR" },
  REPAIR: { roles: ["REPAIRER", "INSPECTOR"], text: "REPAIRER or INSPECTOR" },
  COMPONENT_REPLACEMENT: { roles: ["REPAIRER", "INSPECTOR"], text: "REPAIRER or INSPECTOR" },
  INSPECTION: { roles: ["INSPECTOR"], text: "INSPECTOR" },
  CUSTODY_TRANSFER: { roles: ["REGISTRAR", "INSPECTOR"], text: "REGISTRAR or INSPECTOR" },
  EVIDENCE_ATTACHMENT: { roles: ["REGISTRAR", "REPAIRER", "INSPECTOR", "AUDITOR"], text: "the original author (holding a writer role) or an AUDITOR" },
  CORROBORATION: { roles: ["INSPECTOR", "AUDITOR"], text: "INSPECTOR or AUDITOR, and not the author of the claim" },
  CHALLENGE: { roles: ["VERIFIER", "INSPECTOR", "REPAIRER"], text: "VERIFIER, INSPECTOR or REPAIRER, and not the author of the claim" },
  RESOLUTION: { roles: ["AUDITOR"], text: "an AUDITOR who is neither the author of the disputed claim nor the challenger" },
  CORRECTION: { roles: ["REGISTRAR", "REPAIRER", "INSPECTOR", "AUDITOR"], text: "the original author (holding a writer role) or an AUDITOR" },
};

type Assertion = { component: string; state: string };
type Measure = { key: string; value: string };

function EvidenceUploader({ publicId, attached, setAttached, pending }: { publicId: string; attached: EvidenceView[]; setAttached: (v: EvidenceView[]) => void; pending: EvidenceView[] }) {
  const { meta } = useIdentity();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState("repair-invoice");
  const [desc, setDesc] = useState("");
  const [access, setAccess] = useState("restricted");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  async function upload() {
    const f = fileRef.current?.files?.[0];
    if (!f) {
      setError(new Error("Choose a file to upload first."));
      return;
    }
    const fd = new FormData();
    fd.append("kind", kind);
    fd.append("description", desc);
    fd.append("access", access);
    fd.append("file", f);
    setBusy(true);
    setError(null);
    try {
      const r = await api.upload<{ evidence: EvidenceView; warnings: string[] }>(`/api/devices/${publicId}/evidence`, fd);
      setAttached([...attached, r.evidence]);
      setWarnings(r.warnings);
      setDesc("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const notAttached = pending.filter((p) => !attached.some((a) => a.id === p.id));

  return (
    <fieldset>
      <legend>Supporting evidence</legend>
      <p className="small muted">
        Files are stored locally and hashed with SHA-256; the digest is committed on-chain inside this record’s payload. A digest proves the file is unchanged later — not that its contents are true.
      </p>
      <ErrorNotice error={error} />
      {warnings.map((w, i) => (
        <Notice key={i} kind="warn" title="Reuse warning.">
          {w}
        </Notice>
      ))}
      <div className="form-row">
        <Field label="File" htmlFor="ev-file" hint="PDF, PNG, JPEG, WebP, SVG, TXT, CSV or JSON · max 10 MB">
          <input id="ev-file" type="file" ref={fileRef} accept=".pdf,.png,.jpg,.jpeg,.webp,.svg,.txt,.csv,.json" />
        </Field>
        <Field label="Kind" htmlFor="ev-kind">
          <select id="ev-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {(meta?.evidenceKinds ?? []).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="form-row" style={{ marginTop: 12 }}>
        <Field label="Short description" htmlFor="ev-desc">
          <input id="ev-desc" value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <Field label="Content access" htmlFor="ev-access" hint="Restricted: uploader, registrar, inspector and auditor may open the file.">
          <select id="ev-access" value={access} onChange={(e) => setAccess(e.target.value)}>
            <option value="restricted">restricted</option>
            <option value="shareable">shareable with verifiers</option>
          </select>
        </Field>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={upload} disabled={busy}>
          {busy ? "Hashing…" : "Upload and hash"}
        </button>
      </div>
      {notAttached.length > 0 && (
        <div className="small" style={{ marginTop: 12 }}>
          Your uncommitted uploads:{" "}
          {notAttached.map((p) => (
            <button key={p.id} type="button" className="btn quiet" onClick={() => setAttached([...attached, p])}>
              + {p.filename}
            </button>
          ))}
        </div>
      )}
      {attached.length > 0 && (
        <div className="evlist" style={{ marginTop: 12 }}>
          <div className="evhead">To be committed with this record</div>
          {attached.map((a) => (
            <div className="evrow" key={a.id}>
              <div>
                {a.filename} <span className="small muted">({a.kind}, {fmtBytes(a.size)})</span>
                {a.reusedElsewhere.length > 0 && <div className="small" style={{ color: "var(--vermilion-ink)" }}>digest also used by {a.reusedElsewhere.map((r) => r.id).join(", ")}</div>}
              </div>
              <Hash value={a.sha256} />
              <button type="button" className="btn quiet" onClick={() => setAttached(attached.filter((x) => x.id !== a.id))} aria-label={`Remove ${a.filename}`}>
                remove
              </button>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function RecordEvent({ publicId }: { publicId: string }) {
  const { meta, actor } = useIdentity();
  const { search } = useLocation();
  const refParam = search.get("ref");
  const [type, setType] = useState(search.get("type") ?? "REPAIR");
  const refSeq = REF_TYPES.includes(type) && refParam !== null ? Number(refParam) : null;
  const { data, error, loading } = useLoad(() => api.get<Passport>(`/api/devices/${encodeURIComponent(publicId)}`), [publicId, actor?.id]);
  const target = data && refSeq !== null ? data.events[refSeq] : undefined;

  const [f, setF] = useState<Record<string, string>>({ claimedAt: new Date().toISOString().slice(0, 10), result: "", category: "", component: "", partOrigin: "", outcome: "" });
  const [assertions, setAssertions] = useState<Assertion[]>([]);
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [attached, setAttached] = useState<EvidenceView[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState<unknown>(null);

  useEffect(() => {
    // Pre-fill a correction from the record it corrects
    if (type === "CORRECTION" && target) {
      const p = target.payload;
      setF((x) => ({ ...x, description: p.description ?? "", component: p.component ?? "", result: p.result ?? "" }));
      setAssertions((p.componentAssertions ?? []) as Assertion[]);
    }
    if (type === "COMPONENT_REPLACEMENT") setF((x) => ({ ...x, result: x.result || "replaced" }));
    if (type === "CORROBORATION") setF((x) => ({ ...x, result: x.result || "observed" }));
  }, [type, target?.seq]);

  const rule = RULES[type];
  const lacksRole = actor && rule && !rule.roles.some((r) => actor.roles.includes(r));
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const opt = (list: string[] | undefined, blank = "— select —") => [
    <option key="" value="">
      {blank}
    </option>,
    ...(list ?? []).map((v) => (
      <option key={v} value={v}>
        {v}
      </option>
    )),
  ];

  const shows = useMemo(() => {
    const s = new Set<string>();
    if (["DIAGNOSTIC", "REPAIR", "COMPONENT_REPLACEMENT", "INSPECTION", "CUSTODY_TRANSFER", "CORROBORATION"].includes(type)) s.add("claimedAt");
    if (["DIAGNOSTIC", "REPAIR", "INSPECTION"].includes(type)) s.add("category");
    if (["DIAGNOSTIC", "REPAIR", "COMPONENT_REPLACEMENT", "CORRECTION"].includes(type)) s.add("component");
    if (["DIAGNOSTIC", "REPAIR", "COMPONENT_REPLACEMENT", "INSPECTION", "CORROBORATION", "CORRECTION"].includes(type)) s.add("result");
    if (type === "COMPONENT_REPLACEMENT") s.add("partOrigin");
    if (type === "CUSTODY_TRANSFER") s.add("parties");
    if (["DIAGNOSTIC", "REPAIR", "INSPECTION", "CORRECTION"].includes(type)) s.add("assertions");
    if (["DIAGNOSTIC", "INSPECTION"].includes(type)) s.add("measures");
    if (["CHALLENGE", "RESOLUTION", "CORRECTION"].includes(type)) s.add("reason");
    if (type === "RESOLUTION") s.add("outcome");
    if (!["CHALLENGE", "RESOLUTION"].includes(type)) s.add("description");
    return s;
  }, [type]);

  function validate() {
    const e: Record<string, string> = {};
    const req = (k: string, msg: string) => {
      if (!f[k]?.trim()) e[k] = msg;
    };
    if (REF_TYPES.includes(type) && refSeq === null) e.ref = "This record type must reference an earlier record. Start from a record's action button on the passport.";
    if (REF_TYPES.includes(type) && refSeq !== null && !target) e.ref = `Record ${pad(refSeq)} does not exist.`;
    if (["DIAGNOSTIC", "REPAIR", "COMPONENT_REPLACEMENT", "INSPECTION", "CORROBORATION"].includes(type)) req("description", "Describe what was done or observed.");
    if (["DIAGNOSTIC", "REPAIR"].includes(type)) req("category", "Choose a category.");
    if (["DIAGNOSTIC", "REPAIR", "INSPECTION"].includes(type)) req("result", "Choose a result.");
    if (type === "COMPONENT_REPLACEMENT") {
      req("component", "Which component was replaced?");
      req("partOrigin", "Where did the replacement part come from?");
    }
    if (type === "CUSTODY_TRANSFER") {
      req("fromParty", "Who handed over the device (organisation or role)?");
      req("toParty", "Who received it (organisation or role)?");
    }
    if (["CHALLENGE", "RESOLUTION", "CORRECTION"].includes(type)) req("reason", type === "CHALLENGE" ? "Explain why the claim is disputed." : type === "RESOLUTION" ? "Record the auditor's reasoning." : "Explain what is corrected and why.");
    if (type === "RESOLUTION") req("outcome", "Choose an outcome.");
    if (type === "EVIDENCE_ATTACHMENT" && attached.length === 0) e.evidence = "Upload at least one evidence file.";
    if (f.claimedAt && f.claimedAt > new Date().toISOString().slice(0, 10)) e.claimedAt = "The date cannot be in the future.";
    for (const m of measures) if (m.key && !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(m.key)) e.measures = `Measurement name “${m.key}” must start with a letter and use letters, digits or _.`;
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!validate()) {
      // bring the first problem into view for keyboard and screen-reader users
      setTimeout(() => (document.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus(), 0);
      return;
    }
    if (!data) return;
    const measurements: Record<string, number | string> = {};
    for (const m of measures) if (m.key) measurements[m.key] = /^-?\d+$/.test(m.value.trim()) ? Number(m.value.trim()) : m.value.trim();
    const body: Record<string, unknown> = {
      type,
      refSeq: refSeq ?? undefined,
      claimedAt: shows.has("claimedAt") ? f.claimedAt || undefined : undefined,
      category: shows.has("category") ? f.category || undefined : undefined,
      component: shows.has("component") ? f.component || undefined : undefined,
      result: shows.has("result") ? f.result || undefined : undefined,
      partOrigin: shows.has("partOrigin") ? f.partOrigin || undefined : undefined,
      description: shows.has("description") ? f.description || undefined : undefined,
      reason: shows.has("reason") ? f.reason || undefined : undefined,
      outcome: shows.has("outcome") ? f.outcome || undefined : undefined,
      fromParty: shows.has("parties") ? f.fromParty : undefined,
      toParty: shows.has("parties") ? f.toParty : undefined,
      componentAssertions: shows.has("assertions") ? assertions.filter((a) => a.component && a.state) : undefined,
      measurements: shows.has("measures") && Object.keys(measurements).length ? measurements : undefined,
      evidenceIds: attached.map((a) => a.id),
      expectedPrevHash: data.onChainHeadHash ?? data.headHash ?? undefined,
    };
    setBusy(true);
    setSubmitErr(null);
    try {
      const r = await api.post<{ seq: number }>(`/api/devices/${publicId}/events`, body);
      navigate(`/devices/${publicId}?new=${r.seq}#rec-${r.seq}`);
      setTimeout(() => document.getElementById(`rec-${r.seq}`)?.scrollIntoView({ block: "center" }), 300);
    } catch (e) {
      setSubmitErr(e);
      // the contract's answer is shown at the top of the form
      setTimeout(() => document.querySelector(".sheet [role=alert]")?.scrollIntoView({ block: "center" }), 0);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorNotice error={error} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const typeLabel = meta?.recordTypes[type] ?? type;

  return (
    <>
      <PageHead
        kicker={`Record event · ${data.device.publicId}`}
        title={`${typeLabel} — ${data.device.brand} ${data.device.model}`}
        lede="The record is canonicalised, its digest is committed on-chain by your current identity, and the details are stored off-chain. Records can never be edited afterwards — only corrected by a new record."
        actions={
          <Link className="btn" to={`/devices/${publicId}`}>
            Back to passport
          </Link>
        }
      />
      <div className="grid-2">
        <Sheet tab="Ledger entry form" aside={actor ? `as ${actor.label} · ${roleText(actor)}` : ""}>
          {lacksRole && (
            <Notice kind="warn" title={`The contract permits this record only for ${rule.text}.`}>
              You hold {roleText(actor)}. You may submit anyway to see the contract reject it.
            </Notice>
          )}
          {!lacksRole && rule && <p className="small muted">Contract rule: {rule.text}.</p>}
          <ErrorNotice error={submitErr} />
          {errors.ref && <Notice kind="error">{errors.ref}</Notice>}
          <form className="form" onSubmit={submit} noValidate>
            {refSeq === null ? (
              <Field label="Record type" htmlFor="type">
                <select id="type" value={type} onChange={(e) => setType(e.target.value)}>
                  {FREE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {meta?.recordTypes[t] ?? t}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              target && (
                <div className="well">
                  <div className="row">
                    <span className="mono">{pad(target.seq)}</span>
                    <strong>{target.typeLabel}</strong>
                    <span className="muted small">by {target.actor.label}</span>
                    <span className="spacer" />
                    <Stamp category={target.category} label={target.categoryLabel} />
                  </div>
                  <p className="small" style={{ margin: "8px 0 0" }}>
                    {target.payload.description ?? target.payload.reason ?? ""}
                  </p>
                </div>
              )
            )}

            {shows.has("outcome") && (
              <Field label="Outcome" htmlFor="outcome" error={errors.outcome}>
                <select id="outcome" value={f.outcome} onChange={set("outcome")} aria-invalid={!!errors.outcome}>
                  <option value="">— select —</option>
                  <option value="CLAIM_UPHELD">Claim upheld — challenge dismissed</option>
                  <option value="CLAIM_REJECTED">Claim rejected — challenge upheld</option>
                  <option value="INCONCLUSIVE">Inconclusive</option>
                </select>
              </Field>
            )}
            {shows.has("reason") && (
              <Field label={type === "CHALLENGE" ? "Reason for challenge" : type === "RESOLUTION" ? "Auditor's reasoning" : "What is corrected and why"} htmlFor="reason" error={errors.reason}>
                <textarea id="reason" value={f.reason ?? ""} onChange={set("reason")} maxLength={1500} aria-invalid={!!errors.reason} />
              </Field>
            )}
            {(shows.has("claimedAt") || shows.has("category") || shows.has("component")) && (
              <div className="form-row">
                {shows.has("claimedAt") && (
                  <Field label="Date performed" htmlFor="claimedAt" error={errors.claimedAt} hint="As claimed by the submitter">
                    <input id="claimedAt" type="date" value={f.claimedAt} onChange={set("claimedAt")} aria-invalid={!!errors.claimedAt} />
                  </Field>
                )}
                {shows.has("category") && (
                  <Field label="Category" htmlFor="category" error={errors.category}>
                    <select id="category" value={f.category} onChange={set("category")} aria-invalid={!!errors.category}>
                      {opt(meta?.categories)}
                    </select>
                  </Field>
                )}
                {shows.has("component") && (
                  <Field label="Component affected" htmlFor="component" error={errors.component}>
                    <select id="component" value={f.component} onChange={set("component")} aria-invalid={!!errors.component}>
                      {opt(meta?.components, type === "COMPONENT_REPLACEMENT" ? "— select —" : "— none —")}
                    </select>
                  </Field>
                )}
              </div>
            )}
            {(shows.has("result") || shows.has("partOrigin")) && (
              <div className="form-row">
                {shows.has("result") && (
                  <Field label="Result" htmlFor="result" error={errors.result}>
                    <select id="result" value={f.result} onChange={set("result")} aria-invalid={!!errors.result}>
                      {opt(meta?.results)}
                    </select>
                  </Field>
                )}
                {shows.has("partOrigin") && (
                  <Field label="Replacement part origin" htmlFor="partOrigin" error={errors.partOrigin}>
                    <select id="partOrigin" value={f.partOrigin} onChange={set("partOrigin")} aria-invalid={!!errors.partOrigin}>
                      {opt(meta?.partOrigins)}
                    </select>
                  </Field>
                )}
              </div>
            )}
            {shows.has("parties") && (
              <div className="form-row">
                <Field label="From" htmlFor="fromParty" error={errors.fromParty} hint="Organisation or role — no personal names">
                  <input id="fromParty" value={f.fromParty ?? ""} onChange={set("fromParty")} maxLength={80} aria-invalid={!!errors.fromParty} />
                </Field>
                <Field label="To" htmlFor="toParty" error={errors.toParty} hint="e.g. “Retail buyer (identity not recorded)”">
                  <input id="toParty" value={f.toParty ?? ""} onChange={set("toParty")} maxLength={80} aria-invalid={!!errors.toParty} />
                </Field>
              </div>
            )}
            {shows.has("description") && (
              <Field
                label={type === "CORRECTION" ? "Corrected description" : type === "CORROBORATION" ? "What you independently observed" : type === "CUSTODY_TRANSFER" || type === "EVIDENCE_ATTACHMENT" ? "Note (optional)" : "Description"}
                htmlFor="description"
                error={errors.description}
                hint="Do not include customer names, contact details or full serial numbers."
              >
                <textarea id="description" value={f.description ?? ""} onChange={set("description")} maxLength={1500} aria-invalid={!!errors.description} />
              </Field>
            )}
            {shows.has("assertions") && (
              <fieldset>
                <legend>Component assertions (used for conflict detection)</legend>
                {assertions.map((a, i) => (
                  <div className="row" key={i} style={{ marginBottom: 8 }}>
                    <label className="visually-hidden" htmlFor={`as-c-${i}`}>
                      Component
                    </label>
                    <select id={`as-c-${i}`} value={a.component} onChange={(e) => setAssertions(assertions.map((x, j) => (j === i ? { ...x, component: e.target.value } : x)))} style={{ width: 160 }}>
                      {opt(meta?.components)}
                    </select>
                    <label className="visually-hidden" htmlFor={`as-s-${i}`}>
                      State
                    </label>
                    <select id={`as-s-${i}`} value={a.state} onChange={(e) => setAssertions(assertions.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))} style={{ width: 140 }}>
                      <option value="original">original</option>
                      <option value="replaced">replaced</option>
                    </select>
                    <button type="button" className="btn quiet" onClick={() => setAssertions(assertions.filter((_, j) => j !== i))}>
                      remove
                    </button>
                  </div>
                ))}
                <button type="button" className="btn quiet" onClick={() => setAssertions([...assertions, { component: "battery", state: "original" }])}>
                  + add assertion
                </button>
              </fieldset>
            )}
            {shows.has("measures") && (
              <fieldset>
                <legend>Measurements</legend>
                {errors.measures && <div className="err small" style={{ color: "var(--vermilion-ink)" }}>{errors.measures}</div>}
                {measures.map((m, i) => (
                  <div className="row" key={i} style={{ marginBottom: 8 }}>
                    <input aria-label="Measurement name" placeholder="e.g. cycleCount" value={m.key} onChange={(e) => setMeasures(measures.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} style={{ width: 200 }} />
                    <input aria-label="Measurement value" placeholder="integer or short text" value={m.value} onChange={(e) => setMeasures(measures.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} style={{ width: 200 }} />
                    <button type="button" className="btn quiet" onClick={() => setMeasures(measures.filter((_, j) => j !== i))}>
                      remove
                    </button>
                  </div>
                ))}
                <button type="button" className="btn quiet" onClick={() => setMeasures([...measures, { key: "", value: "" }])}>
                  + add measurement
                </button>
              </fieldset>
            )}
            <EvidenceUploader publicId={publicId} attached={attached} setAttached={setAttached} pending={data.pendingEvidence} />
            {errors.evidence && <Notice kind="error">{errors.evidence}</Notice>}
            <div className="row">
              <button className="btn primary" disabled={busy}>
                {busy ? "Committing to ledger…" : `Commit ${typeLabel.toLowerCase()} record`}
              </button>
              {Object.keys(errors).length > 0 && (
                <span className="small" role="alert" style={{ color: "var(--vermilion-ink)", fontWeight: 500 }}>
                  {Object.keys(errors).length} field(s) need attention above.
                </span>
              )}
              <span className="small muted">Builds on head {data.onChainHeadHash?.slice(0, 12)}… (rejected if the history changed meanwhile)</span>
            </div>
          </form>
        </Sheet>
        <Sheet tab="How this record is committed">
          <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
            <li>Evidence files are hashed (SHA-256) when uploaded.</li>
            <li>The record and evidence digests are serialised canonically (sorted keys, no whitespace) with a random nonce.</li>
            <li>keccak256 of that payload is sent to <code>appendRecord()</code>, signed by your demo identity, together with the previous record hash.</li>
            <li>The contract checks your role, the reference rules and the previous hash, then stores the record hash. It has no edit or delete function.</li>
            <li>The full payload is stored off-chain; the integrity checker compares it to the on-chain digest.</li>
          </ol>
        </Sheet>
      </div>
    </>
  );
}
