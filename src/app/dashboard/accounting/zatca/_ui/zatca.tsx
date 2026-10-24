"use client";

// ZATCA Phase 2 A4 — the shared e-invoicing pieces (Direction 2.1, Arabic first): the state labels, the board tile
// (pending / failed / overdue), and the per-invoice panel (ZT-01 «الفوترة الإلكترونية»: state, ICV, hash, the cleared
// stamp, the XML downloads and the resubmit — each behind its own permission; the API re-checks every one).
import Link from "next/link";
import { acctFetch, useApi, useLang } from "@/app/dashboard/accounting/_ui/shell";
import { useState } from "react";

type Tone = "neutral" | "info" | "warning" | "success" | "cancelled" | "danger";
export const Z_STATUS: Record<string, [string, string, Tone]> = {
  PENDING: ["بانتظار الإرسال", "Pending", "warning"],
  CLEARED: ["اعتمدتها الهيئة", "Cleared", "success"],
  CLEARED_WITH_WARNINGS: ["اعتمدتها الهيئة مع ملاحظات", "Cleared with warnings", "info"],
  REPORTED: ["أُبلغت للهيئة", "Reported", "success"],
  REPORTED_WITH_WARNINGS: ["أُبلغت مع ملاحظات", "Reported with warnings", "info"],
  REJECTED: ["رفضتها الهيئة", "Rejected", "danger"],
  ERROR: ["تعذّر الإرسال · يحتاج إجراء", "Not sent · needs action", "danger"],
};
export const CSID_STATE: Record<string, [string, string, Tone]> = {
  NONE: ["بلا شهادة", "No CSID", "neutral"],
  COMPLIANCE: ["شهادة امتثال", "Compliance CSID", "info"],
  PRODUCTION: ["شهادة إنتاج", "Production CSID", "success"],
  RENEWED: ["شهادة إنتاج مجددة", "Production CSID (renewed)", "success"],
  REVOKED: ["موقوفة", "Revoked", "cancelled"],
};
export const ENV_LABEL: Record<string, [string, string]> = {
  OFF: ["موقوفة", "Off"],
  SANDBOX: ["بوابة المطورين (تجربة)", "Developer portal (sandbox)"],
  SIMULATION: ["المحاكاة", "Simulation"],
  PRODUCTION: ["الإنتاج (فعلي)", "Production (live)"],
};
export const FLOW_LABEL: Record<string, [string, string]> = { CLEARANCE: ["اعتماد قبل المشاركة", "Clearance"], REPORTING: ["إبلاغ خلال 24 ساعة", "Reporting (24 h)"] };

export function ZTag({ map, value }: { map: Record<string, [string, string, Tone]>; value: string | null | undefined }) {
  const { L } = useLang();
  const e = value ? map[value] : null;
  return <span className={`hr-dot tone-${e?.[2] ?? "neutral"}`} data-testid={`ztag-${value ?? "none"}`}><span>{e ? L(e[0], e[1]) : value ?? "—"}</span></span>;
}

type Stats = { pending: number; rejected: number; error: number; failed: number; overdue: number; cleared: number; reported: number };

