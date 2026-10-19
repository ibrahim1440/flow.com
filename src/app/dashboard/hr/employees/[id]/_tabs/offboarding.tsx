"use client";
// HR-02 · Offboarding: initiate → clearance (assets, advances, pending leave block) →
// settlement figures (ENTERED, never computed) → complete or cancel.
import { Select } from "@/components/ui/Select";
import { useCallback, useState } from "react";
import { Btn, Dialog, Empty, ErrorState, Field, Flag, KV, LoadingTable, Notice, StatusDot, money, todayIso, useAction, useForm, useHr, useHrI18n } from "@/components/hr/ui";
import { leaveTypeName } from "@/lib/i18n/hr";
import { hrText } from "@/lib/hr/messages-en";
import { Check, SEPARATION_TYPE, SectionHead, isAmount, lbl, mutate, type Balance, type TabProps } from "./shared";
import FinalSettlementPanel from "./final-settlement";

type Open = { separation: { id: string; type: string; lastWorkingDay: string; status: string } | null; history?: { id: string; status: string }[] };
type Clearance = {
  separation: {
    id: string; type: string; noticeDate: string; lastWorkingDay: string; reason: string; status: string; deactivateAccount: boolean;
    eosAmount: string | null; eosBasisNote: string | null; leaveEncashmentDays: string | null; otherSettlement: string | null; settlementNotes: string | null;
  };
  items: { key: string; ok: boolean; blocking: boolean; manual?: boolean; detail: string[] }[];
  leaveBalances: Balance[];
  canComplete: boolean;
};
const ITEM: Record<string, [string, string]> = { ASSETS: ["إعادة العهد", "Return assets"], ADVANCES: ["تسوية السلف", "Settle advances"], PENDING_LEAVE: ["طلبات إجازة معلّقة", "Pending leave requests"], FINAL_PAYROLL: ["مسير الرواتب الأخير", "Final payroll"], SETTLEMENT: ["التسوية النهائية", "Final settlement"] };

