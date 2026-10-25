"use client";
// HR self-service request dialogs — the leave request (with its live quote), the advance request and
// the reason dialog of a cancellation. Moved unchanged out of «خدماتي» (dashboard/me) so «مساحة عملي ·
// طلباتي» uses the very same forms against the same /api/hr/me endpoints (feat/my-workspace).
import { useEffect, useRef, useState } from "react";
import { Select } from "@/components/ui/Select";
import { Btn, Dialog, Empty, Field, Flag, KV, Notice, ProposalTag, days, hrFetch, money, useAction, useForm, useHrI18n } from "@/components/hr/ui";
import { DateRangeSummary, QuoteNotes, quoteRows, useLeaveQuote } from "@/components/hr/leave-quote";
import { leaveTypeName } from "@/lib/i18n/hr";

export type SelfBalance = { leaveTypeId: string; code: string; nameAr: string; paid: boolean; tracksBalance: boolean; isProposal: boolean; balance: string; pending: string; available: string };
/** What the leave dialog needs from GET /api/hr/me. */
export type SelfLeaveCtx = { today: string; person: { manager: string | null }; leaveBalances: SelfBalance[] };
type LeaveReq = { id: string; days: string };

export const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
export const nextMonth = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

export function LeaveDialog({ d, onClose, onDone }: { d: SelfLeaveCtx; onClose: () => void; onDone: () => void }) {
  const first = d.leaveBalances[0];
  const f = useForm({ leaveTypeId: first?.leaveTypeId ?? "", startDate: d.today, endDate: d.today, reason: "" });
  const act = useAction();
  const key = useRef<string | null>(null);
  const [result, setResult] = useState<(LeaveReq & { replayed?: boolean }) | null>(null);
  const type = d.leaveBalances.find((b) => b.leaveTypeId === f.v.leaveTypeId);
  const { L, lang } = useHrI18n();
  const q = useLeaveQuote("/api/hr/me/leave/quote", result ? null : { leaveTypeId: f.v.leaveTypeId, startDate: f.v.startDate, endDate: f.v.endDate });
  const bind = (k: keyof typeof f.v) => {
    const b = f.bind(k);
    return { ...b, onChange: (e: { target: { value: string } }) => { key.current = null; b.onChange(e); } };
  };
  const submit = () => act.run("l", async () => {
    key.current ??= newKey();
    const r = await hrFetch<LeaveReq & { replayed?: boolean }>("/api/hr/me/leave", { json: { leaveTypeId: f.v.leaveTypeId, startDate: f.v.startDate, endDate: f.v.endDate, reason: f.v.reason || undefined, idempotencyKey: key.current } });
    setResult(r);
    onDone();
  });
  const invalid = !f.v.leaveTypeId || !f.v.startDate || !f.v.endDate || f.v.endDate < f.v.startDate;

  if (!d.leaveBalances.length) {
    return <Dialog open title={L("طلب إجازة", "Leave request")} onClose={onClose} actions={<Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn>}><Empty title={L("لا أنواع إجازات متاحة", "No leave types available")} body={L("لم تُعرَّف أنواع الإجازات بعد. تواصل مع الموارد البشرية.", "Leave types are not defined yet. Contact HR.")} /></Dialog>;
  }
  return (
    <Dialog
      open
      title={L("طلب إجازة", "Leave request")}
      onClose={onClose}
      actions={result ? <Btn variant="primary" onClick={onClose}>{L("تم", "Done")}</Btn> : <><Btn variant="primary" busy={act.busy === "l"} disabled={invalid || q.blocking} onClick={submit}>{L("إرسال الطلب", "Submit request")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}
    >
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      {result ? <Notice tone="success">{result.replayed ? L("سبق إرسال هذا الطلب؛ لم يُنشأ طلب ثانٍ.", "This request was already sent; no second request was created.") : <>{L("أُرسل الطلب", "Request sent")} (<span className="hr-num">{days(result.days)}</span> {L("يوم)، وهو بانتظار القرار.", "days); it awaits a decision.")}</>}</Notice> : null}
      <div className="hr-form has-date-pair">
        <Field label={L("النوع", "Type")} wide>
          <Select className="hr-select" disabled={!!result} {...bind("leaveTypeId")}>
            {d.leaveBalances.map((b) => <option key={b.leaveTypeId} value={b.leaveTypeId}>{leaveTypeName(b, lang)}{b.tracksBalance ? L(` · المتاح ${days(b.available)} يومًا`, ` · ${days(b.available)} days available`) : ""}{b.paid ? "" : L(" · بدون راتب", " · unpaid")}</option>)}
          </Select>
        </Field>
        <div className="is-half-mobile"><Field label={L("تاريخ البداية", "Start date")}><input className="hr-input" type="date" disabled={!!result} {...bind("startDate")} /></Field></div>
        <div className="is-half-mobile"><Field label={L("تاريخ النهاية (يُحتسب)", "End date (counted)")} error={f.v.endDate && f.v.endDate < f.v.startDate ? L("لا تنتهي الإجازة قبل بدايتها.", "The leave cannot end before it starts.") : null}><input className="hr-input" type="date" min={f.v.startDate} disabled={!!result} {...bind("endDate")} /></Field></div>
      </div>
      {!result ? <DateRangeSummary start={f.v.startDate} end={f.v.endDate} /> : null}
      {!result ? (
        <>
          <KV rows={[...quoteRows(q, lang), [L("يعتمده", "Approver"), d.person.manager ? L(`${d.person.manager} (المدير المباشر)`, `${d.person.manager} (line manager)`) : L("الموارد البشرية", "HR")]]} />
          <QuoteNotes q={q} refused={!!act.error} />
          <div className="hr-form"><Field label={L("السبب (اختياري)", "Reason (optional)")} wide><textarea className="hr-textarea is-compact" rows={1} maxLength={500} {...bind("reason")} /></Field></div>
          {type?.isProposal ? <div><ProposalTag /> <span className="hr-caption">{L("استحقاق هذا النوع مقترح لم تعتمده الإدارة بعد.", "This type’s accrual is a proposal management has not approved yet.")}</span></div> : null}
        </>
      ) : null}
    </Dialog>
  );
}

export function AdvanceDialog({ today, onClose, onDone }: { today: string; onClose: () => void; onDone: () => void }) {
  const f = useForm({ amount: "", installmentCount: "3", firstInstallmentMonth: nextMonth(today), reason: "" });
  const act = useAction();
  const n = Math.max(1, Number(f.v.installmentCount) || 1);
  const { L } = useHrI18n();
  const each = Number(f.v.amount) > 0 ? Math.floor((Number(f.v.amount) / n) * 100) / 100 : null;
  const submit = () => act.run("a", async () => {
    await hrFetch("/api/hr/me/advances", { json: { amount: f.v.amount, installmentCount: Number(f.v.installmentCount), firstInstallmentMonth: f.v.firstInstallmentMonth, reason: f.v.reason } });
    onDone();
  });
  return (
    <Dialog open title={L("طلب سلفة", "Advance request")} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "a"} disabled={!f.v.amount || !f.v.firstInstallmentMonth || f.v.reason.trim().length < 3} onClick={submit}>{L("إرسال الطلب", "Submit request")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("المبلغ *", "Amount *")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("amount")} /></Field>
        <Field label={L("عدد الأقساط *", "Number of instalments *")}><input className="hr-input hr-num" type="number" min={1} max={120} {...f.bind("installmentCount")} /></Field>
        <Field label={L("شهر أول قسط *", "First instalment month *")} help={L("يُخصم القسط من مسير ذلك الشهر.", "The instalment is deducted in that month’s payroll.")}><input className="hr-input" type="month" min={today.slice(0, 7)} {...f.bind("firstInstallmentMonth")} /></Field>
        <Field label={L("القسط التقريبي", "Approximate instalment")}><span className="hr-num" style={{ paddingBlock: 8 }}>{each !== null ? money(each) : "—"}</span></Field>
        <Field label={L("السبب *", "Reason *")} wide><textarea className="hr-textarea" maxLength={500} {...f.bind("reason")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("سلفة واحدة مفتوحة لكل موظف (سياسة مقترحة). يمكنك إلغاء الطلب ما دام بانتظار الاعتماد.", "One open advance per employee (proposed policy). You can cancel the request while it awaits approval.")}</p>
    </Dialog>
  );
}

export function ReasonDialog({ title, confirm, url, onClose, onDone, children }: { title: string; confirm: string; url: string; onClose: () => void; onDone: () => void; children: React.ReactNode }) {
  const [reason, setReason] = useState("");
  const act = useAction();
  const { L } = useHrI18n();
  const submit = () => act.run("x", async () => {
    await hrFetch(url, { json: { reason } });
    onDone();
  });
  return (
    <Dialog open title={title} onClose={onClose} actions={<><Btn variant="danger" busy={act.busy === "x"} disabled={reason.trim().length < 3} onClick={submit}>{confirm}</Btn><Btn onClick={onClose}>{L("تراجع", "Discard")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      {children}
      <Field label={L("السبب *", "Reason *")}><textarea className="hr-textarea" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {reason && reason.trim().length < 3 ? <Flag tone="danger">{L("السبب قصير جدًا.", "The reason is too short.")}</Flag> : null}
    </Dialog>
  );
}

// ── For pages outside «خدماتي» («مساحة عملي · طلباتي»): the same dialogs, fed by GET /api/hr/me ──────

function useSelf() {
  const [ctx, setCtx] = useState<SelfLeaveCtx | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    hrFetch<SelfLeaveCtx & { linked: boolean }>("/api/hr/me")
      .then((d) => { if (alive) { if (d.linked) setCtx(d); else setError("NOT_LINKED"); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);
  return { ctx, error };
}

export function LeaveRequestDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { ctx, error } = useSelf();
  const { L } = useHrI18n();
  if (!ctx) return <Dialog open title={L("طلب إجازة", "Leave request")} onClose={onClose} actions={<Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn>}>{error ? <Notice tone="danger">{error}</Notice> : <span className="hr-caption">{L("جارٍ التحميل…", "Loading…")}</span>}</Dialog>;
  return <LeaveDialog d={ctx} onClose={onClose} onDone={onDone} />;
}

export function AdvanceRequestDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { ctx, error } = useSelf();
  const { L } = useHrI18n();
  if (!ctx) return <Dialog open title={L("طلب سلفة", "Advance request")} onClose={onClose} actions={<Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn>}>{error ? <Notice tone="danger">{error}</Notice> : <span className="hr-caption">{L("جارٍ التحميل…", "Loading…")}</span>}</Dialog>;
  return <AdvanceDialog today={ctx.today} onClose={onClose} onDone={onDone} />;
}

export function CancelRequestDialog({ kind, id, onClose, onDone }: { kind: "LEAVE" | "ADVANCE"; id: string; onClose: () => void; onDone: () => void }) {
  const { L } = useHrI18n();
  return kind === "LEAVE" ? (
    <ReasonDialog title={L("إلغاء إجازة معتمدة", "Cancel approved leave")} confirm={L("إلغاء الإجازة", "Cancel leave")} url={`/api/hr/me/leave/${encodeURIComponent(id)}/cancel`} onClose={onClose} onDone={onDone}>
      <p className="hr-caption" style={{ margin: 0 }}>{L("قبل بدايتها تعود الأيام إلى رصيدك بحركة عكسية؛ بعد بدايتها يحتاج الإلغاء موافقة الموارد البشرية.", "Before it starts the days return to your balance; after it starts, cancelling needs HR.")}</p>
    </ReasonDialog>
  ) : (
    <ReasonDialog title={L("إلغاء طلب السلفة", "Cancel advance request")} confirm={L("إلغاء الطلب", "Cancel request")} url={`/api/hr/me/advances/${encodeURIComponent(id)}/cancel`} onClose={onClose} onDone={onDone}>{null}</ReasonDialog>
  );
}
