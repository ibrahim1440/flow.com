"use client";

// «إعدادات المحاسبة» (Figma ACC-71 «الإعدادات والربط» family): the activation (go-live date + readiness
// checklist; step-up), and «ربط الحسابات» — every system posting role mapped to an account of the chart.
// Later phases post only by these roles. A5: «فصل المهام» — the SoD setting (self-approval, the approver posting),
// one policy for A1 journals, A2 notes and A3 supplier invoices; every use is listed in the SoD exceptions report.
import { useMemo, useState } from "react";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { roleDef } from "@/lib/accounting/roles";
import { AcctShell, ACCOUNT_TYPE_AR, Msg, Term, todayRiyadh, useApi, useLang, useWrite, type Setup } from "../_ui/shell";

type Acc = { id: string; code: string; nameAr: string | null; nameEn: string; type: string; allowPosting: boolean; isActive: boolean; children: number };
const PHASE_AR: Record<string, [string, string]> = { A1: ["المرحلة 1 · النواة", "Phase A1 · core"], A2: ["المرحلة 2 · المبيعات والذمم المدينة", "Phase A2 · sales & receivables"], A3: ["المرحلة 3 · المشتريات والمخزون والإنتاج والرواتب", "Phase A3 · purchasing, inventory, production, payroll"] };

