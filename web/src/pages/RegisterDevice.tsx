import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { roleText, useIdentity } from "../identity.tsx";
import { Link } from "../router.tsx";
import { ErrorNotice, Field, Hash, Notice, PageHead, Sheet } from "../ui.tsx";

export function RegisterDevice() {
  const { meta, actor } = useIdentity();
  const [form, setForm] = useState({ brand: "", model: "", year: "", formFactor: "laptop" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ publicId: string; deviceKey: string; tx: { txHash: string; blockNumber: number; gasUsed: number; recordHash: string } } | null>(null);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.brand.trim()) errs.brand = "Enter the manufacturer, e.g. Lenovo.";
    if (!form.model.trim()) errs.model = "Enter the model name, e.g. ThinkPad T480.";
    if (form.year && !/^\d{4}$/.test(form.year)) errs.year = "Use a four-digit model year.";
    if (/\b[A-Z0-9]{8,}\b/.test(form.model)) errs.model = "This looks like a serial number. Enter the model name only.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await api.post("/api/devices", { ...form, year: form.year ? Number(form.year) : undefined }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        kicker="Section 03 · Registration"
        title="Register a laptop"
        lede="Registration creates a random, opaque public ID and commits a digest of the registration details to the ledger. Only the registrar role can register; the contract rejects anyone else."
      />
      <div className="grid-2">
        <Sheet tab="Registration slip" aside={actor ? `as ${actor.label} · ${roleText(actor)}` : ""}>
          {!actor?.roles.includes("REGISTRAR") && (
            <Notice kind="warn" title="Your current identity does not hold the REGISTRAR role.">
              You can still submit, and the smart contract will reject the transaction. Switch to “Registry Desk” to register.
            </Notice>
          )}
          <ErrorNotice error={error} />
          <form className="form" onSubmit={submit} noValidate>
            <div className="form-row">
              <Field label="Brand" htmlFor="brand" error={errors.brand}>
                <input id="brand" value={form.brand} onChange={set("brand")} maxLength={40} aria-invalid={!!errors.brand} autoComplete="off" />
              </Field>
              <Field label="Model" htmlFor="model" error={errors.model} hint="Model name only — never a serial number.">
                <input id="model" value={form.model} onChange={set("model")} maxLength={60} aria-invalid={!!errors.model} autoComplete="off" />
              </Field>
            </div>
            <div className="form-row">
              <Field label="Model year (optional)" htmlFor="year" error={errors.year}>
                <input id="year" inputMode="numeric" value={form.year} onChange={set("year")} maxLength={4} aria-invalid={!!errors.year} />
              </Field>
              <Field label="Form factor" htmlFor="ff">
                <select id="ff" value={form.formFactor} onChange={set("formFactor")}>
                  {(meta?.formFactors ?? ["laptop"]).map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="row">
              <button className="btn primary" disabled={busy}>
                {busy ? "Committing to ledger…" : "Register and commit"}
              </button>
            </div>
          </form>
        </Sheet>
        <div>
          {done ? (
            <Sheet tab="Committed">
              <Notice kind="ok" title="Device registered.">
                Registration record #000 was mined in block {done.tx.blockNumber}.
              </Notice>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <div className="qr">
                  <img src={`/api/devices/${done.publicId}/qr.svg`} alt={`QR code linking to the public verification page for ${done.publicId}`} />
                  <div className="cap">scan to verify</div>
                </div>
                <dl className="kv" style={{ flex: 1 }}>
                  <dt>Public ID</dt>
                  <dd>
                    <span className="idplate">{done.publicId}</span>
                  </dd>
                  <dt>Device key</dt>
                  <dd>
                    <Hash value={done.deviceKey} />
                  </dd>
                  <dt>Record hash</dt>
                  <dd>
                    <Hash value={done.tx.recordHash} />
                  </dd>
                  <dt>Transaction</dt>
                  <dd>
                    <Hash value={done.tx.txHash} />
                  </dd>
                  <dt>Gas used</dt>
                  <dd className="mono">{done.tx.gasUsed}</dd>
                </dl>
              </div>
              <div className="row" style={{ marginTop: 16 }}>
                <Link className="btn primary" to={`/devices/${done.publicId}`}>
                  Open passport
                </Link>
                <Link className="btn" to={`/verify/${done.publicId}`}>
                  Public verification page
                </Link>
              </div>
            </Sheet>
          ) : (
            <Sheet tab="What is stored where">
              <dl className="kv">
                <dt>On-chain</dt>
                <dd>Device key = keccak256 of the public ID, the registration payload digest, actor address, timestamp.</dd>
                <dt>Off-chain</dt>
                <dd>Brand, model, year and form factor in the local SQLite store, committed by the on-chain digest.</dd>
                <dt>Never</dt>
                <dd>Serial numbers, owner names, addresses, phone numbers or e-mail.</dd>
              </dl>
            </Sheet>
          )}
        </div>
      </div>
    </>
  );
}
