"use client";
// P-2 finding 8 / E-7 · Final financial settlement (end of service + leave encashment).
// INTERIM MANUAL PROCEDURE: the amounts are calculated by hand outside the system; each step
// here records its evidence and the server refuses a step whose evidence is missing. Separate
// from ending the employment. Never shown as paid or complete without verified evidence.
import { useCallback, useState, type ReactNode } from "react";
import { Btn, Dialog, ErrorState, Field, KV, LoadingTable, Notice, money, todayIso, useAction, useForm, useHr, useHrI18n } from "@/components/hr/ui";
import { SectionHead, isAmount, mutate } from "./shared";

type Settlement = {
  id: string; settlementNo: string; status: string; isPaid: boolean; isClosed: boolean;
  evidence: Record<"calculated" | "reviewed" | "approved" | "posted" | "paid" | "closed", boolean>;
  eosAmount: string | null; leaveEncashmentDays: string | null; leaveEncashmentAmount: string | null; totalAmount: string | null;
  calcInputs: { serviceStart?: string; serviceEnd?: string; wageUsed?: string; wageDefinition?: string } | null; calcMethodNote: string | null; calcReference: string | null; calcDocumentId: string | null;
  eosProvisionAmount: string | null; leaveProvisionAmount: string | null; provisionReference: string | null; fingerprint: string | null;
  /** P-2 review P2-B5: e.g. NO_EOS_PROVISION — an amount due with no recognised provision, for the accountant. */
  flags?: string[];
  /** P-2 rev3 item 4 (D-7g): per provision — due, used from THIS employee's provision, its balance, and a shortfall with its decision. */
  provision?: { key: string; due: string; used: string; shortfall: string; employeeBalance: string; shortfallDecision: { status: string; decisionReference: string } | null }[] | null;
  preparedByName: string | null; calculatedByName: string | null; reviewedByName: string | null; reviewAttestation: string | null; approvedByName: string | null;
  postingMode: string | null; journalEntryId: string | null; paidAmount: string | null; paidOn: string | null; paymentReference: string | null; paymentJournalEntryId: string | null; paidByName: string | null;
  closedByName: string | null; cancelReason: string | null;
};
type Data = { separation: { id: string; status: string }; settlement: Settlement | null; documents: { id: string; title: string; category: string }[] };

const STAGES: [string, string, string][] = [
  ["DRAFT", "مسودة", "Draft"],
  ["CALCULATED", "محسوبة يدويًا (بإثبات)", "Calculated by hand (evidenced)"],
  ["REVIEWED", "مراجَعة من شخص مستقل", "Reviewed independently"],
  ["APPROVED", "معتمدة", "Approved"],
  ["POSTED", "مُرحّلة بقيد", "Posted to a journal"],
  ["PAID", "مصروفة بإثبات دفع", "Paid, with proof"],
  ["CLOSED", "مُقفلة", "Closed"],
];
type Step = "calculate" | "review" | "return" | "approve" | "post" | "pay" | "close" | "cancel";
const wrap = { overflowWrap: "anywhere" as const, wordBreak: "break-word" as const };