export default function SettingsPage() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const coa = useApi<Acc[]>("/api/accounting/coa");
  const w = useWrite();
  const s = setup.data;
  // Edits over the loaded settings (nothing copied into state by an effect).
  const [goLiveEdit, setGoLive] = useState<string | null>(null);
  const [mapEdit, setMapEdit] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<null | "activate" | "deactivate">(null);
  const [reason, setReason] = useState("");
  const goLive = goLiveEdit ?? s?.settings.goLiveDate ?? todayRiyadh();
  const map: Record<string, string> = useMemo(() => ({ ...Object.fromEntries((s?.readiness.roles ?? []).map((r) => [r.key, r.accountId ?? ""])), ...mapEdit }), [s, mapEdit]);
  const setMap = (m: Record<string, string>) => setMapEdit(m);
  const postable = useMemo(() => (coa.data ?? []).filter((a) => a.isActive && a.allowPosting && a.children === 0), [coa.data]);
  const changed = s ? s.readiness.roles.filter((r) => (r.accountId ?? "") !== (map[r.key] ?? "")) : [];
  const can = s?.can.settings;

  async function saveRoles() {
    const roles = Object.fromEntries(changed.map((r) => [r.key, map[r.key] || null]));
    const r = await w.run("roles", "/api/accounting/roles", "PUT", { roles }, L("حُفظ ربط الحسابات.", "The account mapping is saved."));
    if (r) { setMapEdit({}); setup.reload(); }
  }
  async function saveGoLive() {
    const r = await w.run("golive", "/api/accounting/setup/go-live", "PUT", { goLiveDate: goLive }, L("حُفظ تاريخ البدء.", "The go-live date is saved."));
    if (r) setup.reload();
  }
  async function doConfirm() {
    const r = confirm === "activate"
      ? await w.run("activate", "/api/accounting/setup/activate", "POST", { goLiveDate: goLive }, L("فُعّلت المحاسبة.", "Accounting is activated."))
      : await w.run("deactivate", "/api/accounting/setup/deactivate", "POST", { reason }, L("أُلغي التفعيل.", "Activation undone."));
    if (r) { setConfirm(null); setReason(""); setup.reload(); }
  }
  const name = (a: { nameAr: string | null; nameEn: string }) => L(a.nameAr ?? a.nameEn, a.nameEn);

  return (
    <AcctShell setup={s}>
      <Msg error={w.error ?? setup.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!s ? <OpsLoading /> : (
        <>
          <section className="acct-card" data-testid="acct-activation">
            <h2>{L("تفعيل المحاسبة", "Accounting activation")}</h2>
            <p className="acct-hint">{L("قبل التفعيل لا يُرحَّل أي قيد من العمليات (المبيعات، المشتريات، المخزون، الإنتاج، الرواتب) — محرك الترحيل لا يسجل شيئًا. بعد التفعيل تُرحَّل الأحداث من تاريخ البدء فصاعدًا، ولا يتغير تاريخ البدء بعد أول ترحيل.", "Until activation no operation (sales, purchasing, inventory, production, payroll) posts anything — the posting engine records nothing. After activation, events from the go-live date onward post, and the go-live date is final after the first posting.")}</p>
            <div className="acct-row">
              <Field label={L("تاريخ بدء المحاسبة", "Go-live date")} help={L("أول يوم تُحفظ فيه الدفاتر في النظام (توقيت الرياض)", "The first day the books are kept here (Riyadh time)")}>
                <input type="date" className="hr-input" value={goLive} disabled={s.settings.accountingActive || !can} onChange={(e) => setGoLive(e.target.value)} data-testid="golive-date" />
              </Field>
              {!s.settings.accountingActive && can ? <Btn busy={w.busy === "golive"} onClick={saveGoLive} data-testid="golive-save">{L("حفظ التاريخ", "Save the date")}</Btn> : null}
            </div>
            <ul className="acct-checks" data-testid="readiness">
              {s.readiness.checks.map((c) => <li key={c.key}><span className={c.ok ? "ok" : "no"} aria-hidden="true">{c.ok ? "●" : "○"}</span>{L(c.ar, c.en)}<span className="hr-sr">{c.ok ? L("جاهز", "ready") : L("غير جاهز", "not ready")}</span></li>)}
            </ul>
            <dl className="acct-kv-grid">
              <div><dt>{L("الحالة", "State")}</dt><dd>{s.settings.accountingActive ? L(`مفعّلة منذ ${s.settings.goLiveDate}`, `Active from ${s.settings.goLiveDate}`) : L("غير مفعّلة", "Not activated")}</dd></div>
              <div><dt>{L("القيود اليدوية", "Manual journals")}</dt><dd>{s.manualJournalsEnabled ? L("مسموحة", "Enabled") : L("معطّلة (قرار المرحلة الأولى)", "Disabled (Phase 1 decision)")}</dd></div>
              <div><dt>{L("فصل المهام", "Segregation of duties")}</dt><dd>{s.simpleMode ? L("الوضع المبسّط: يُسمح للمالك باعتماد قيده ويُسجَّل", "Simple mode: the owner may approve their own journal, recorded") : s.sod?.allowSelfApproval ? L("يُسمح للمُعدّ بالاعتماد ويُسجَّل (الإعداد)", "A preparer may approve, recorded (the setting)") : L("المُعدّ لا يعتمد قيده", "A preparer never approves their own journal")}</dd></div>
            </dl>
            {can ? (
              <span className="acct-actions">
                {!s.settings.accountingActive ? <Btn variant="primary" disabled={!s.readiness.checks.filter((c) => c.key === "chart" || c.key === "roles").every((c) => c.ok)} onClick={() => setConfirm("activate")} data-testid="activate">{L("تفعيل المحاسبة", "Activate accounting")}</Btn>
                  : !s.readiness.enginePosted ? <Btn variant="danger" onClick={() => setConfirm("deactivate")} data-testid="deactivate">{L("إلغاء التفعيل", "Undo activation")}</Btn> : null}
              </span>
            ) : null}
          </section>

          <SodSettings s={s} can={!!can} onSaved={setup.reload} />

          <section className="acct-card" data-testid="acct-roles">
            <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
              <h2>{L("ربط الحسابات", "Account mapping")}</h2>
              {can ? <Btn variant="primary" disabled={!changed.length} busy={w.busy === "roles"} onClick={saveRoles} data-testid="roles-save">{L(`حفظ الربط${changed.length ? ` (${changed.length})` : ""}`, `Save mapping${changed.length ? ` (${changed.length})` : ""}`)}</Btn> : null}
            </div>
            <p className="acct-hint">{L("لكل بند حساب واحد يُرحَّل عليه تلقائيًا (مثل «البن الأخضر» أو «الذمم الدائنة»). تغيير الحساب لا يغيّر أي قيد مرحّل، ويُسجَّل. الرمز التقني للبند يظهر عند الوقوف عليه.", "Each item has one account it posts to automatically (such as «Green coffee» or «Accounts payable»). Changing it never changes a posted entry, and is recorded. The item's technical key shows on hover or focus.")}</p>
            {(["A1", "A2", "A3"] as const).map((ph) => (
              <div key={ph} className="hr-tablewrap">
                <table className="hr-table is-dense">
                  <caption className="hr-label" style={{ textAlign: "start", padding: "8px 0" }}>{L(PHASE_AR[ph][0], PHASE_AR[ph][1])}{s.readiness.missingByPhase[ph]?.length ? <span className="hr-flag tone-warning" style={{ marginInlineStart: 8 }}><span>{L(`${s.readiness.missingByPhase[ph].length} غير مربوط`, `${s.readiness.missingByPhase[ph].length} unmapped`)}</span></span> : null}</caption>
                  <thead><tr><th>{L("البند", "Item")}</th><th>{L("الحساب", "Account")}</th></tr></thead>
                  <tbody>
                    {s.readiness.roles.filter((r) => r.phase === ph).map((r) => (
                      <tr key={r.key} data-role={r.key}>
                        <td><Term tech={r.key}>{L(r.ar, r.en)}</Term></td>
                        <td style={{ minWidth: 240 }}>
                          {can ? (
                            <Select value={map[r.key] ?? ""} onChange={(e) => setMap({ ...map, [r.key]: e.target.value })} aria-label={L(r.ar, r.en)} placeholder={L("غير مربوط", "Not mapped")}>
                              <option value="">{L("غير مربوط", "Not mapped")}</option>
                              {postable.filter((a) => (roleDef(r.key)?.types ?? []).includes(a.type as never)).map((a) => <option key={a.id} value={a.id}>{`${a.code} · ${name(a)}`}</option>)}
                            </Select>
                          ) : r.accountCode ? `${r.accountCode} · ${r.accountName}` : <span className="hr-flag tone-warning"><span>{L("غير مربوط", "Not mapped")}</span></span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <p className="acct-hint">{L("أنواع الحسابات المقبولة لكل بند: ", "Account types each item accepts: ")}{Object.values(ACCOUNT_TYPE_AR).map((v) => L(v[0], v[1])).join(" · ")}</p>
          </section>
        </>
      )}
      <Dialog open={!!confirm} title={confirm === "activate" ? L("تفعيل المحاسبة", "Activate accounting") : L("إلغاء التفعيل", "Undo activation")} onClose={() => setConfirm(null)}
        sub={confirm === "activate" ? L(`من ${goLive}: كل حدث تشغيلي مربوط يُرحَّل قيده تلقائيًا. لا يتغير تاريخ البدء بعد أول ترحيل.`, `From ${goLive}: every connected operational event posts its entry. The go-live date is final after the first posting.`) : L("ممكن فقط قبل أي ترحيل من المحرك.", "Possible only before the engine has posted anything.")}
        actions={<><Btn variant={confirm === "activate" ? "primary" : "danger"} disabled={confirm === "deactivate" && reason.trim().length < 3} busy={w.busy === "activate" || w.busy === "deactivate"} onClick={doConfirm} data-testid="activation-confirm">{confirm === "activate" ? L("تفعيل", "Activate") : L("إلغاء التفعيل", "Undo")}</Btn><Btn onClick={() => setConfirm(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        {confirm === "deactivate" ? <Field label={L("السبب", "Reason")}><textarea className="hr-input hr-textarea" value={reason} onChange={(e) => setReason(e.target.value)} /></Field> : <p>{L("تأكد من مراجعة دليل الحسابات وربط الحسابات مع المحاسب قبل التفعيل.", "Review the chart and the account mapping with the accountant before activating.")}</p>}
      </Dialog>
    </AcctShell>
  );
}

/** «فصل المهام» (A5): two toggles; saved with step-up (the admin role), audited by the database. */
function SodSettings({ s, can, onSaved }: { s: Setup; can: boolean; onSaved: () => void }) {
  const { L } = useLang();
  const w = useWrite();
  const stored = s.sod?.stored ?? { allowSelfApproval: true, approverMayPost: true };
  const [edit, setEdit] = useState<{ allowSelfApproval?: boolean; approverMayPost?: boolean }>({});
  const v = { ...stored, ...edit };
  const dirty = v.allowSelfApproval !== stored.allowSelfApproval || v.approverMayPost !== stored.approverMayPost;
  async function save() {
    const r = await w.run("sod", "/api/accounting/sod", "PUT", v, L("حُفظ إعداد فصل المهام.", "The SoD setting is saved."));
    if (r) { setEdit({}); onSaved(); }
  }
  return (
    <section className="acct-card" data-testid="acct-sod">
      <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
        <h2>{L("فصل المهام", "Segregation of duties")}</h2>
        {can ? <Btn variant="primary" disabled={!dirty} busy={w.busy === "sod"} onClick={save} data-testid="sod-save">{L("حفظ", "Save")}</Btn> : null}
      </div>
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <p className="acct-hint">{L("محاسب واحد اليوم وأكثر لاحقًا: كل سماح هنا يُسجَّل على المستند ويظهر في تقرير «استثناءات فصل المهام» للمراجع. الترحيل نفسه يبقى بصلاحيته.", "One accountant today, more later: every allowance here is recorded on the document and listed in the «SoD exceptions» report for the auditor. Posting itself keeps its own permission.")}</p>
      {s.simpleMode ? <p className="acct-hint acct-warn" data-testid="sod-simple">{L("الوضع المبسّط مفعّل: يُسمح بالحالتين أيًّا كان الإعداد، وتُسجَّل.", "Simple mode is on: both are allowed whatever the setting, and recorded.")}</p> : null}
      <label className="acct-toggle">
        <input type="checkbox" checked={v.allowSelfApproval} disabled={!can} onChange={(e) => setEdit({ ...edit, allowSelfApproval: e.target.checked })} data-testid="sod-self" />
        <span><b>{L("السماح للمُعدّ باعتماد ما أعدّه", "Allow a preparer to approve their own work")}</b><span className="acct-hint">{L("القيود اليدوية، والإشعارات الدائنة والمدينة، وترحيل فواتير الموردين. يُسجَّل «تجاوز فصل المهام» على القيد.", "Manual journals, credit / debit notes, posting supplier invoices. The bypass is recorded on the entry.")}</span></span>
      </label>
      <label className="acct-toggle">
        <input type="checkbox" checked={v.approverMayPost} disabled={!can} onChange={(e) => setEdit({ ...edit, approverMayPost: e.target.checked })} data-testid="sod-post" />
        <span><b>{L("يجوز للمعتمِد ترحيل القيد", "The approver may post the journal")}</b><span className="acct-hint">{L("عند الإيقاف يرحّل القيدَ شخص ثالث غير المعتمِد.", "When off, a third person — not the approver — posts it.")}</span></span>
      </label>
      <p className="acct-hint"><a href="/dashboard/accounting/reports?view=sod">{L("تقرير استثناءات فصل المهام ←", "SoD exceptions report →")}</a></p>
    </section>
  );
}