export default function OffboardingTab({ id, profile, reload: reloadProfile }: TabProps) {
  const open = useHr<Open>(`/api/hr/employees/${id}/separation`);
  const sid = open.data?.separation?.id ?? null;
  const clr = useHr<Clearance>(sid ? `/api/hr/separations/${sid}` : null);
  const [dlg, setDlg] = useState<"start" | "settle" | "cancel" | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const a = useAction();
  const close = useCallback(() => setDlg(null), []);
  const after = useCallback(() => { setDlg(null); void open.reload(); void clr.reload(); reloadProfile(); }, [open, clr, reloadProfile]);
  const separated = profile.person.status === "SEPARATED";
  const { L, t, lang } = useHrI18n();

  const complete = () => a.run("complete", async () => {
    if (!sid) return;
    const r = await mutate<{ completed: boolean; accountDeactivated: boolean }>(`/api/hr/separations/${sid}/complete`, { json: {} });
    setResult(r.accountDeactivated ? L("اكتمل إنهاء الخدمة وعُطّل حساب الدخول المرتبط.", "End of service completed and the linked login account disabled.") : L("اكتمل إنهاء الخدمة.", "End of service completed."));
    reloadProfile();
  });

  if (result) return <Notice tone="success">{result}</Notice>;
  if (open.error) return <ErrorState error={open.error} onRetry={open.reload} />;
  if (open.loading && !open.data) return <LoadingTable rows={4} />;
  if (!open.data) return null;

  if (!sid) {
    // P-2 finding 8: the financial settlement outlives the separation (they are separate records).
    const completed = open.data.history?.find((h) => h.status === "COMPLETED") ?? null;
    if (separated) {
      return <div className="hr-stack" style={{ gap: 24 }}><Empty title={L("انتهت خدمة الموظف", "Service has ended")} body={profile.person.separationDate ? L(`آخر يوم عمل: ${profile.person.separationDate}. الملف للقراءة فقط.`, `Last working day: ${profile.person.separationDate}. The file is read-only.`) : L("الملف للقراءة فقط.", "The file is read-only.")} />{completed ? <FinalSettlementPanel separationId={completed.id} /> : null}</div>;
    }
    return (
      <>
        <Empty
          title={L("لا يوجد إنهاء خدمة مفتوح", "No open end of service")}
          body={L("بدء الإنهاء يضع الموظف في «فترة إشعار». يكتمل بعد إعادة العهد وتسوية السلف والإجازات المعلّقة، ويمكن إلغاؤه قبل الإتمام.", "Starting puts the employee in the notice period. It completes after assets are returned and advances and pending leave are settled, and can be cancelled before completion.")}
          action={<Btn variant="danger" onClick={() => setDlg("start")}>{L("بدء إنهاء الخدمة", "Start end of service")}</Btn>}
        />
        {dlg === "start" ? <StartDialog id={id} hasAccount={profile.person.hasAccount} onClose={close} onDone={after} /> : null}
      </>
    );
  }

  const c = clr.data;
  const s = c?.separation;
  return (
    <div className="hr-stack" style={{ gap: 24 }}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      {clr.error ? <ErrorState error={clr.error} onRetry={clr.reload} /> : null}
      {clr.loading && !c ? <LoadingTable rows={5} /> : null}
      {c && s ? (
        <>
          <div className="hr-cols">
            <section className="hr-stack">
              <SectionHead
                title={L("إخلاء الطرف", "Clearance")}
                actions={
                  <>
                    <Btn variant="primary" busy={a.busy === "complete"} disabled={!c.canComplete} onClick={complete} title={c.canComplete ? undefined : L("أكمل البنود المانعة أولًا", "Complete the blocking items first")}>{L("إتمام إنهاء الخدمة", "Complete end of service")}</Btn>
                    <Btn onClick={() => setDlg("cancel")}>{L("إلغاء الإنهاء", "Cancel end of service")}</Btn>
                  </>
                }
              />
              <div className="hr-tablewrap">
                <table className="hr-table is-stack" aria-label={L("بنود إخلاء الطرف", "Clearance items")}>
                  <thead><tr><th>{L("البند", "Item")}</th><th>{t("status")}</th><th>{L("التفاصيل", "Details")}</th></tr></thead>
                  <tbody>
                    {c.items.map((i) => (
                      <tr key={i.key}>
                        <td data-label={L("البند", "Item")} className="strong">{ITEM[i.key] ? ITEM[i.key][lang === "en" ? 1 : 0] : i.key}{i.blocking ? null : <span className="sub">{L("غير مانع", "Not blocking")}</span>}</td>
                        <td data-label={t("status")}><StatusDot map={{ OK: ["مكتمل", "success", "Complete"], BLOCK: ["مانع", "danger", "Blocking"], OPEN: ["قائم", "warning", "Open"], MANUAL: ["مُدخلة يدويًا — لا تُحتسب ولا تُصرف ولا تُرحَّل", "warning", "Entered by hand — not calculated, paid or posted"] }} value={i.ok ? "OK" : i.blocking ? "BLOCK" : i.manual ? "MANUAL" : "OPEN"} /></td>
                        <td data-label={L("التفاصيل", "Details")} className="hr-muted">{i.detail.length ? i.detail.map((d) => <div key={d} className="hr-iso">{hrText(d, lang)}</div>) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!c.canComplete ? <Notice tone="warning">{L("لا يكتمل الإنهاء قبل إعادة العهد وإغلاق السلف وحسم طلبات الإجازة المعلّقة.", "End of service cannot complete until assets are returned, advances closed and pending leave requests decided.")}</Notice> : null}
              <p className="hr-caption" style={{ margin: 0 }}>
                {s.deactivateAccount ? L("عند الإتمام يُعطَّل حساب الدخول المرتبط بالموظف إن وُجد، ", "On completion the employee’s linked login account, if any, is disabled, ") : L("لن يُعطَّل حساب الدخول عند الإتمام، ", "The login account is not disabled on completion, ")}
                {L("وتُنهى العقود السارية وتعيينات الورديات في آخر يوم عمل.", "and active contracts and shift assignments end on the last working day.")}
              </p>
            </section>

            <aside className="hr-stack">
              <SectionHead title={L("بيانات الإنهاء", "End of service details")} />
              <KV rows={[
                [t("type"), lbl(SEPARATION_TYPE, s.type, lang)],
                [L("تاريخ الإشعار", "Notice date"), <span key="n" className="hr-num">{s.noticeDate}</span>],
                [L("آخر يوم عمل", "Last working day"), <span key="l" className="hr-num">{s.lastWorkingDay}</span>],
                [t("reason"), s.reason],
              ]} />
              <SectionHead title={L("التسوية النهائية", "Final settlement")} actions={<Btn size="sm" onClick={() => setDlg("settle")}>{s.eosAmount || s.otherSettlement || s.leaveEncashmentDays ? L("تعديل التسوية", "Edit settlement") : L("تسجيل التسوية", "Record settlement")}</Btn>} />
              <KV rows={[
                [L("مكافأة نهاية الخدمة", "End-of-service award"), s.eosAmount ? <span key="e" className="hr-num">{money(s.eosAmount)}</span> : "—"],
                [L("أساس المكافأة", "Award basis"), s.eosBasisNote ?? "—"],
                [L("أيام إجازة مستحقة الصرف", "Leave days to encash"), s.leaveEncashmentDays ? <span key="d" className="hr-num">{Number(s.leaveEncashmentDays)}</span> : "—"],
                [L("مبالغ أخرى", "Other amounts"), s.otherSettlement ? <span key="o" className="hr-num">{money(s.otherSettlement)}</span> : "—"],
                [L("ملاحظات", "Notes"), s.settlementNotes ?? "—"],
              ]} />
              {/* F2 / finding 8: these figures are recorded, not calculated or paid; never shown as complete. */}
              <div data-testid="hr-eos-not-implemented" className="hr-stack" style={{ gap: 8 }}>
                <span><Flag tone="warning">{L("مُدخلة يدويًا — لا تُحتسب ولا تُصرف ولا تُرحَّل", "Entered by hand — not calculated, paid or posted")}</Flag></span>
                <Notice tone="warning">{L("مكافأة نهاية الخدمة وصرف رصيد الإجازة غير مُنفّذين: الأرقام أعلاه تُدخل يدويًا للتوثيق فقط، فلا يحسبها النظام ولا يصرفها ولا يُرحّل لها قيدًا. تسجيلها لا يعني اكتمال التسوية. يُسوّى أي مبلغ عبر «التسوية المالية النهائية» أدناه بإثباتاتها، ولا يُصرف أبدًا كتسوية في مسير الرواتب.", "The end-of-service award and the leave-balance payout are not implemented: the figures above are entered by hand for the record only; the system does not calculate or pay them or post an entry for them. Recording them does not complete the settlement. Any amount is settled through the final financial settlement below, with its evidence — never as a payroll adjustment.")}</Notice>
              </div>
              {c.leaveBalances.some((b) => b.tracksBalance) ? (
                <>
                  <span className="hr-label">{L("أرصدة الإجازات الحالية", "Current leave balances")}</span>
                  <KV rows={c.leaveBalances.filter((b) => b.tracksBalance).map((b) => [leaveTypeName(b, lang), <span key={b.leaveTypeId} className="hr-num">{Number(b.available)}</span>])} />
                </>
              ) : null}
            </aside>
          </div>
          <FinalSettlementPanel separationId={s.id} />
          {dlg === "settle" ? <SettleDialog sid={s.id} s={s} onClose={close} onDone={after} /> : null}
          {dlg === "cancel" ? <CancelDialog sid={s.id} onClose={close} onDone={after} /> : null}
        </>
      ) : null}
    </div>
  );
}

function StartDialog({ id, hasAccount, onClose, onDone }: { id: string; hasAccount: boolean; onClose: () => void; onDone: () => void }) {
  const f = useForm({ type: "RESIGNATION", noticeDate: todayIso(), lastWorkingDay: "", reason: "" });
  const [deactivate, setDeactivate] = useState(true);
  const a = useAction();
  const { L, t, lang } = useHrI18n();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/employees/${id}/separation`, { json: { ...f.v, deactivateAccount: deactivate } });
    onDone();
  });
  return (
    <Dialog open title={L("بدء إنهاء الخدمة", "Start end of service")} onClose={onClose} actions={<><Btn variant="danger" busy={a.busy === "save"} onClick={submit} disabled={!f.v.noticeDate || !f.v.lastWorkingDay || f.v.reason.trim().length < 3}>{L("بدء الإنهاء", "Start")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("النوع *", "Type *")}><Select className="hr-select" {...f.bind("type")}>{Object.keys(SEPARATION_TYPE).map((k) => <option key={k} value={k}>{lbl(SEPARATION_TYPE, k, lang)}</option>)}</Select></Field>
        <Field label={L("تاريخ الإشعار *", "Notice date *")}><input className="hr-input" type="date" {...f.bind("noticeDate")} /></Field>
        <Field label={L("آخر يوم عمل *", "Last working day *")}><input className="hr-input" type="date" {...f.bind("lastWorkingDay")} /></Field>
        <Field label={L("السبب *", "Reason *")} wide><textarea className="hr-textarea" {...f.bind("reason")} /></Field>
      </div>
      <Check checked={deactivate} onChange={setDeactivate}>{L("تعطيل حساب الدخول المرتبط عند الإتمام", "Disable the linked login account on completion")}{hasAccount ? "" : L(" (لا يوجد حساب مرتبط حاليًا)", " (no account is linked now)")}</Check>
      <p className="hr-caption" style={{ margin: 0 }}>{L("تتحول حالة الموظف إلى «فترة إشعار». لا يمكنك إنهاء خدمة نفسك.", "The employee’s status changes to Notice period. You cannot end your own service.")}</p>
    </Dialog>
  );
}

function SettleDialog({ sid, s, onClose, onDone }: { sid: string; s: Clearance["separation"]; onClose: () => void; onDone: () => void }) {
  const f = useForm({ eosAmount: s.eosAmount ?? "", eosBasisNote: s.eosBasisNote ?? "", leaveEncashmentDays: s.leaveEncashmentDays ? String(Number(s.leaveEncashmentDays)) : "", otherSettlement: s.otherSettlement ?? "", settlementNotes: s.settlementNotes ?? "" });
  const a = useAction();
  const { L, t } = useHrI18n();
  const needNote = f.v.eosAmount !== "" && Number(f.v.eosAmount) !== 0;
  const daysOk = f.v.leaveEncashmentDays === "" || /^\d+(\.\d{1,2})?$/.test(f.v.leaveEncashmentDays.trim());
  const numErr = L("رقم بخانتين عشريتين على الأكثر", "A number with at most two decimals");
  const ok = isAmount(f.v.eosAmount) && isAmount(f.v.otherSettlement) && daysOk && (!needNote || f.v.eosBasisNote.trim().length >= 10);
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/separations/${sid}/settlement`, { json: f.v });
    onDone();
  });
  return (
    <Dialog open title={L("التسوية النهائية", "Final settlement")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!ok}>{t("save")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <Notice tone="warning">{L("احتساب المكافأة وصرف رصيد الإجازة غير مُنفّذين: تُدخل الأرقام يدويًا للتوثيق ولا يحسبها النظام ولا يصرفها. اكتب كيف حُدّد المبلغ. الصرف عبر «التسوية المالية النهائية» وليس عبر مسير الرواتب.", "The award calculation and the leave-balance payout are not implemented: the figures are entered by hand for the record; the system does not calculate or pay them. Explain how the amount was set. Payment is through the final financial settlement, never through payroll.")}</Notice>
      <div className="hr-form">
        <Field label={L("مكافأة نهاية الخدمة", "End-of-service award")} error={isAmount(f.v.eosAmount) ? null : numErr}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("eosAmount")} /></Field>
        <Field label={L("أيام إجازة مستحقة الصرف", "Leave days to encash")} error={daysOk ? null : numErr}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("leaveEncashmentDays")} /></Field>
        <Field label={needNote ? L("أساس احتساب المكافأة *", "Award basis *") : L("أساس احتساب المكافأة", "Award basis")} help={L("عشرة أحرف على الأقل عند إدخال مكافأة", "At least ten characters when an award is entered")} error={needNote && f.v.eosBasisNote.trim().length < 10 ? L("مطلوب: اشرح كيف حُدّد المبلغ", "Required: explain how the amount was set") : null} wide>
          <textarea className="hr-textarea" {...f.bind("eosBasisNote")} />
        </Field>
        <Field label={L("مبالغ أخرى", "Other amounts")} error={isAmount(f.v.otherSettlement) ? null : numErr}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("otherSettlement")} /></Field>
        <Field label={L("ملاحظات", "Notes")} wide><textarea className="hr-textarea" {...f.bind("settlementNotes")} /></Field>
      </div>
    </Dialog>
  );
}

function CancelDialog({ sid, onClose, onDone }: { sid: string; onClose: () => void; onDone: () => void }) {
  const f = useForm({ reason: "" });
  const a = useAction();
  const { L } = useHrI18n();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/separations/${sid}/cancel`, { json: f.v });
    onDone();
  });
  return (
    <Dialog open title={L("إلغاء إنهاء الخدمة", "Cancel end of service")} onClose={onClose} actions={<><Btn variant="danger" busy={a.busy === "save"} onClick={submit} disabled={f.v.reason.trim().length < 3}>{L("إلغاء الإنهاء", "Cancel end of service")}</Btn><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <p className="hr-caption" style={{ margin: 0 }}>{L("تعود حالة الموظف إلى «على رأس العمل».", "The employee’s status returns to Active.")}</p>
      <Field label={L("السبب *", "Reason *")}><input className="hr-input" {...f.bind("reason")} /></Field>
    </Dialog>
  );
}