export default function FinalSettlementPanel({ separationId }: { separationId: string }) {
  const q = useHr<Data>(`/api/hr/separations/${separationId}/final-settlement`);
  const a = useAction();
  const [dlg, setDlg] = useState<Step | null>(null);
  const { L, lang } = useHrI18n();
  const close = useCallback(() => setDlg(null), []);
  const done = useCallback(() => { setDlg(null); void q.reload(); }, [q]);
  const start = () => a.run("start", async () => { await mutate(`/api/hr/separations/${separationId}/final-settlement`, { json: {} }); void q.reload(); });

  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (q.loading && !q.data) return <LoadingTable rows={3} />;
  if (!q.data) return null;
  const s = q.data.settlement;
  const idx = s ? STAGES.findIndex((x) => x[0] === s.status) : -1;
  const next: [Step, string][] = !s ? [] : ({
    DRAFT: [["calculate", L("تسجيل الحساب اليدوي", "Record the manual calculation")], ["cancel", L("إلغاء", "Cancel")]],
    CALCULATED: [["review", L("مراجعة مستقلة", "Independent review")], ["return", L("إعادة للتصحيح", "Return for correction")]],
    REVIEWED: [["approve", L("اعتماد", "Approve")], ["return", L("إعادة للتصحيح", "Return for correction")]],
    APPROVED: [["post", L("ترحيل القيد", "Post the journal")], ["cancel", L("إلغاء", "Cancel")]],
    POSTED: [["pay", L("تسجيل الدفع بإثبات", "Record payment with proof")]],
    PAID: [["close", L("إقفال", "Close")]],
  } as Record<string, [Step, string][]>)[s.status] ?? [];

  return (
    <section className="hr-stack" data-testid="hr-final-settlement" style={{ minWidth: 0 }}>
      <SectionHead title={L("التسوية المالية النهائية", "Final financial settlement")} actions={!s ? <Btn size="sm" variant="primary" busy={a.busy === "start"} onClick={start}>{L("بدء التسوية", "Start the settlement")}</Btn> : null} />
      <Notice tone="warning">{L("إجراء يدوي مؤقت — لا يحسب النظام المكافأة ولا رصيد الإجازة", "Interim manual procedure — the system does not calculate the award or the leave payout")}</Notice>
      <p className="hr-caption" style={{ margin: 0 }}>
        {L("منفصلة عن إنهاء الخدمة: تُحسب يدويًا ثم تُراجَع من شخص مستقل وتُعتمد وتُرحّل بقيد وتُصرف بإثبات دفع. لا تظهر «مصروفة» أو «مُقفلة» دون إثبات تتحقق منه الخادم، ولا تُصرف أبدًا عبر مسير الرواتب.",
          "Separate from ending the employment: calculated by hand, reviewed by an independent person, approved, posted to a journal and paid with proof. It never shows as paid or closed without evidence the server has verified, and it is never paid through payroll.")}
      </p>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      {s ? (
        <>
          <ol className="hr-stack" style={{ gap: 4, margin: 0, paddingInlineStart: 20 }} aria-label={L("مراحل التسوية", "Settlement stages")}>
            {STAGES.map(([k, ar, en], i) => (
              <li key={k} className={i <= idx ? "strong" : "hr-muted"} aria-current={i === idx ? "step" : undefined}>
                {lang === "en" ? en : ar}{i === idx ? <span className="sub"> · {L("الحالية", "current")}</span> : null}
              </li>
            ))}
          </ol>
          {s.status === "CANCELLED" ? <Notice tone="warning">{L(`ملغاة: ${s.cancelReason ?? ""}`, `Cancelled: ${s.cancelReason ?? ""}`)}</Notice> : null}
          <KV rows={[
            [L("الرقم", "Number"), <span key="n" className="hr-num">{s.settlementNo}</span>],
            [L("مكافأة نهاية الخدمة", "End-of-service award"), s.eosAmount ? <span key="e" className="hr-num">{money(s.eosAmount)}</span> : "—"],
            [L("بدل رصيد الإجازة", "Leave encashment"), s.leaveEncashmentAmount ? <span key="l" className="hr-num">{money(s.leaveEncashmentAmount)} ({Number(s.leaveEncashmentDays)} {L("يوم", "days")})</span> : "—"],
            [L("الإجمالي", "Total"), s.totalAmount ? <span key="t" className="hr-num">{money(s.totalAmount)}</span> : "—"],
            [L("المخصص المقيّد مقابلها", "Provision booked against"), s.eosProvisionAmount || s.leaveProvisionAmount ? <span key="p" style={wrap}>{money(s.eosProvisionAmount ?? "0")} + {money(s.leaveProvisionAmount ?? "0")} · {s.provisionReference}</span> : "—"],
            ...((s.flags ?? []).length ? [[L("للمحاسب", "For the accountant"), <span key="fl" style={wrap}>{(s.flags ?? []).map((x) => (x === "NO_EOS_PROVISION" ? L("لا مخصص نهاية خدمة مقابل المكافأة", "No end-of-service provision behind the award") : x === "NO_LEAVE_PROVISION" ? L("لا مخصص إجازات مقابل البدل", "No leave provision behind the encashment") : x)).join(L("، ", ", "))}</span>] as [string, ReactNode]] : []),
            ...((s.provision ?? []).filter((u) => Number(u.due) > 0).map((u) => [
              u.key === "EOS_PROVISION" ? L("مخصص نهاية الخدمة للموظف", "Employee's end-of-service provision") : L("مخصص الإجازات للموظف", "Employee's leave provision"),
              <span key={u.key} style={wrap}>
                {L("المستخدم", "Used")} <span className="hr-num">{money(u.used)}</span> {L("من رصيده", "of the employee's")} <span className="hr-num">{money(u.employeeBalance)}</span>
                {Number(u.shortfall) > 0 ? <> · {L("عجز", "Shortfall")} <span className="hr-num">{money(u.shortfall)}</span> — {u.shortfallDecision?.status === "APPROVED" ? L(`بقرار المحاسب ${u.shortfallDecision.decisionReference}`, `per accountant decision ${u.shortfallDecision.decisionReference}`) : L("لا يُرحَّل قبل قرار المحاسب (D-7g)", "not posted before the accountant's decision (D-7g)")}</> : null}
              </span>,
            ] as [string, ReactNode])),
            [L("مرجع الحساب", "Calculation reference"), s.calcReference ? <span key="r" style={wrap}>{s.calcReference}</span> : "—"],
            [L("المحتسب", "Calculated by"), s.calculatedByName ?? "—"],
            [L("المراجع المستقل", "Independent reviewer"), s.reviewedByName ? <span key="v" style={wrap}>{s.reviewedByName} — {s.reviewAttestation}</span> : "—"],
            [L("المعتمد", "Approved by"), s.approvedByName ?? "—"],
            [L("قيد الاستحقاق", "Accrual journal"), s.journalEntryId ? <span key="j" className="hr-iso" style={wrap}>{s.postingMode === "SYSTEM" ? L("آلي", "System") : L("يدوي", "Manual")} · {s.journalEntryId}</span> : "—"],
            [L("الدفع", "Payment"), s.isPaid ? <span key="d" style={wrap}>{money(s.paidAmount)} · {s.paidOn} · {s.paymentReference} · {s.paidByName}</span> : L("لم يُسجّل دفع بإثبات", "No evidenced payment recorded")],
          ]} />
          {next.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {next.map(([k, label], i) => <Btn key={k} size="sm" variant={i === 0 ? "primary" : k === "cancel" ? "danger" : "secondary"} onClick={() => setDlg(k)}>{label}</Btn>)}
            </div>
          ) : null}
          {s.isClosed ? <Notice tone="success">{L("أُقفلت التسوية بعد التحقق من قيدي الاستحقاق والدفع وإثبات الدفع.", "Closed after verifying the accrual and payment journals and the payment proof.")}</Notice> : null}
          {dlg ? <StepDialog step={dlg} s={s} docs={q.data.documents} onClose={close} onDone={done} /> : null}
        </>
      ) : (
        <p className="hr-caption" style={{ margin: 0 }}>{L("لم تبدأ تسوية مالية بعد.", "No financial settlement has been started.")}</p>
      )}
    </section>
  );
}

