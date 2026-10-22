import { api, type DeviceSummary } from "../api.ts";
import { Link } from "../router.tsx";
import { ErrorNotice, Loading, PageHead, Sheet, fmtTime, useLoad } from "../ui.tsx";

export function Devices() {
  const { data, error, loading } = useLoad(() => api.get<DeviceSummary[]>("/api/devices"), []);
  return (
    <>
      <PageHead
        kicker="Section 02 · Device passports"
        title="Registered laptops"
        lede="Each passport is an append-only history keyed by a random, opaque public ID. No serial numbers or owner details are stored on-chain."
        actions={
          <Link className="btn primary" to="/devices/new">
            Register device
          </Link>
        }
      />
      <ErrorNotice error={error} />
      {loading && !data && <Loading />}
      {data && (
        <Sheet tab="Passport register" aside={`${data.length} devices`} flush>
          <div className="table-scroll">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Public ID</th>
                  <th scope="col">Device</th>
                  <th scope="col" className="num">Records</th>
                  <th scope="col" className="num">Open disputes</th>
                  <th scope="col">Last recorded</th>
                  <th scope="col">Data</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d) => (
                  <tr key={d.publicId}>
                    <td>
                      <Link to={`/devices/${d.publicId}`} className="mono">
                        {d.publicId}
                      </Link>
                    </td>
                    <td>
                      {d.brand} {d.model} <span className="muted small">{d.year ?? ""} · {d.formFactor}</span>
                    </td>
                    <td className="num">{d.records}</td>
                    <td className="num">{d.openDisputes ? <span className="stamp disputed">{d.openDisputes} open</span> : "0"}</td>
                    <td className="mono small">{fmtTime(d.lastRecordedAt)}</td>
                    <td className="small">{d.synthetic ? <span className="synthetic-tag">synthetic</span> : "entered in app"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Sheet>
      )}
    </>
  );
}
