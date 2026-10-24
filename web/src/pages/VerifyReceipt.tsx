import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../api.ts";
import { Check, ErrorNotice, Field, Notice, PageHead, Sheet, useAction } from "../ui.tsx";

export function VerifyReceipt() {
  const [receipt, setReceipt] = useState("");
  const [reveal, setReveal] = useState("");
  const [res, setRes] = useState<any>(null);
  const act = useAction();
  const load = (set: (s: string) => void) => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) set(await f.text());
  };
  const verify = () =>
    act.run("verify", async () => {
      let r: unknown, p: unknown;
      try {
        r = JSON.parse(receipt);
      } catch {
        throw new Error("The receipt is not valid JSON.");
      }
      if (reveal.trim()) {
        try {
          p = JSON.parse(reveal);
        } catch {
          throw new Error("The reveal package is not valid JSON.");
        }
      }
      setRes(await api.post("/api/verify/receipt", { receipt: r, reveal: p }));
    });
  return (
    <>
      <PageHead
        kicker="Receipt verifier · no sign-in needed"
        title="Check a commitment receipt against the chain"
        lede="Paste or load a receipt. Optionally add the researcher's reveal package to check that a specific report opens the commitment. The check reads the contract and the transaction directly from the ledger node."
      />
      <div className="grid-2">
        <Sheet tab="Inputs">
          <div className="form">
            <Field label="Receipt (JSON)" htmlFor="rcpt">
              <textarea id="rcpt" value={receipt} onChange={(e) => setReceipt(e.target.value)} placeholder='{"format":"vulnseal.receipt.v1", ...}' style={{ minHeight: 160, fontFamily: "var(--font-mono)", fontSize: 12 }} />
            </Field>
            <input type="file" accept=".json" aria-label="Load receipt file" onChange={load(setReceipt)} />
            <Field label="Reveal package (optional, private)" htmlFor="pkg" hint="Contains the nonce. Only paste it where you intend to reveal.">
              <textarea id="pkg" value={reveal} onChange={(e) => setReveal(e.target.value)} style={{ minHeight: 100, fontFamily: "var(--font-mono)", fontSize: 12 }} />
            </Field>
            <input type="file" accept=".json" aria-label="Load reveal package file" onChange={load(setReveal)} />
            <div>
              <button className="btn primary" onClick={verify} disabled={!receipt.trim() || !!act.busy}>
                <ShieldCheck size={16} aria-hidden="true" /> {act.busy ? "Verifying…" : "Verify"}
              </button>
            </div>
          </div>
          <ErrorNotice error={act.error} />
        </Sheet>
        <div>
          {res && (
            <Sheet tab="Result">
              <Notice kind={res.verdict === "valid" ? "ok" : "error"} title={`Receipt ${res.verdict}.`}>
                {res.verdict === "incomplete" ? `Missing fields: ${res.missing.join(", ")}.` : res.verdict === "valid" ? "Every field matches the ledger." : "At least one field does not match the ledger."}
              </Notice>
              <ul className="checklist">
                {res.checks.map((c: any) => (
                  <li key={c.check}>
                    <Check ok={c.ok}>{c.check}</Check>
                    <span className="small muted">{c.detail}</span>
                  </li>
                ))}
              </ul>
              {res.reveal && (
                <Notice kind={res.reveal.outcome === "match" ? "ok" : "error"} title={`Reveal: ${res.reveal.outcome}.`}>
                  {res.reveal.outcome === "match"
                    ? "This report and nonce open the recorded commitment."
                    : res.reveal.outcome === "mismatch"
                      ? "This content does not open the recorded commitment: it differs from what was committed."
                      : (res.reveal.missing ?? res.reveal.problems ?? []).join("; ")}
                </Notice>
              )}
            </Sheet>
          )}
          <Notice title="Interpreting a valid receipt.">
            It shows that the commitment was recorded by that address, for that program and policy version, at that block. It does not show that the report is true or who discovered the issue first in the
            real world.
          </Notice>
        </div>
      </div>
    </>
  );
}