function StepDialog({ step, s, docs, onClose, onDone }: { step: Step; s: Settlement; docs: Data["documents"]; onClose: () => void; onDone: () => void }) {
  const { L, t } = useHrI18n();
  const a = useAction();
  const f = useForm({
    eosAmount: "", leaveEncashmentDays: "", leaveEncashmentAmount: "", serviceStart: "", serviceEnd: "", wageUsed: "", wageDefinition: "", calcMethodNote: "", calcReference: "", calcDocumentId: "",
    eosProvisionAmount: "", leaveProvisionAmount: "", provisionReference: "", attestation: "", note: "", reason: "", leaveTypeCode: "",
    paidOn: todayIso(), paidAmount: s.totalAmount ?? "", paymentReference: "", paymentProofDocumentId: "", paymentJournalEntryId: "",
  });
  const v = f.v;
  const body: Record<Step, () => Record<string, unknown>> = {
    calculate: () => ({ eosAmount: v.eosAmount, leaveEncashmentDays: v.leaveEncashmentDays, leaveEncashmentAmount: v.leaveEncashmentAmount, calcMethodNote: v.calcMethodNote, calcReference: v.calcReference, calcDocumentId: v.calcDocumentId, eosProvisionAmount: v.eosProvisionAmount, leaveProvisionAmount: v.leaveProvisionAmount, provisionReference: v.provisionReference, calcInputs: { serviceStart: v.serviceStart, serviceEnd: v.serviceEnd, wageUsed: v.wageUsed, wageDefinition: v.wageDefinition, ...(v.leaveTypeCode.trim() ? { leaveTypeCode: v.leaveTypeCode.trim() } : {}) } }),
    review: () => ({ attestation: v.attestation, expected: s.fingerprint }),
    return: () => ({ reason: v.reason }),
    approve: () => ({ note: v.note, expected: s.fingerprint }),
    // P-2 review P1-B1: always the HR (system) journal — a manual journal kept outside HR is refused.
    post: () => ({ mode: "SYSTEM" }),
    pay: () => ({ paidOn: v.paidOn, paidAmount: v.paidAmount, paymentReference: v.paymentReference, paymentProofDocumentId: v.paymentProofDocumentId }),
    close: () => ({ note: v.note }),
    cancel: () => ({ reason: v.reason }),
  };
  const ok: Record<Step, boolean> = {
    calculate: !!v.eosAmount && isAmount(v.eosAmount) && !!v.leaveEncashmentAmount && isAmount(v.leaveEncashmentAmount) && isAmount(v.leaveEncashmentDays) && v.leaveEncashmentDays !== "" && !!v.serviceStart && !!v.serviceEnd && !!v.wageUsed && v.wageDefinition.trim().length >= 3 && v.calcMethodNote.trim().length >= 10 && v.calcReference.trim().length >= 3 && !!v.calcDocumentId && isAmount(v.eosProvisionAmount) && isAmount(v.leaveProvisionAmount) && (Number(v.leaveEncashmentAmount) === 0 || v.leaveTypeCode.trim().length > 0),
    review: v.attestation.trim().length >= 10,
    return: v.reason.trim().length >= 5,
    approve: true,
    post: true,
    pay: !!v.paidOn && isAmount(v.paidAmount) && v.paymentReference.trim().length >= 3 && !!v.paymentProofDocumentId && s.postingMode === "SYSTEM",
    close: true,
    cancel: v.reason.trim().length >= 3,
  };
  const titles: Record<Step, string> = {
    calculate: L("الحساب اليدوي ومدخلاته", "Manual calculation and its inputs"), review: L("مراجعة مستقلة", "Independent review"), return: L("إعادة للتصحيح", "Return for correction"),
    approve: L("اعتماد التسوية", "Approve the settlement"), post: L("ترحيل القيد", "Post the journal"), pay: L("تسجيل الدفع", "Record the payment"), close: L("إقفال التسوية", "Close the settlement"), cancel: L("إلغاء التسوية", "Cancel the settlement"),
  };
  const submit = () => a.run("save", async () => { await mutate(`/api/hr/final-settlements/${s.id}/${step}`, { json: body[step]() }); onDone(); });
  const docSelect = (k: "calcDocumentId" | "paymentProofDocumentId") => (
    <select className="hr-select" {...f.bind(k)}>
      <option value="">{L("— اختر مستندًا من ملف الموظف —", "— choose a document on the employee's file —")}</option>
      {docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
    </select>
  );
  return (
    <Dialog open title={titles[step]} onClose={onClose} actions={<><Btn variant={step === "cancel" ? "danger" : "primary"} busy={a.busy === "save"} disabled={!ok[step]} onClick={submit}>{t("save")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      {step === "calculate" ? (
        <>
          <Notice tone="warning">{L("لا يحسب النظام شيئًا: أدخل ما حسبته يدويًا ومدخلاته، وأرفق ورقة الحساب في ملف الموظف أولًا ثم اخترها.", "The system calculates nothing: enter what you calculated by hand and its inputs; upload the worksheet to the employee's file first, then choose it.")}</Notice>
          <div className="hr-form">
            <Field label={L("مكافأة نهاية الخدمة *", "End-of-service award *")}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("eosAmount")} /></Field>
            <Field label={L("أيام الإجازة المستحقة الصرف *", "Leave days encashed *")}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("leaveEncashmentDays")} /></Field>
            <Field label={L("مبلغ بدل الإجازة *", "Leave encashment amount *")}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("leaveEncashmentAmount")} /></Field>
            <Field label={L("رمز نوع الإجازة المصروف بدلها", "Leave type encashed (code)")} help={L("مطلوب إن كان للبدل مبلغ. نوع مؤكد فقط — لا يُصرف بدل على نوع مقترح.", "Required when there is an encashment amount. Confirmed types only — never a proposal.")}><input className="hr-input" dir="ltr" {...f.bind("leaveTypeCode")} /></Field>
            <Field label={L("الأجر المستخدم *", "Wage used *")}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("wageUsed")} /></Field>
            <Field label={L("بداية الخدمة *", "Service start *")}><input className="hr-input" type="date" {...f.bind("serviceStart")} /></Field>
            <Field label={L("نهاية الخدمة *", "Service end *")}><input className="hr-input" type="date" {...f.bind("serviceEnd")} /></Field>
            <Field label={L("تعريف الأجر المستخدم *", "Wage definition used *")} wide><input className="hr-input" {...f.bind("wageDefinition")} /></Field>
            <Field label={L("طريقة الحساب *", "Calculation method *")} help={L("عشرة أحرف على الأقل", "At least ten characters")} wide><textarea className="hr-textarea" {...f.bind("calcMethodNote")} /></Field>
            <Field label={L("مرجع ورقة الحساب *", "Worksheet reference *")}><input className="hr-input" {...f.bind("calcReference")} /></Field>
            <Field label={L("ورقة الحساب المرفقة *", "Attached worksheet *")}>{docSelect("calcDocumentId")}</Field>
            <Field label={L("مخصص نهاية الخدمة المعترف به", "Recognised EOS provision")}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("eosProvisionAmount")} /></Field>
            <Field label={L("مخصص الإجازات المعترف به", "Recognised leave provision")}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("leaveProvisionAmount")} /></Field>
            <Field label={L("مرجع المخصص", "Provision reference")} wide><input className="hr-input" {...f.bind("provisionReference")} /></Field>
          </div>
        </>
      ) : null}
      {step === "review" ? (
        <>
          <p className="hr-caption" style={{ margin: 0 }}>{L("تراجع شخصًا غير من أعدّ التسوية أو حسبها. اكتب ما تحققت منه.", "You must be someone other than whoever prepared or calculated it. State what you checked.")}</p>
          <Field label={L("إقرار المراجعة *", "Review attestation *")} wide><textarea className="hr-textarea" {...f.bind("attestation")} /></Field>
        </>
      ) : null}
      {step === "approve" || step === "close" ? <Field label={L("ملاحظة", "Note")} wide><input className="hr-input" {...f.bind("note")} /></Field> : null}
      {step === "return" || step === "cancel" ? <Field label={L("السبب *", "Reason *")} wide><input className="hr-input" {...f.bind("reason")} /></Field> : null}
      {step === "post" ? (
        <>
          <p className="hr-caption" style={{ margin: 0 }}>{L("قيد آلي عبر خريطة الحسابات، مربوط بهذه التسوية. يُقيَّد المخصص المعترف به في الدفاتر أولًا ويُصرف الفائض فقط. يُرفض إن كانت محاسبة الموارد البشرية متوقفة أو الحسابات غير مربوطة، ولا يُقبل قيد يدوي خارجها.", "A system journal through the account map, linked to this settlement. The provision the ledger recognises is debited first and only the excess expensed. Refused while HR accounting is off or the accounts are unmapped; a manual journal outside HR is not accepted.")}</p>
        </>
      ) : null}
      {step === "pay" ? (
        <div className="hr-form">
          <Field label={L("تاريخ الدفع *", "Paid on *")}><input className="hr-input" type="date" {...f.bind("paidOn")} /></Field>
          <Field label={L("المبلغ *", "Amount *")}><input className="hr-input" inputMode="decimal" dir="ltr" {...f.bind("paidAmount")} /></Field>
          <Field label={L("مرجع الدفع *", "Payment reference *")}><input className="hr-input" {...f.bind("paymentReference")} /></Field>
          <Field label={L("إثبات الدفع المرفق *", "Attached payment proof *")}>{docSelect("paymentProofDocumentId")}</Field>
          {s.postingMode === "MANUAL" ? <Notice tone="danger">{L("رُحّلت هذه التسوية بقيد يدوي خارج محاسبة الموارد البشرية، ولا يوجد مسار خارجي معتمد، فلا يُسجَّل دفعها.", "This settlement was posted with a manual journal outside HR accounting and no external route is approved, so its payment cannot be recorded.")}</Notice> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
