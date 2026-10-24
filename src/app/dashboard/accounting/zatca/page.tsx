"use client";

// «المحاسبة · الفوترة الإلكترونية» — ZATCA Phase 2 A4 (Figma ZT-20 read-only setup, extended by the owner-approved
// onboarding the design left open: S-4 / ZT-30). Direction 2.1, Arabic first. Sections: the state (environment, EGS
// unit, certificate, last check, send mode), the switch, the EGS units with their onboarding wizard (OTP → compliance
// CSID → compliance checks → production CSID; renewal; revoke), a new unit, the numbering cut-over from the previous
// system, the queue monitor and the Fatoora log. No key, token, secret or OTP is ever shown or kept in the page.
import { useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { AcctShell, Msg, useApi, useLang, useWrite } from "../_ui/shell";
import { CSID_STATE, ENV_LABEL, FLOW_LABEL, Z_STATUS, ZTag, ZatcaTile } from "./_ui/zatca";
import Link from "next/link";

type Csid = { id: string; kind: string; requestId: string; certSerial: string; certIssuer: string; certNotBefore: string | null; certNotAfter: string | null; status: string; createdAt: string } | null;
type Unit = {
  id: string; environment: string; name: string; commonName: string; serialNumber: string; organizationName: string; branchName: string; vatNumber: string; invoiceTypes: string;
  location: string; industry: string; csidState: string; keyVersion: number; hasKey: boolean; renewalPending: boolean; icv: string; lastHash: string; lastDocumentAt: string | null;
  complianceChecks: { type: string; ok: boolean; httpStatus: number | null; status: string | null; warnings: number; errors: { code?: string; message?: string }[] }[] | null;
  complianceCheckedAt: string | null; retiredAt: string | null; compliance: Csid; production: Csid;
};
type Overview = {
  settings: { stored: string; effective: string; activeEgsId: string | null; updatedAt: string | null };
  server: { enabled: boolean; productionAllowed: boolean; keyConfigured: boolean; cronSecretConfigured: boolean; endpoints: Record<string, string> };
  units: Unit[]; queue: { pending: number; failed: number; overdue: number; cleared: number; reported: number };
  counters: { series: string; value: number }[];
  can: { view: boolean; onboard: boolean; resubmit: boolean; xml: boolean };
};
type Doc = { id: string; invoiceId: string; number: string | null; kind: string | null; family: string | null; grandTotal: string | null; buyerName: string | null; environment: string; icv: string; flow: string; status: string; attempts: number; lastHttpStatus: number | null; lastError: string | null; signedAt: string; reportingDeadline: string | null };
type Log = { id: string; action: string; environment: string; endpoint: string; httpStatus: number | null; outcome: string; durationMs: number | null; at: string };

const TYPES: Record<string, [string, string]> = {
  STANDARD_INVOICE: ["فاتورة ضريبية", "Standard invoice"], STANDARD_CREDIT_NOTE: ["إشعار دائن ضريبي", "Standard credit note"], STANDARD_DEBIT_NOTE: ["إشعار مدين ضريبي", "Standard debit note"],
  SIMPLIFIED_INVOICE: ["فاتورة مبسطة", "Simplified invoice"], SIMPLIFIED_CREDIT_NOTE: ["إشعار دائن مبسط", "Simplified credit note"], SIMPLIFIED_DEBIT_NOTE: ["إشعار مدين مبسط", "Simplified debit note"],
};
const riyadh = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "short", timeStyle: "short" }) : "—");

