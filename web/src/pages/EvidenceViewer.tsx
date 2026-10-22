import { useState } from "react";
import { api, type EvidenceView } from "../api.ts";
import { useIdentity } from "../identity.tsx";
import { Link } from "../router.tsx";
import { ErrorNotice, Hash, Loading, Notice, PageHead, Sheet, fmtBytes, fmtTime, integrityMark, pad, useLoad } from "../ui.tsx";

type Detail = EvidenceView & { publicId: string; linkedSeq: number | null; createdAt: string };
interface VerifyResult {
  evidenceId: string;
  file: { status: string; expected: string; actual: string | null; checkedAt: string };
  commitment: { seq: number; committedSha256: string; matchesDatabase: boolean; onChainPayloadMatches: boolean | null } | null;
  fileMatchesCommitment: boolean | null;
  verdict: string;
}

export function EvidenceViewer({ evidenceId }: { evidenceId: string }) {
  const { actor } = useIdentity();
  const { data, error, loading, reload } = useLoad(() => api.get<Detail>(`/api/evidence/${encodeURIComponent(evidenceId)}`), [evidenceId, actor?.id]);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [vErr, setVErr] = useState<unknown>(null);

  async function verify() {
    setBusy(true);
    setVErr(null);
    try {
      setResult(await api.post<VerifyResult>(`/api/evidence/${encodeURIComponent(evidenceId)}/verify`));
      reload();
    } catch (e) {
      setVErr(e);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorNotice error={error} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const src = `/api/evidence/${encodeURIComponent(data.id)}/file?as=${encodeURIComponent(actor?.id ?? "")}`;
  const ok = result && result.file.status === "match" && (result.commitment === null || (result.commitment.matchesDatabase && result.fileMatchesCommitment && result.commitment.onChainPayloadMatches !== false));

  return (
    <>
      <PageHead
        kicker={`Evidence · ${data.kind}`}
        title={data.filename}
        lede={data.description || undefined}
        actions={
          <>
            <button className="btn primary" onClick={verify} disabled={busy}>
              {busy ? "Re-hashing…" : "Verify integrity now"}
            </button>
            <Link className="btn" to={`/devices/${data.publicId}${data.linkedSeq !== null ? `#rec-${data.linkedSeq}` : ""}`}>
              Open passport
            </Link>
          </>
        }
      />
      <ErrorNotice error={vErr} />
      {result && (
        <Notice kind={ok ? "ok" : "error"} title={ok ? "Integrity verified." : "Integrity check failed."}>
          {result.verdict}
          <span className="code">recomputed SHA-256 {result.file.actual ?? "(no file)"}</span>
          <span className="code">expected        {result.file.expected}</span>
          {result.commitment && (
            <span className="code">
              committed in {pad(result.commitment.seq)}: {result.commitment.committedSha256} · database matches commitment: {String(result.commitment.matchesDatabase)} · on-chain payload digest matches:{" "}
              {String(result.commitment.onChainPayloadMatches)}
            </span>
          )}
        </Notice>
      )}
      <div className="grid-2">
        <Sheet tab="Original file" aside={data.canViewContent ? data.mime : "contents withheld"}>
          {!data.canViewContent ? (
            <Notice kind="warn" title="Contents withheld for your current identity.">
              This evidence is <b>{data.access}</b>. Its metadata and digest are visible, so anyone can check that a file presented later is the same one — but only the uploader, registrar, inspector or auditor
              {data.access === "shareable" ? " and registered verifiers" : ""} may open it.
            </Notice>
          ) : data.mime.startsWith("image/") ? (
            <img className="viewer-img" src={src} alt={`${data.kind}: ${data.description || data.filename}`} />
          ) : (
            <iframe className="viewer-frame" src={src} title={`Evidence file ${data.filename}`} sandbox={data.mime === "application/pdf" ? undefined : ""} />
          )}
          {data.canViewContent && (
            <p className="small" style={{ marginTop: 8 }}>
              <a href={src} target="_blank" rel="noopener">
                Open in new tab
              </a>{" "}
              · <a href={src + "&download=1"}>Download original</a>
            </p>
          )}
        </Sheet>
        <div>
          <Sheet tab="Provenance">
            <dl className="kv">
              <dt>Evidence ID</dt>
              <dd className="mono">{data.id}</dd>
              <dt>Device</dt>
              <dd>
                <Link to={`/devices/${data.publicId}`} className="mono">
                  {data.publicId}
                </Link>
              </dd>
              <dt>Committed in</dt>
              <dd>{data.linkedSeq !== null ? <Link to={`/devices/${data.publicId}#rec-${data.linkedSeq}`}>record {pad(data.linkedSeq)}</Link> : <span className="muted">not yet committed</span>}</dd>
              <dt>Submitted by</dt>
              <dd>{data.uploadedBy.label}</dd>
              <dt>Uploaded</dt>
              <dd className="mono small">{fmtTime(data.createdAt)}</dd>
              <dt>Type / size</dt>
              <dd>
                {data.mime} · {fmtBytes(data.size)}
              </dd>
              <dt>Access</dt>
              <dd>{data.access}</dd>
              <dt>SHA-256</dt>
              <dd>
                <Hash value={data.sha256} full />
              </dd>
              <dt>Committed</dt>
              <dd>
                <Hash value={data.committedSha256} full />
              </dd>
              <dt>Last check</dt>
              <dd>{integrityMark(data.integrity)}</dd>
            </dl>
          </Sheet>
          {data.reusedElsewhere.length > 0 && (
            <Notice kind="warn" title="Digest reuse.">
              A byte-identical file was also submitted as:{" "}
              {data.reusedElsewhere.map((r) => (
                <span key={r.id}>
                  <Link to={`/evidence/${r.id}`}>{r.id}</Link> ({r.publicId}
                  {r.seq !== null ? ` ${pad(r.seq)}` : ""}){" "}
                </span>
              ))}
              . One receipt supporting several devices can indicate a recycled document.
            </Notice>
          )}
          <Notice title="What a matching digest means.">
            The file has not changed since it was submitted and committed. It does not show the document is genuine or that the work happened.
          </Notice>
        </div>
      </div>
    </>
  );
}
