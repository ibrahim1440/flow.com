"use client";
// HR-02 · Contracts & pay. Contracts are versioned (DRAFT → ACTIVE → SUPERSEDED | ENDED);
// pay is a list of effective-dated versions that never overlap and are never edited.
import { useCallback, useState } from "react";
import { Btn, CONTRACT_STATUS, Dialog, Empty, Field, Notice, StatusDot, money, todayIso, useAction, useForm, useHrI18n } from "@/components/hr/ui";
import { CONTRACT_TYPE, SectionHead, isAmount, lbl, mutate, type Contract, type TabProps } from "./shared";

type Dlg = { kind: "new" } | { kind: "end"; c: Contract } | { kind: "pay" } | { kind: "renew" } | null;

const addDay = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export default function ContractsTab({ id, profile, readOnly, reload }: TabProps) {
  const [dlg, setDlg] = useState<Dlg>(null);
  const close = useCallback(() => setDlg(null), []);
  const done = useCallback(() => { setDlg(null); reload(); }, [reload]);
  const act = useAction();
  const { L, t, lang } = useHrI18n();
  const contracts = profile.contracts ?? [];
  const comp = profile.compensation ?? [];
  const hasDraft = contracts.some((c) => c.status === "DRAFT");
  const activate = (c: Contract) => act.run(`act:${c.id}`, async () => {
    await mutate(`/api/hr/employees/${id}/contracts/${c.id}/activate`, { json: {} });
    reload();
  });

  return (
    <div className="hr-stack" style={{ gap: 28 }}>
      {readOnly ? null : act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <section className="hr-stack">
        <SectionHead
          title={L("العقود", "Contracts")}
          actions={readOnly ? null : (
            <>
              {profile.currentContract ? <Btn size="sm" onClick={() => setDlg({ kind: "renew" })}>{L("تجديد العقد", "Renew contract")}</Btn> : null}
              <Btn size="sm" onClick={() => setDlg({ kind: "new" })} disabled={hasDraft} title={hasDraft ? L("فعّل المسودة الحالية أولًا", "Activate the current draft first") : undefined}>{L("عقد جديد (مسودة)", "New contract (draft)")}</Btn>
            </>
          )}
        />
        {contracts.length === 0 ? (
          <Empty title={L("لا توجد عقود", "No contracts")} body={L("أنشئ عقدًا كمسودة ثم فعّله. تفعيل عقد جديد يُنهي العقد الساري في اليوم السابق لبدايته.", "Create a contract as a draft, then activate it. Activating a new contract ends the active one the day before it starts.")} />
        ) : (
          <div className="hr-tablewrap">
            <table className="hr-table is-stack" aria-label={L("العقود", "Contracts")}>
              <thead>
                <tr><th>{L("العقد", "Contract")}</th><th>{t("type")}</th><th className="num">{t("from")}</th><th className="num">{t("to")}</th><th className="num">{L("الإشعار", "Notice")}</th><th>{t("status")}</th>{readOnly ? null : <th aria-label={L("إجراءات", "Actions")} />}</tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id}>
                    <td data-label={L("العقد", "Contract")}><span className="hr-id">{c.contractNo}</span>{c.endReason ? <span className="sub">{c.endReason}</span> : null}</td>
                    <td data-label={t("type")}>{lbl(CONTRACT_TYPE, c.type, lang)}</td>
                    <td data-label={t("from")} className="num">{c.startDate}</td>
                    <td data-label={t("to")} className="num">{c.endDate ?? "—"}</td>
                    <td data-label={L("الإشعار", "Notice")} className="num">{c.noticeDays} {L("يومًا", "days")}</td>
                    <td data-label={t("status")}><StatusDot map={CONTRACT_STATUS} value={c.status} /></td>
                    {readOnly ? null : (
                      <td data-label={L("إجراءات", "Actions")}>
                        {c.status === "DRAFT" ? <Btn size="sm" variant="primary" busy={act.busy === `act:${c.id}`} onClick={() => activate(c)}>{L("تفعيل", "Activate")}</Btn> : null}
                        {c.status === "ACTIVE" ? <Btn size="sm" variant="danger" onClick={() => setDlg({ kind: "end", c })}>{L("إنهاء", "End")}</Btn> : null}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="hr-stack">
        <SectionHead title={L("نسخ الراتب", "Pay versions")} actions={readOnly ? null : <Btn size="sm" onClick={() => setDlg({ kind: "pay" })}>{L("نسخة راتب جديدة", "New pay version")}</Btn>} />
        <p className="hr-caption" style={{ margin: 0 }}>{L("النسخ لا تتداخل ولا تُعدَّل. النسخة الجديدة تُغلق النسخة المفتوحة في اليوم السابق لسريانها، ولا يمكن أن تبدأ في شهر اعتُمد مسيره أو صُرف.", "Versions never overlap and are never edited. A new version closes the open one the day before it takes effect, and cannot start in a month whose payroll is approved or paid.")}</p>
        {comp.length === 0 ? (
          <Empty title={L("لا يوجد راتب مسجل", "No pay recorded")} body={L("سجّل أول نسخة راتب ليُحتسب الموظف في مسير الرواتب.", "Record the first pay version so the employee is included in payroll.")} />
        ) : (
          <div className="hr-tablewrap">
            <table className="hr-table is-stack" aria-label={L("نسخ الراتب", "Pay versions")}>
              <thead>
                <tr><th className="num">{L("سريان من", "Effective from")}</th><th className="num">{L("الأساسي", "Basic")}</th><th className="num">{L("السكن", "Housing")}</th><th className="num">{L("النقل", "Transport")}</th><th className="num">{L("أخرى", "Other")}</th><th className="num">{L("الإجمالي", "Total")}</th><th>{t("reason")}</th></tr>
              </thead>
              <tbody>
                {comp.map((c) => (
                  <tr key={c.id}>
                    <td data-label={L("سريان من", "Effective from")} className="num">{c.effectiveFrom}{c.effectiveTo ? <span className="sub">{L("حتى", "until")} {c.effectiveTo}</span> : <span className="sub">{L("سارية", "Active")}</span>}</td>
                    <td data-label={L("الأساسي", "Basic")} className="num">{money(c.basic)}</td>
                    <td data-label={L("السكن", "Housing")} className="num">{money(c.housing)}</td>
                    <td data-label={L("النقل", "Transport")} className="num">{money(c.transport)}</td>
                    <td data-label={L("أخرى", "Other")} className="num">{money(c.otherAllowance)}</td>
                    <td data-label={L("الإجمالي", "Total")} className="num strong">{money(c.total)}</td>
                    <td data-label={t("reason")} className="hr-muted">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dlg?.kind === "new" ? <ContractDialog id={id} hireDate={profile.person.hireDate} onClose={close} onDone={done} /> : null}
      {dlg?.kind === "end" ? <EndDialog id={id} c={dlg.c} onClose={close} onDone={done} /> : null}
      {dlg?.kind === "pay" ? <PayDialog id={id} onClose={close} onDone={done} /> : null}
      {dlg?.kind === "renew" && profile.currentContract ? <RenewDialog id={id} current={profile.currentContract} onClose={close} onDone={done} /> : null}
    </div>
  );
}

function ContractDialog({ id, hireDate, onClose, onDone }: { id: string; hireDate: string; onClose: () => void; onDone: () => void }) {
  const f = useForm({ type: "FIXED_TERM", startDate: hireDate > todayIso() ? hireDate : todayIso(), endDate: "", probationDays: "90", noticeDays: "30", notes: "" });
  const a = useAction();
  const fixed = f.v.type === "FIXED_TERM";
  const { L, t, lang } = useHrI18n();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/employees/${id}/contracts`, {
      json: { type: f.v.type, startDate: f.v.startDate, endDate: fixed ? f.v.endDate : undefined, probationDays: f.v.probationDays === "" ? undefined : Number(f.v.probationDays), noticeDays: Number(f.v.noticeDays), notes: f.v.notes || undefined },
    });
    onDone();
  });
  return (
    <Dialog open title={L("عقد جديد", "New contract")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!f.v.startDate || (fixed && !f.v.endDate) || f.v.noticeDays === ""}>{L("حفظ كمسودة", "Save as draft")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("نوع العقد *", "Contract type *")}><select className="hr-select" {...f.bind("type")}><option value="FIXED_TERM">{lbl(CONTRACT_TYPE, "FIXED_TERM", lang)}</option><option value="OPEN_ENDED">{lbl(CONTRACT_TYPE, "OPEN_ENDED", lang)}</option></select></Field>
        <Field label={L("تاريخ البداية *", "Start date *")}><input className="hr-input" type="date" {...f.bind("startDate")} /></Field>
        {fixed ? <Field label={L("تاريخ النهاية *", "End date *")}><input className="hr-input" type="date" {...f.bind("endDate")} /></Field> : null}
        <Field label={L("فترة التجربة (أيام)", "Probation (days)")}><input className="hr-input" type="number" min={0} max={365} dir="ltr" {...f.bind("probationDays")} /></Field>
        <Field label={L("مدة الإشعار (أيام) *", "Notice period (days) *")}><input className="hr-input" type="number" min={0} max={365} dir="ltr" {...f.bind("noticeDays")} /></Field>
        <Field label={L("ملاحظات", "Notes")} wide><textarea className="hr-textarea" {...f.bind("notes")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("يُحفظ العقد مسودةً ولا يسري حتى تفعّله. لا يبدأ العقد قبل تاريخ المباشرة", "The contract is saved as a draft and takes effect only once activated. It cannot start before the start date")} <span className="hr-num">{hireDate}</span>.</p>
    </Dialog>
  );
}

export function RenewDialog({ id, current, onClose, onDone }: { id: string; current: { contractNo: string; type: string; endDate: string | null; noticeDays: number }; onClose: () => void; onDone: () => void }) {
  const f = useForm({ type: current.type, startDate: current.endDate ? addDay(current.endDate, 1) : todayIso(), endDate: "", noticeDays: String(current.noticeDays) });
  const a = useAction();
  const fixed = f.v.type === "FIXED_TERM";
  const { L, t, lang } = useHrI18n();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/employees/${id}/contracts/renew`, { json: { type: f.v.type, startDate: f.v.startDate, endDate: fixed ? f.v.endDate : undefined, noticeDays: Number(f.v.noticeDays) } });
    onDone();
  });
  return (
    <Dialog open title={L("تجديد العقد", "Renew contract")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!f.v.startDate || (fixed && !f.v.endDate) || f.v.noticeDays === ""}>{L("تجديد وتفعيل", "Renew and activate")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <Notice>{L("يُنشأ إصدار جديد من العقد", "A new version of contract")} <span className="hr-id">{current.contractNo}</span> {L("ويُفعَّل فورًا، ويُغلق العقد الحالي في اليوم السابق لبداية الجديد.", "is created and activated at once; the current contract closes the day before the new one starts.")}</Notice>
      <div className="hr-form">
        <Field label={L("نوع العقد *", "Contract type *")}><select className="hr-select" {...f.bind("type")}><option value="FIXED_TERM">{lbl(CONTRACT_TYPE, "FIXED_TERM", lang)}</option><option value="OPEN_ENDED">{lbl(CONTRACT_TYPE, "OPEN_ENDED", lang)}</option></select></Field>
        <Field label={L("تاريخ البداية *", "Start date *")}><input className="hr-input" type="date" {...f.bind("startDate")} /></Field>
        {fixed ? <Field label={L("تاريخ النهاية *", "End date *")}><input className="hr-input" type="date" {...f.bind("endDate")} /></Field> : null}
        <Field label={L("مدة الإشعار (أيام) *", "Notice period (days) *")}><input className="hr-input" type="number" min={0} max={365} dir="ltr" {...f.bind("noticeDays")} /></Field>
      </div>
    </Dialog>
  );
}

function EndDialog({ id, c, onClose, onDone }: { id: string; c: Contract; onClose: () => void; onDone: () => void }) {
  const f = useForm({ endDate: c.endDate && c.endDate < todayIso() ? c.endDate : todayIso(), reason: "" });
  const a = useAction();
  const { L, t } = useHrI18n();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/employees/${id}/contracts/${c.id}/end`, { json: f.v });
    onDone();
  });
  return (
    <Dialog open title={L(`إنهاء العقد ${c.contractNo}`, `End contract ${c.contractNo}`)} onClose={onClose} actions={<><Btn variant="danger" busy={a.busy === "save"} onClick={submit} disabled={!f.v.endDate || f.v.reason.trim().length < 3}>{L("إنهاء العقد", "End contract")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <Notice tone="warning">{L("إنهاء العقد لا يُنهي خدمة الموظف. لإنهاء الخدمة استخدم تبويب «إنهاء الخدمة».", "Ending the contract does not end the employee’s service. Use the End of service tab for that.")}</Notice>
      <div className="hr-form">
        <Field label={L("تاريخ الانتهاء *", "End date *")}><input className="hr-input" type="date" {...f.bind("endDate")} /></Field>
        <Field label={L("السبب *", "Reason *")} wide><textarea className="hr-textarea" {...f.bind("reason")} /></Field>
      </div>
    </Dialog>
  );
}

function PayDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const f = useForm({ effectiveFrom: todayIso(), basic: "", housing: "0", transport: "0", otherAllowance: "0", reason: "" });
  const a = useAction();
  const amounts = ["basic", "housing", "transport", "otherAllowance"] as const;
  const { L, t } = useHrI18n();
  const bad = amounts.filter((k) => !isAmount(f.v[k]));
  const total = amounts.reduce((s, k) => s + (Number(f.v[k]) || 0), 0);
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/employees/${id}/compensation`, { json: { ...f.v, housing: f.v.housing || "0", transport: f.v.transport || "0", otherAllowance: f.v.otherAllowance || "0" } });
    onDone();
  });
  const amountErr = (k: (typeof amounts)[number]) => (bad.includes(k) ? L("رقم موجب بخانتين عشريتين على الأكثر", "A positive number with at most two decimals") : null);
  return (
    <Dialog open title={L("نسخة راتب جديدة", "New pay version")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!f.v.effectiveFrom || !f.v.basic || bad.length > 0 || f.v.reason.trim().length < 3}>{t("save")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <Notice>{L("النسخ لا تتداخل: هذه النسخة تُغلق النسخة المفتوحة في اليوم السابق لتاريخ سريانها. لا تُقبل نسخة تبدأ في شهر اعتُمد مسيره أو صُرف؛ صحّح الأشهر السابقة بمسير تصحيحي.", "Versions never overlap: this version closes the open one the day before it takes effect. A version cannot start in a month whose payroll is approved or paid; correct past months with a correction run.")}</Notice>
      <div className="hr-form">
        <Field label={L("سريان من *", "Effective from *")}><input className="hr-input" type="date" {...f.bind("effectiveFrom")} /></Field>
        <Field label={L("الأساسي *", "Basic *")} error={amountErr("basic")}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("basic")} /></Field>
        <Field label={L("بدل السكن", "Housing allowance")} error={amountErr("housing")}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("housing")} /></Field>
        <Field label={L("بدل النقل", "Transport allowance")} error={amountErr("transport")}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("transport")} /></Field>
        <Field label={L("بدلات أخرى", "Other allowances")} error={amountErr("otherAllowance")}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("otherAllowance")} /></Field>
        <Field label={L("الإجمالي", "Total")}><span className="hr-metric">{money(total)}</span></Field>
        <Field label={L("السبب *", "Reason *")} wide><input className="hr-input" {...f.bind("reason")} placeholder={L("مثال: زيادة سنوية", "e.g. annual raise")} /></Field>
      </div>
    </Dialog>
  );
}