export default function ZatcaPage() {
  const { L } = useLang();
  const o = useApi<Overview>("/api/accounting/zatca");
  const w = useWrite();
  const [view, setView] = useState<"attention" | "overdue" | "all">("attention");
  const docs = useApi<{ documents: Doc[] }>(o.data ? `/api/accounting/zatca/documents${view === "all" ? "" : `?view=${view}`}` : null);
  const log = useApi<{ log: Log[] }>(o.data ? "/api/accounting/zatca/log" : null);
  const d = o.data;
  const reload = () => { o.reload(); docs.reload(); log.reload(); };
  const active = d?.units.find((u) => u.id === d.settings.activeEgsId) ?? null;
  return (
    <AcctShell>
      <Msg error={o.error ?? w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!d ? (o.error ? null : <OpsLoading />) : (
        <>
          <div className="acct-cards">
            <section className="acct-card" data-testid="zatca-state">
              <h2>{L("الفوترة الإلكترونية · الإعداد", "E-invoicing · setup")}</h2>
              <dl className="acct-kv-grid">
                <div><dt>{L("البيئة الفعلية", "Effective environment")}</dt><dd data-testid="zatca-effective">{L(ENV_LABEL[d.settings.effective][0], ENV_LABEL[d.settings.effective][1])}{d.settings.stored !== d.settings.effective ? L(` (المحفوظ: ${ENV_LABEL[d.settings.stored]?.[0]} — لا يسمح به الخادم)`, ` (stored: ${ENV_LABEL[d.settings.stored]?.[1]} — not allowed by the server)`) : ""}</dd></div>
                <div><dt>{L("وحدة إصدار الفواتير", "EGS unit")}</dt><dd>{active ? <><bdi>{active.name}</bdi> · <ZTag map={CSID_STATE} value={active.csidState} /></> : L("لا توجد وحدة فعالة", "No active unit")}</dd></div>
                <div><dt>{L("الشهادة", "Certificate")}</dt><dd>{active?.production ? L(`سارية حتى ${riyadh(active.production.certNotAfter)}`, `Valid until ${riyadh(active.production.certNotAfter)}`) : "—"}</dd></div>
                <div><dt>{L("عدّاد الوحدة (ICV)", "Unit counter (ICV)")}</dt><dd className="hr-num">{active?.icv ?? "—"}</dd></div>
                <div><dt>{L("طريقة الإرسال", "Send mode")}</dt><dd>{L("تلقائي بعد الإصدار: الضريبية تُعتمد فورًا، والمبسطة تُبلَّغ خلال 24 ساعة؛ إعادة الإرسال يدويًا من الطابور", "Automatic after issue: standard cleared at once, simplified reported within 24 h; manual resend from the queue")}</dd></div>
                <div><dt>{L("الخادم", "Server")}</dt><dd className="acct-hint" data-testid="zatca-server">
                  {d.server.enabled ? L("الربط مسموح", "Enabled") : L("الربط موقوف (ZATCA_ENABLED)", "Disabled (ZATCA_ENABLED)")} · {d.server.productionAllowed ? L("الإنتاج مسموح", "production allowed") : L("الإنتاج غير مسموح", "production not allowed")} · {d.server.keyConfigured ? L("مفتاح التشفير مهيأ", "encryption key set") : L("مفتاح التشفير غير مهيأ", "encryption key missing")} · {d.server.cronSecretConfigured ? L("سر الجدولة مهيأ", "cron secret set") : L("سر الجدولة غير مهيأ", "cron secret missing")}
                  {d.server.endpoints.SANDBOX === "mock" ? L(" · بيئة التجربة موجهة إلى خادم محاكاة محلي", " · sandbox points at a local mock") : ""}
                </dd></div>
              </dl>
              <p className="acct-hint">{L("لا تُعرض المفاتيح ولا الأسرار ولا رموز التحقق إطلاقًا؛ رمز التحقق يُستخدم مرة واحدة ولا يُحفظ.", "Keys, secrets and OTPs are never shown; an OTP is used once and never stored.")}</p>
            </section>
            <ZatcaTile key={`${d.queue.pending}:${d.queue.failed}`} />
          </div>

          {d.can.onboard ? <SwitchCard d={d} w={w} reload={reload} /> : null}

          <section className="acct-card" data-testid="zatca-units">
            <h2>{L("وحدات إصدار الفواتير (EGS)", "EGS units")}</h2>
            <p className="acct-hint">{L("هذا النظام وحدة مستقلة: شهادتها وعدّادها وسلسلة بصماتها خاصة بها، منفصلة عن أي نظام آخر (قيود، فودكس).", "This ERP is its own EGS solution: its own CSID, counter and hash chain, separate from any other system (Qoyod, Foodics).")}</p>
            {d.units.length === 0 ? <p className="acct-hint">{L("لا توجد وحدات بعد.", "No units yet.")}</p> : d.units.map((u) => <UnitCard key={u.id} u={u} canOnboard={d.can.onboard} w={w} reload={reload} active={u.id === d.settings.activeEgsId} />)}
          </section>

          {d.can.onboard ? <NewUnit w={w} reload={reload} /> : null}
          {d.can.onboard ? <Numbering d={d} w={w} reload={reload} /> : null}

          <section className="acct-card" id="queue" data-testid="zatca-queue">
            <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
              <h2>{L("طابور الإرسال", "Submission queue")}</h2>
              <div className="acct-actions">
                <div className="acct-seg" role="group">
                  {(["attention", "overdue", "all"] as const).map((v) => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{v === "attention" ? L("تحتاج إجراء", "Needs action") : v === "overdue" ? L("متأخرة (> 20 ساعة)", "Overdue (> 20 h)") : L("الكل", "All")}</button>)}
                </div>
                {d.can.resubmit ? <button type="button" className="hr-btn is-sm" disabled={!!w.busy} data-testid="zatca-process" onClick={async () => { const r = await w.run<{ processed: number }>("q", "/api/accounting/zatca/queue", "POST", {}); if (r) { w.setDone(L(`عولج ${r.processed} مستند`, `${r.processed} processed`)); reload(); } }}>{L("معالجة الطابور الآن", "Process now")}</button> : null}
              </div>
            </div>
            {!docs.data ? <OpsLoading /> : docs.data.documents.length === 0 ? <p className="acct-hint" data-testid="zatca-queue-empty">{L("لا شيء هنا.", "Nothing here.")}</p> : (
              <div className="hr-tablewrap">
                <table className="hr-table is-dense">
                  <thead><tr><th>{L("المستند", "Document")}</th><th className="acct-hide-m">{L("المشتري", "Buyer")}</th><th className="num">ICV</th><th className="acct-hide-m">{L("المسار", "Flow")}</th><th>{L("الحالة", "State")}</th><th className="acct-hide-m">{L("المحاولات", "Attempts")}</th><th className="acct-hide-m">{L("التوقيع", "Signed")}</th><th></th></tr></thead>
                  <tbody>
                    {docs.data.documents.map((x) => (
                      <tr key={x.id} data-testid={`zq-${x.number}`}>
                        <td><Link href={`/dashboard/sales/invoices/${x.invoiceId}`}><bdi className="acct-code">{x.number}</bdi></Link></td>
                        <td className="acct-hide-m"><bdi>{x.buyerName ?? "—"}</bdi></td>
                        <td className="num hr-num">{x.icv}</td>
                        <td className="acct-hide-m">{L(FLOW_LABEL[x.flow][0], FLOW_LABEL[x.flow][1])}</td>
                        <td><ZTag map={Z_STATUS} value={x.status} />{x.lastError ? <div className="acct-hint"><bdi dir="ltr">{x.lastError}</bdi></div> : null}</td>
                        <td className="acct-hide-m hr-num">{x.attempts}{x.lastHttpStatus ? ` · ${x.lastHttpStatus}` : ""}</td>
                        <td className="acct-hide-m hr-num">{riyadh(x.signedAt)}</td>
                        <td>{d.can.resubmit && (x.status === "PENDING" || x.status === "ERROR") ? <button type="button" className="hr-btn is-sm" disabled={!!w.busy} onClick={async () => { if (await w.run("s" + x.id, `/api/accounting/zatca/documents/${x.id}/submit`, "POST", {}, L("أُرسل", "Sent"))) reload(); }}>{L("إرسال", "Send")}</button> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="acct-hint">{L("المرفوض لا يُعاد إرساله: تبقى الفاتورة صادرة، وتُصحَّح بإشعار دائن ثم فاتورة جديدة.", "A rejected document is never resent: the invoice stays issued and is corrected with a credit note and a new invoice.")}</p>
          </section>

          <section className="acct-card" data-testid="zatca-log">
            <h2>{L("سجل الاتصال بالهيئة", "Fatoora log")}</h2>
            {!log.data ? <OpsLoading /> : log.data.log.length === 0 ? <p className="acct-hint">{L("لا شيء بعد.", "Nothing yet.")}</p> : (
              <div className="hr-tablewrap">
                <table className="hr-table is-dense">
                  <thead><tr><th>{L("الوقت", "Time")}</th><th>{L("الإجراء", "Action")}</th><th className="acct-hide-m">{L("البيئة", "Environment")}</th><th>HTTP</th><th>{L("النتيجة", "Outcome")}</th><th className="acct-hide-m num">ms</th></tr></thead>
                  <tbody>
                    {log.data.log.slice(0, 50).map((l) => (
                      <tr key={l.id}><td className="hr-num">{riyadh(l.at)}</td><td><bdi className="acct-code">{l.action}</bdi></td><td className="acct-hide-m">{ENV_LABEL[l.environment] ? L(ENV_LABEL[l.environment][0], ENV_LABEL[l.environment][1]) : l.environment}</td><td className="hr-num">{l.httpStatus ?? "—"}</td><td><bdi dir="ltr">{l.outcome}</bdi></td><td className="acct-hide-m num hr-num">{l.durationMs ?? ""}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </AcctShell>
  );
}

type W = ReturnType<typeof useWrite>;

function SwitchCard({ d, w, reload }: { d: Overview; w: W; reload: () => void }) {
  const { L } = useLang();
  const [mode, setMode] = useState(d.settings.stored);
  const [egs, setEgs] = useState(d.settings.activeEgsId ?? "");
  const eligible = d.units.filter((u) => u.environment === mode && (u.csidState === "PRODUCTION" || u.csidState === "RENEWED") && !u.retiredAt);
  return (
    <section className="acct-card" data-testid="zatca-switch">
      <h2>{L("تشغيل الربط", "The e-invoicing switch")}</h2>
      <div className="acct-row">
        <label className="hr-field"><span className="hr-label">{L("الوضع", "Mode")}</span>
          <Select value={mode} onChange={(e) => setMode(e.target.value)} data-testid="zatca-mode">
            {["OFF", "SANDBOX", "SIMULATION", "PRODUCTION"].map((m) => <option key={m} value={m}>{L(ENV_LABEL[m][0], ENV_LABEL[m][1])}</option>)}
          </Select></label>
        {mode !== "OFF" ? <label className="hr-field acct-grow"><span className="hr-label">{L("الوحدة التي توقّع", "Signing unit")}</span>
          <Select value={egs} onChange={(e) => setEgs(e.target.value)} data-testid="zatca-active-egs">
            <option value="">{L("اختر وحدة تحمل شهادة إنتاج لهذه البيئة", "Choose a unit with a production CSID for this environment")}</option>
            {eligible.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.serialNumber.slice(-12)}</option>)}
          </Select></label> : null}
        <button type="button" className="hr-btn is-primary" disabled={!!w.busy} data-testid="zatca-save-mode" onClick={async () => { if (await w.run("mode", "/api/accounting/zatca", "PUT", { mode, activeEgsId: egs || null }, L("حُفظ الوضع", "Saved"))) reload(); }}>{L("حفظ", "Save")}</button>
      </div>
      <p className="acct-hint">{L("عند التشغيل: كل فاتورة تُصدر تأخذ رقم العدّاد التالي وتُوقَّع فورًا. الإنتاج يرسل للهيئة إرسالًا نهائيًا ملزمًا، ويحتاج إذن الخادم (ZATCA_PRODUCTION_ALLOWED).", "When on, every issued invoice takes the next counter value and is signed at once. Production sends to ZATCA for real and needs the server's permission (ZATCA_PRODUCTION_ALLOWED).")}</p>
    </section>
  );
}

function UnitCard({ u, canOnboard, w, reload, active }: { u: Unit; canOnboard: boolean; w: W; reload: () => void; active: boolean }) {
  const { L } = useLang();
  const [otp, setOtp] = useState("");
  const [reason, setReason] = useState("");
  const step = async (name: string, body: Record<string, unknown> = {}, ok?: string) => {
    const r = await w.run(name + u.id, `/api/accounting/zatca/egs/${u.id}/${name}`, "POST", body, ok);
    setOtp("");
    if (r) reload();
  };
  const st = u.csidState;
  const checks = u.complianceChecks ?? [];
  return (
    <div className="acct-card" data-testid={`egs-${u.name}`} style={{ borderStyle: active ? "solid" : "dashed" }}>
      <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
        <h3><bdi>{u.name}</bdi> {active ? <span className="acct-pill is-on">{L("الوحدة الموقّعة", "Signing unit")}</span> : null}</h3>
        <ZTag map={CSID_STATE} value={st} />
      </div>
      <dl className="acct-kv-grid">
        <div><dt>{L("البيئة", "Environment")}</dt><dd>{L(ENV_LABEL[u.environment][0], ENV_LABEL[u.environment][1])}</dd></div>
        <div><dt>{L("الرقم التسلسلي", "Serial")}</dt><dd><bdi className="acct-code" style={{ whiteSpace: "normal", wordBreak: "break-all" }}>{u.serialNumber}</bdi></dd></div>
        <div><dt>{L("الفرع · النشاط", "Branch · industry")}</dt><dd><bdi>{u.branchName}</bdi> · <bdi>{u.industry}</bdi></dd></div>
        <div><dt>{L("أنواع الفواتير (TSCZ)", "Invoice types (TSCZ)")}</dt><dd className="hr-num">{u.invoiceTypes}</dd></div>
        <div><dt>ICV</dt><dd className="hr-num" data-testid={`egs-icv-${u.name}`}>{u.icv}</dd></div>
        <div><dt>{L("الشهادة", "Certificate")}</dt><dd className="hr-num">{u.production ? `${riyadh(u.production.certNotAfter)}` : u.compliance ? L("امتثال", "compliance") : "—"}</dd></div>
      </dl>
      {canOnboard && !u.retiredAt ? (
        <ol className="acct-checks" data-testid={`egs-wizard-${u.name}`}>
          <li><span className={st !== "NONE" ? "ok" : "no"} aria-hidden="true">{st !== "NONE" ? "●" : "○"}</span>{L("1 · رمز التحقق من بوابة فاتورة ← شهادة الامتثال", "1 · OTP from the Fatoora portal → compliance CSID")}</li>
          <li><span className={u.complianceCheckedAt ? "ok" : "no"} aria-hidden="true">{u.complianceCheckedAt ? "●" : "○"}</span>{L("2 · فحوص الامتثال لكل نوع مستند", "2 · Compliance checks for every document type")}</li>
          <li><span className={st === "PRODUCTION" || st === "RENEWED" ? "ok" : "no"} aria-hidden="true">{st === "PRODUCTION" || st === "RENEWED" ? "●" : "○"}</span>{L("3 · شهادة الإنتاج", "3 · Production CSID")}</li>
        </ol>
      ) : null}
      {checks.length ? (
        <ul className="acct-hint" style={{ margin: 0, paddingInlineStart: 16 }} data-testid={`egs-checks-${u.name}`}>
          {checks.map((c) => <li key={c.type} style={{ color: c.ok ? "var(--hr-success)" : "var(--hr-danger)" }}>{L(TYPES[c.type]?.[0] ?? c.type, TYPES[c.type]?.[1] ?? c.type)}: {c.ok ? L("ناجح", "passed") : L("لم ينجح", "failed")}{c.warnings ? L(` · ${c.warnings} ملاحظة`, ` · ${c.warnings} warning(s)`) : ""}{c.errors.length ? ` · ${c.errors.map((e) => e.code).join(", ")}` : ""}</li>)}
        </ul>
      ) : null}
      {canOnboard && !u.retiredAt ? (
        <div className="acct-row">
          {st === "NONE" || st === "PRODUCTION" || st === "RENEWED" ? (
            <label className="hr-field"><span className="hr-label">{L("رمز التحقق (OTP) من بوابة فاتورة", "OTP from the Fatoora portal")}</span>
              <input className="hr-input acct-amount" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} data-testid={`egs-otp-${u.name}`} /></label>
          ) : null}
          {st === "NONE" ? <button type="button" className="hr-btn is-primary" disabled={!!w.busy || otp.length !== 6} data-testid={`egs-compliance-${u.name}`} onClick={() => step("compliance-csid", { otp }, L("صدرت شهادة الامتثال", "Compliance CSID issued"))}>{L("طلب شهادة الامتثال", "Request the compliance CSID")}</button> : null}
          {st === "COMPLIANCE" ? <button type="button" className="hr-btn is-primary" disabled={!!w.busy} data-testid={`egs-checks-run-${u.name}`} onClick={() => step("compliance-checks", {}, L("اكتملت فحوص الامتثال", "Compliance checks done"))}>{L("تشغيل فحوص الامتثال", "Run the compliance checks")}</button> : null}
          {st === "COMPLIANCE" && u.complianceCheckedAt ? <button type="button" className="hr-btn is-primary" disabled={!!w.busy} data-testid={`egs-production-${u.name}`} onClick={() => step("production-csid", {}, L("صدرت شهادة الإنتاج", "Production CSID issued"))}>{L("طلب شهادة الإنتاج", "Request the production CSID")}</button> : null}
          {st === "PRODUCTION" || st === "RENEWED" ? <button type="button" className="hr-btn" disabled={!!w.busy || otp.length !== 6} data-testid={`egs-renew-${u.name}`} onClick={() => step("renew", { otp }, L("جُددت الشهادة", "CSID renewed"))}>{L("تجديد الشهادة", "Renew the CSID")}</button> : null}
        </div>
      ) : null}
      {canOnboard && !u.retiredAt && st !== "NONE" ? (
        <details>
          <summary className="acct-hint">{L("إيقاف الوحدة", "Revoke the unit")}</summary>
          <div className="acct-row">
            <label className="hr-field acct-grow"><span className="hr-label">{L("السبب", "Reason")}</span><input className="hr-input" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <button type="button" className="hr-btn is-danger" disabled={!!w.busy || reason.trim().length < 3} onClick={() => step("revoke", { reason }, L("أُوقفت الوحدة", "Unit revoked"))}>{L("إيقاف", "Revoke")}</button>
          </div>
          <p className="acct-hint">{L("يوقف التوقيع من هذه الوحدة هنا؛ إلغاء الشهادة لدى الهيئة يتم من بوابة فاتورة.", "Stops this unit signing here; revoking the certificate at ZATCA is done on the Fatoora portal.")}</p>
        </details>
      ) : null}
    </div>
  );
}

function NewUnit({ w, reload }: { w: W; reload: () => void }) {
  const { L } = useLang();
  const [f, setF] = useState({ environment: "SANDBOX", name: "", branchName: "", location: "", industry: "", invoiceTypes: "1100" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="acct-card" data-testid="zatca-new-unit">
      <h2>{L("وحدة جديدة", "New EGS unit")}</h2>
      <div className="acct-row">
        <label className="hr-field"><span className="hr-label">{L("البيئة", "Environment")}</span>
          <Select value={f.environment} onChange={set("environment")} data-testid="new-egs-env">{["SANDBOX", "SIMULATION", "PRODUCTION"].map((m) => <option key={m} value={m}>{L(ENV_LABEL[m][0], ENV_LABEL[m][1])}</option>)}</Select></label>
        <label className="hr-field"><span className="hr-label">{L("اسم الوحدة", "Unit name")}</span><input className="hr-input" value={f.name} onChange={set("name")} data-testid="new-egs-name" /></label>
        <label className="hr-field"><span className="hr-label">{L("الفرع (OU)", "Branch (OU)")}</span><input className="hr-input" value={f.branchName} onChange={set("branchName")} data-testid="new-egs-branch" /></label>
        <label className="hr-field acct-grow"><span className="hr-label">{L("العنوان المسجل", "Registered address")}</span><input className="hr-input" value={f.location} onChange={set("location")} data-testid="new-egs-location" /></label>
        <label className="hr-field"><span className="hr-label">{L("النشاط", "Industry")}</span><input className="hr-input" value={f.industry} onChange={set("industry")} data-testid="new-egs-industry" /></label>
        <label className="hr-field"><span className="hr-label">{L("أنواع الفواتير", "Invoice types")}</span>
          <Select value={f.invoiceTypes} onChange={set("invoiceTypes")}>
            <option value="1100">{L("ضريبية ومبسطة (1100)", "Standard + simplified (1100)")}</option>
            <option value="1000">{L("ضريبية فقط (1000)", "Standard only (1000)")}</option>
            <option value="0100">{L("مبسطة فقط (0100)", "Simplified only (0100)")}</option>
          </Select></label>
        <button type="button" className="hr-btn is-primary" disabled={!!w.busy} data-testid="new-egs-create" onClick={async () => { if (await w.run("new", "/api/accounting/zatca/egs", "POST", f, L("أُنشئت الوحدة ومفتاحها", "Unit and key created"))) { setF({ ...f, name: "" }); reload(); } }}>{L("إنشاء الوحدة والمفتاح", "Create unit and key")}</button>
      </div>
      <p className="acct-hint">{L("الرقم الضريبي واسم المنشأة من إعدادات الفوترة. يُولَّد المفتاح الخاص على الخادم ويُحفظ مشفّرًا ولا يغادره.", "VAT number and legal name come from the invoicing settings. The private key is generated on the server, stored encrypted, and never leaves it.")}</p>
    </section>
  );
}

function Numbering({ d, w, reload }: { d: Overview; w: W; reload: () => void }) {
  const { L } = useLang();
  const [series, setSeries] = useState("INV");
  const [next, setNext] = useState("");
  return (
    <section className="acct-card" data-testid="zatca-numbering">
      <h2>{L("الانتقال من النظام السابق · استمرار الترقيم", "Cut-over from the previous system · numbering")}</h2>
      <p className="acct-hint">{L("أوقف الإصدار في النظام السابق أولًا، ثم حدّد الرقم التالي لكل سلسلة (مثال: آخر فاتورة في قيود INV316 ← الرقم التالي 317). يُضبط قبل أول إصدار من السلسلة فقط.", "Stop issuing in the previous system first, then set each series' next number (e.g. Qoyod's last invoice INV316 → next 317). Only before the series' first issue here.")}</p>
      <div className="acct-row">
        <label className="hr-field"><span className="hr-label">{L("السلسلة", "Series")}</span><input className="hr-input acct-amount" value={series} onChange={(e) => setSeries(e.target.value.toUpperCase())} data-testid="num-series" /></label>
        <label className="hr-field"><span className="hr-label">{L("الرقم التالي", "Next number")}</span><input className="hr-input acct-amount" inputMode="numeric" value={next} onChange={(e) => setNext(e.target.value.replace(/\D/g, ""))} data-testid="num-next" /></label>
        <button type="button" className="hr-btn" disabled={!!w.busy || !next} data-testid="num-save" onClick={async () => { if (await w.run("num", "/api/accounting/zatca/numbering", "PUT", { series, nextNumber: Number(next) }, L("حُفظ", "Saved"))) reload(); }}>{L("حفظ", "Save")}</button>
      </div>
      {d.counters.length ? <p className="acct-hint">{d.counters.map((c) => `${c.series}: ${L("آخر رقم", "last")} ${c.value}`).join(" · ")}</p> : null}
    </section>
  );
}