/** The board tile: what waits, what failed, what is about to miss the 24-hour reporting window. */
export function ZatcaTile() {
  const { L } = useLang();
  const o = useApi<{ settings: { effective: string }; queue: Stats }>("/api/accounting/zatca");
  if (!o.data) return null; // no permission (403) or loading: no tile
  const q = o.data.queue;
  const attention = q.failed + q.overdue > 0;
  return (
    <section className="acct-card" data-testid="zatca-tile">
      <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
        <h2>{L("الفوترة الإلكترونية", "E-invoicing")}</h2>
        <span className={`acct-pill ${o.data.settings.effective === "OFF" ? "is-off" : "is-on"}`}>{L(ENV_LABEL[o.data.settings.effective]?.[0] ?? "", ENV_LABEL[o.data.settings.effective]?.[1] ?? "")}</span>
      </div>
      <dl className="acct-kv-grid">
        <div><dt>{L("بانتظار الإرسال", "Pending")}</dt><dd className="hr-num" data-testid="zt-pending">{q.pending}</dd></div>
        <div><dt>{L("مرفوضة أو متعثرة", "Rejected or failed")}</dt><dd className="hr-num" data-testid="zt-failed" style={q.failed ? { color: "var(--hr-danger)" } : undefined}>{q.failed}</dd></div>
        <div><dt>{L("مبسطة لم تُبلَّغ منذ 20 ساعة", "Simplified unreported > 20 h")}</dt><dd className="hr-num" data-testid="zt-overdue" style={q.overdue ? { color: "var(--hr-danger)" } : undefined}>{q.overdue}</dd></div>
        <div><dt>{L("معتمدة · مُبلَّغة", "Cleared · reported")}</dt><dd className="hr-num">{q.cleared} · {q.reported}</dd></div>
      </dl>
      <Link href="/dashboard/accounting/zatca#queue" className="acct-hint">{attention ? L("افتح الطابور واتخذ الإجراء", "Open the queue and act") : L("فتح الفوترة الإلكترونية", "Open e-invoicing")}</Link>
    </section>
  );
}

type Panel = {
  mode: string; invoiceStatus: string; family: string; zatcaStatus: string | null;
  document: null | { id: string; environment: string; icv: string; pih: string; invoiceHash: string; flow: string; status: string; attempts: number; nextAttemptAt: string | null; lastHttpStatus: number | null; lastError: string | null; warnings: { code?: string; message?: string }[] | null; errors: { code?: string; message?: string }[] | null; signedAt: string; decidedAt: string | null; reportingDeadline: string | null; hasCleared: boolean; signedXmlSha256: string };
  can: { view: boolean; onboard: boolean; resubmit: boolean; xml: boolean };
};

