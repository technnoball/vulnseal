import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api.ts";
import { roleText, useIdentity } from "./identity.tsx";
import { Link, match, useLocation } from "./router.tsx";
import { Notice } from "./ui.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Devices } from "./pages/Devices.tsx";
import { RegisterDevice } from "./pages/RegisterDevice.tsx";
import { PassportPage } from "./pages/Passport.tsx";
import { RecordEvent } from "./pages/RecordEvent.tsx";
import { EvidenceViewer } from "./pages/EvidenceViewer.tsx";
import { Disputes } from "./pages/Disputes.tsx";
import { Verify } from "./pages/Verify.tsx";
import { Audit } from "./pages/Audit.tsx";
import { Research } from "./pages/Research.tsx";

const NAV = [
  { to: "/", label: "Ledger overview", idx: "01" },
  { to: "/devices", label: "Device passports", idx: "02" },
  { to: "/devices/new", label: "Register device", idx: "03" },
  { to: "/disputes", label: "Dispute centre", idx: "04" },
  { to: "/audit", label: "Audit & export", idx: "05" },
  { to: "/research", label: "Research benchmark", idx: "06" },
  { to: "/verify", label: "Public verification", idx: "07" },
];

function route(path: string): { el: ReactNode; crumb: string; bare?: boolean } {
  let m;
  if (path === "/") return { el: <Dashboard />, crumb: "01 / Ledger overview" };
  if (path === "/devices") return { el: <Devices />, crumb: "02 / Device passports" };
  if (path === "/devices/new") return { el: <RegisterDevice />, crumb: "03 / Register device" };
  if ((m = match("/devices/:id/record", path))) return { el: <RecordEvent publicId={m.id} />, crumb: `02 / ${m.id} / Record` };
  if ((m = match("/devices/:id", path))) return { el: <PassportPage publicId={m.id} />, crumb: `02 / Passport ${m.id}` };
  if ((m = match("/evidence/:id", path))) return { el: <EvidenceViewer evidenceId={m.id} />, crumb: `Evidence ${m.id}` };
  if (path === "/disputes") return { el: <Disputes />, crumb: "04 / Dispute centre" };
  if (path === "/audit") return { el: <Audit />, crumb: "05 / Audit & export" };
  if (path === "/research") return { el: <Research />, crumb: "06 / Research benchmark" };
  if (path === "/verify") return { el: <Verify />, crumb: "07 / Public verification", bare: true };
  if ((m = match("/verify/:id", path))) return { el: <Verify publicId={m.id} />, crumb: "07 / Public verification", bare: true };
  return { el: <Notice kind="warn" title="Not found.">No page at {path}. <Link to="/">Return to the overview</Link>.</Notice>, crumb: "Not found" };
}

function ChainStatus() {
  const [h, setH] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then((d) => alive && setH(d))
        .catch(() => alive && setH({ ok: false, chain: { error: "API unreachable" } }));
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!h) return <div className="rail-foot">checking node…</div>;
  return (
    <div className="rail-foot" role="status" aria-live="polite">
      <div>
        <span className={"dot" + (h.ok ? "" : " down")} aria-hidden="true" />
        {h.ok ? `chain ${h.chain.chainId} · block ${h.chain.blockNumber}` : "ledger node unavailable"}
      </div>
      {h.ok ? <div title={h.chain.contract}>contract {h.chain.contract.slice(0, 8)}…{h.chain.contract.slice(-4)}</div> : <div>{h.chain?.error?.slice(0, 80)}</div>}
      <div>local only · 127.0.0.1</div>
    </div>
  );
}

function ActorSwitch() {
  const { meta, actor, setActor } = useIdentity();
  if (!meta) return null;
  return (
    <div className="actor-switch">
      <label htmlFor="actor">Acting as</label>
      <select id="actor" value={actor?.id ?? ""} onChange={(e) => setActor(e.target.value)} aria-describedby="actor-roles">
        {meta.identities.map((i) => (
          <option key={i.id} value={i.id}>
            {i.label} — {i.description.replace(" (fictional)", "")}
          </option>
        ))}
      </select>
      <span className="actor-roles" id="actor-roles" title={actor?.address}>
        {roleText(actor)}
      </span>
    </div>
  );
}

export function App() {
  const { path } = useLocation();
  const { metaError } = useIdentity();
  const r = route(path);
  useEffect(() => {
    document.title = `${r.crumb.replace(/^\d+ \/ /, "")} · PatchLedger`;
  }, [r.crumb]);

  if (r.bare) return <main id="main">{r.el}</main>;
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="rail">
        <div className="rail-brand">
          <Link to="/" className="wordmark">
            PatchLedger
          </Link>
          <div className="sub">Repair passport archive · research prototype</div>
        </div>
        <nav aria-label="Primary">
          {NAV.map((n) => {
            const active = n.to === "/" ? path === "/" : n.to === "/devices" ? path === "/devices" || (path.startsWith("/devices/") && path !== "/devices/new") : path.startsWith(n.to);
            return (
              <Link key={n.to} to={n.to} aria-current={active ? "page" : undefined}>
                <span className="idx">{n.idx}</span>
                <span>{n.label}</span>
              </Link>
            );
          })}
        </nav>
        <ChainStatus />
      </aside>
      <div className="main">
        <div className="topbar">
          <span className="crumb">{r.crumb}</span>
          <ActorSwitch />
        </div>
        <main className="content" id="main" tabIndex={-1}>
          {metaError ? <Notice kind="error" title="Cannot reach the PatchLedger API.">{String((metaError as Error).message)}</Notice> : null}
          {r.el}
        </main>
      </div>
    </div>
  );
}

export { api };