/** The invoice's e-invoicing state (ZT-01): A2's «غير مُرسلة» placeholder becomes the live state. */
export function ZatcaPanel({ invoiceId, uuid }: { invoiceId: string; uuid: string }) {
  const { L } = useLang();
  const p = useApi<Panel>(`/api/sales/invoices/${invoiceId}/zatca`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const d = p.data?.document;
  const resubmit = async () => {
    if (!d) return;
    setBusy(true); setMsg(null);
    try { await acctFetch(`/api/accounting/zatca/documents/${d.id}/submit`, { method: "POST", json: {} }); p.reload(); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="acct-card" data-testid="state-zatca">
      <h3>{L("الفوترة الإلكترونية", "E-invoicing")}</h3>
      {!p.data ? <span className="acct-hint">…</span> : !d ? (
        <>
          <span className="inv-chip">{p.data.invoiceStatus !== "ISSUED" ? L("تُوقَّع عند الإصدار", "Signed at issue") : L("صدرت قبل تشغيل الربط · لم تُرسل", "Issued before e-invoicing was on · not sent")}</span>
          <span className="acct-hint">{L("الوضع: ", "Mode: ")}{L(ENV_LABEL[p.data.mode]?.[0] ?? p.data.mode, ENV_LABEL[p.data.mode]?.[1] ?? p.data.mode)}</span>
        </>
      ) : (
        <>
          <ZTag map={Z_STATUS} value={d.status} />
          {d.status === "CLEARED" || d.status === "CLEARED_WITH_WARNINGS" ? <span className="inv-chip" data-testid="zatca-cleared-stamp">{L("✓ معتمدة من الهيئة · يجوز تسليمها للعميل", "✓ Cleared by ZATCA · may be shared")}</span> : null}
          {d.flow === "CLEARANCE" && d.status === "PENDING" ? <span className="acct-hint" style={{ color: "var(--hr-warning)" }}>{L("لا تُسلَّم للعميل قبل اعتماد الهيئة.", "Do not share before ZATCA clears it.")}</span> : null}
          {d.status === "REJECTED" ? <span className="acct-hint" style={{ color: "var(--hr-danger)" }}>{L("تبقى الفاتورة صادرة؛ صحّحها بإشعار دائن ثم أصدر فاتورة جديدة.", "The invoice stays issued: correct it with a credit note, then issue a new invoice.")}</span> : null}
          <dl className="acct-kv-grid" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
            <div><dt>{L("المسار · البيئة", "Flow · environment")}</dt><dd>{L(FLOW_LABEL[d.flow]?.[0] ?? d.flow, FLOW_LABEL[d.flow]?.[1] ?? d.flow)} · {L(ENV_LABEL[d.environment]?.[0] ?? d.environment, ENV_LABEL[d.environment]?.[1] ?? d.environment)}</dd></div>
            <div><dt>{L("عدّاد الفواتير (ICV)", "Invoice counter (ICV)")}</dt><dd className="hr-num" data-testid="zatca-icv">{d.icv}</dd></div>
            <div><dt>{L("بصمة الفاتورة", "Invoice hash")}</dt><dd><bdi className="acct-code" style={{ whiteSpace: "normal", wordBreak: "break-all" }} data-testid="zatca-hash">{d.invoiceHash}</bdi></dd></div>
            <div><dt>{L("بصمة الفاتورة السابقة (PIH)", "Previous hash (PIH)")}</dt><dd><bdi className="acct-code" style={{ whiteSpace: "normal", wordBreak: "break-all" }}>{d.pih}</bdi></dd></div>
            <div><dt>{L("المحاولات", "Attempts")}</dt><dd className="hr-num">{d.attempts}{d.lastHttpStatus ? ` · HTTP ${d.lastHttpStatus}` : ""}{d.lastError ? ` · ${d.lastError}` : ""}</dd></div>
            {d.reportingDeadline && !d.decidedAt ? <div><dt>{L("آخر موعد للإبلاغ", "Reporting deadline")}</dt><dd className="hr-num">{new Date(d.reportingDeadline).toLocaleString("en-GB", { timeZone: "Asia/Riyadh" })}</dd></div> : null}
          </dl>
          {[...(d.errors ?? []), ...(d.warnings ?? [])].length ? (
            <ul className="acct-hint" style={{ margin: 0, paddingInlineStart: 16 }} data-testid="zatca-messages">
              {(d.errors ?? []).map((m, i) => <li key={`e${i}`} style={{ color: "var(--hr-danger)" }}><bdi dir="ltr">{m.code}: {m.message}</bdi></li>)}
              {(d.warnings ?? []).map((m, i) => <li key={`w${i}`}><bdi dir="ltr">{m.code}: {m.message}</bdi></li>)}
            </ul>
          ) : null}
          <div className="acct-actions">
            {p.data.can.xml ? <a className="hr-btn is-sm" href={`/api/sales/invoices/${invoiceId}/zatca/xml?kind=signed`} data-testid="zatca-xml-signed">{L("XML الموقّع", "Signed XML")}</a> : null}
            {p.data.can.xml && d.hasCleared ? <a className="hr-btn is-sm" href={`/api/sales/invoices/${invoiceId}/zatca/xml?kind=cleared`} data-testid="zatca-xml-cleared">{L("XML المعتمد من الهيئة", "Cleared XML")}</a> : null}
            {p.data.can.resubmit && (d.status === "PENDING" || d.status === "ERROR") ? <button type="button" className="hr-btn is-sm" disabled={busy} onClick={resubmit} data-testid="zatca-resubmit">{L("إرسال الآن", "Send now")}</button> : null}
          </div>
          {msg ? <span role="alert" className="acct-hint" style={{ color: "var(--hr-danger)" }}>{msg}</span> : null}
        </>
      )}
      <span className="acct-hint">UUID <bdi className="acct-code">{uuid}</bdi></span>
    </div>
  );
}
