"use client";
import { Select } from "@/components/ui/Select";
import { useCreateRequest } from "@/components/shell/page-context";
import { Plus } from "lucide-react";
// HR-06 · Salary advances (Figma 1JbZgpMqmPkUVne8ms9Ozz · 454:1437). Split page: tabs by
// stage, table, preview drawer with the decision trail, installments and the actions the
// caller's duties allow. The API enforces the segregation (approver ≠ requester ≠ person,
// disburser ≠ approver); buttons are a convenience.
import { useMemo, useState, type ReactNode } from "react";
import type { Lang } from "@/lib/i18n/translations";
import {
  ADVANCE_STATUS, Btn, Dialog, Empty, ErrorState, Field, Flag, INSTALLMENT_STATUS, KV, LoadingTable, NoPermission, Notice,
  PageHeader, StatusDot, Tabs, hrFetch, money, todayIso, useAction, useCan, useForm, useHr, useHrI18n, useHrMeta,
} from "@/components/hr/ui";

type CapCheck = { ok: boolean; code?: string; cap?: string; largestInstallment?: string; monthlyGross?: string; maxDeductionPercent?: string; policyVersion?: number; minInstallments?: number | null };
type Installment = { id: string; seq: number; dueMonth: string; amount: string; status: string; payrollRunId: string | null };
type Advance = {
  id: string; advanceNo: string; employeeId: string; amount: string; installmentCount: number; firstInstallmentMonth: string; reason: string; status: string;
  requestedBy: string; createdAt: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null;
  disbursedBy: string | null; disbursedOn: string | null; disbursementRef: string | null; closedAt: string | null;
  settled: string; reserved: string; repaid: string; outstanding: string;
  capCheck: CapCheck | null;
  installments: Installment[];
  repayments: { id: string; amount: string; paidOn: string; method: string; reference: string }[];
  employee: { id: string; fullNameAr: string; employeeNo: string };
  isMine: boolean;
};
type View = "requested" | "approved" | "open" | "closed";
const VIEW_STATUS: Record<View, string[]> = { requested: ["REQUESTED"], approved: ["APPROVED"], open: ["DISBURSED"], closed: ["CLOSED", "REJECTED", "CANCELLED"] };
const METHOD: Record<string, [string, string]> = { BANK_TRANSFER: ["تحويل بنكي", "Bank transfer"], CASH: ["نقدًا", "Cash"], CHEQUE: ["شيك", "Cheque"] };
const methodLabel = (m: string, en: boolean) => (METHOD[m] ? METHOD[m][en ? 1 : 0] : m);
const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : "—");
const nextMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
};
const perInstallment = (a: Advance) => (a.installments.length ? a.installments[0].amount : Math.floor((Number(a.amount) / a.installmentCount) * 100) / 100);

export default function AdvancesPage() {
  const can = useCan();
  const { meta } = useHrMeta();
  const reader = can("advances_manage") || can("advances_approve") || can("advances_disburse");
  const { data, error, loading, reload } = useHr<Advance[]>(meta && !reader ? null : "/api/hr/advances");
  const [view, setView] = useState<View>("requested");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // «جديد» from the shell (A-3): `?new=1` opens the same form as «سلفة جديدة».
  useCreateRequest("advance", () => setCreating(true), can("advances_manage"));
  const [flash, setFlash] = useState<string | null>(null);
  const { L } = useHrI18n();

  const counts = useMemo(() => {
    const c = { requested: 0, approved: 0, open: 0, closed: 0 } as Record<View, number>;
    for (const a of data ?? []) for (const v of Object.keys(VIEW_STATUS) as View[]) if (VIEW_STATUS[v].includes(a.status)) c[v]++;
    return c;
  }, [data]);
  const rows = (data ?? []).filter((a) => VIEW_STATUS[view].includes(a.status));
  const sel = (data ?? []).find((a) => a.id === selected) ?? null;

  if (meta && !reader) return <div className="hr-page"><NoPermission duty={L("السلف", "Advances")} /></div>;

  return (
    <div className={`hr-split${sel ? " has-preview" : ""}`}>
      <div className="hr-page">
        <PageHeader title={L("السلف", "Advances")} actions={can("advances_manage") ? <Btn variant="primary" onClick={() => setCreating(true)}><Plus aria-hidden="true" /> {L("سلفة جديدة", "New advance")}</Btn> : null} />
        <Tabs
          label={L("مراحل السلف", "Advance stages")}
          value={view}
          onChange={(v) => { setView(v); setSelected(null); }}
          items={[
            { key: "requested", label: L("بانتظار الاعتماد", "Awaiting approval"), count: data ? counts.requested : undefined },
            { key: "approved", label: L("معتمدة بانتظار الصرف", "Approved, awaiting payment"), count: data ? counts.approved : undefined },
            { key: "open", label: L("قائمة", "Open"), count: data ? counts.open : undefined },
            { key: "closed", label: L("مغلقة", "Closed"), count: data ? counts.closed : undefined },
          ]}
        />
        {flash ? <Notice tone="success">{flash}</Notice> : null}
        {error ? <ErrorState error={error} onRetry={reload} /> : null}
        {loading && !data ? <LoadingTable /> : null}
        {data && rows.length === 0 ? (
          <Empty
            title={view === "requested" ? L("لا طلبات بانتظار الاعتماد", "No requests awaiting approval") : view === "approved" ? L("لا سلف بانتظار الصرف", "No advances awaiting payment") : view === "open" ? L("لا سلف قائمة", "No open advances") : L("لا سلف مغلقة", "No closed advances")}
            body={view === "requested" ? L("تظهر هنا طلبات السلف المسجلة من الموظفين أو من الموارد البشرية.", "Advance requests recorded by employees or by HR appear here.") : undefined}
          />
        ) : null}
        {rows.length > 0 ? (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow" aria-label={L("السلف", "Advances")}>
              <thead>
                <tr>
                  <th>{L("الرقم", "No.")}</th><th>{L("الموظف", "Employee")}</th><th className="num">{L("المبلغ", "Amount")}</th><th className="num hr-hide-preview">{L("الأقساط", "Instalments")}</th>
                  <th className="num hr-hide-compact">{L("المسدد", "Repaid")}</th><th className="num hr-hide-compact">{L("محجوز", "Reserved")}</th><th className="num">{L("المتبقي", "Remaining")}</th><th>{L("الحالة", "Status")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="is-clickable" aria-selected={selected === a.id} tabIndex={0} onClick={() => setSelected(a.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSelected(a.id))}>
                    <td data-label={L("الرقم", "No.")}><span className="hr-id">{a.advanceNo}</span></td>
                    <td data-label={L("الموظف", "Employee")} className="strong m-title hr-wrap-en"><span className="hr-nowrap">{a.employee.fullNameAr}</span><span className="sub hr-id hr-hide-mobile">{a.employee.employeeNo}</span><span className="hr-msub"><span className="hr-id">{a.advanceNo}</span> · <span className="hr-num">{a.installmentCount} × {money(perInstallment(a))}</span> · {L("المبلغ", "amount")} <span className="hr-num">{money(a.amount)}</span></span></td>
                    <td data-label={L("المبلغ", "Amount")} className="num">{money(a.amount)}</td>
                    <td data-label={L("الأقساط", "Instalments")} className="num hr-hide-preview">{a.installmentCount} × {money(perInstallment(a))}</td>
                    <td data-label={L("المسدد", "Repaid")} className="num hr-hide-compact">{money(Number(a.settled) + Number(a.repaid))}</td>
                    <td data-label={L("محجوز", "Reserved")} className="num hr-hide-compact">{money(a.reserved)}</td>
                    <td data-label={L("المتبقي", "Remaining")} className="num strong">{a.status === "DISBURSED" || a.status === "CLOSED" ? money(a.outstanding) : "—"}</td>
                    <td data-label={L("الحالة", "Status")} className="m-end is-stack">{a.status === "DISBURSED" || a.status === "CLOSED" ? <span className="hr-mobile-only hr-num strong">{money(a.outstanding)}</span> : null}<StatusDot map={ADVANCE_STATUS} value={a.status} /></td>
                  </tr>
                ))}
              </tbody>
              {view === "open" ? (
                <tfoot>
                  <tr>
                    <td colSpan={2} className="m-title">{L("الإجمالي", "Total")} · {rows.length}<span className="hr-msub">{L("المبلغ", "Amount")} <span className="hr-num">{money(rows.reduce((s, a) => s + Number(a.amount), 0))}</span></span></td>
                    <td className="num">{money(rows.reduce((s, a) => s + Number(a.amount), 0))}</td>
                    <td />
                    <td className="num hr-hide-compact">{money(rows.reduce((s, a) => s + Number(a.settled) + Number(a.repaid), 0))}</td>
                    <td className="num hr-hide-compact">{money(rows.reduce((s, a) => s + Number(a.reserved), 0))}</td>
                    <td className="num m-end is-stack">{money(rows.reduce((s, a) => s + Number(a.outstanding), 0))}<span className="hr-mobile-only hr-caption" style={{ fontWeight: 400 }}>{L("المتبقي", "Remaining")}</span></td>
                    <td />
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        ) : null}
        <p className="hr-caption" style={{ margin: 0 }}>
          {L("الاعتماد من شخص غير الطالب وغير صاحب السلفة، والصرف يُسجَّل من شخص غير المعتمد. النظام يسجّل الصرف ومرجعه ولا يحوّل أموالًا.", "Approval is by someone other than the requester and the employee, and the payment is recorded by someone other than the approver. The system records the payment and its reference; it does not transfer money.")}
        </p>
      </div>
      {sel ? (
        <>
          <div className="hr-scrim" onClick={() => setSelected(null)} />
          <Preview a={sel} onClose={() => setSelected(null)} onChanged={(msg) => { setFlash(msg); void reload(); }} />
        </>
      ) : null}
      {creating ? <CreateAdvance onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setFlash(L("سُجّل طلب السلفة، وهو بانتظار اعتماد مستقل.", "Advance request recorded; it awaits independent approval.")); setView("requested"); setSelected(id); void reload(); }} /> : null}
    </div>
  );
}

type Act = null | "approve" | "reject" | "disburse" | "repay" | "close" | "cancel";

function Preview({ a, onClose, onChanged }: { a: Advance; onClose: () => void; onChanged: (msg: string) => void }) {
  const can = useCan();
  const act = useAction();
  const [dialog, setDialog] = useState<Act>(null);
  const { L, lang, month } = useHrI18n();
  const base = `/api/hr/advances/${a.id}`;
  const run = (key: string, path: string, json: unknown, msg: string) =>
    act.run(key, async () => {
      await hrFetch(`${base}/${path}`, { json });
      setDialog(null);
      onChanged(msg);
    });
  const st = a.status;
  const outstanding = Number(a.outstanding);
  const reserved = Number(a.reserved);
  const repayable = Math.max(0, outstanding - reserved);

  const foot: ReactNode[] = [];
  if (st === "REQUESTED" && can("advances_approve")) {
    const overCap = a.capCheck ? !a.capCheck.ok : false;
    foot.push(<Btn key="ap" variant="primary" disabled={a.isMine || overCap} title={a.isMine ? L("طلبتها أو تخصّك؛ يعتمدها شخص آخر", "You requested it or it is yours; someone else approves it") : overCap ? L("لا تُعتمد: قسط يتجاوز حد الاستقطاع", "Cannot be approved: the instalment exceeds the deduction cap") : undefined} onClick={() => setDialog("approve")}>{L("اعتماد", "Approve")}</Btn>);
    foot.push(<Btn key="rj" variant="danger" disabled={a.isMine} onClick={() => setDialog("reject")}>{L("رفض", "Reject")}</Btn>);
  }
  if (st === "APPROVED" && can("advances_disburse")) foot.push(<Btn key="ds" variant="primary" onClick={() => setDialog("disburse")}>{L("تسجيل الصرف", "Record payment")}</Btn>);
  if (st === "DISBURSED" && can("advances_manage")) {
    foot.push(<Btn key="rp" disabled={repayable <= 0} title={repayable <= 0 ? L("المتبقي محجوز كله في مسير", "The whole remainder is reserved in a payroll run") : undefined} onClick={() => setDialog("repay")}>{L("تسجيل سداد نقدي", "Record cash repayment")}</Btn>);
    if (outstanding <= 0 && reserved <= 0) foot.push(<Btn key="cl" busy={act.busy === "close"} onClick={() => run("close", "close", {}, L("أُغلقت السلفة.", "Advance closed."))}>{L("إغلاق", "Close")}</Btn>);
  }
  if ((st === "REQUESTED" || st === "APPROVED") && (can("advances_manage") || (a.isMine && st === "REQUESTED"))) foot.push(<Btn key="cn" variant="ghost" onClick={() => setDialog("cancel")}>{L("إلغاء السلفة", "Cancel advance")}</Btn>);

  return (
    <aside className="hr-preview" aria-label={L("معاينة السلفة", "Advance preview")}>
      <div className="hr-preview-head">
        <span className="hr-id">{a.advanceNo}</span>
        <Btn variant="ghost" size="sm" aria-label={L("إغلاق المعاينة", "Close preview")} onClick={onClose}>✕</Btn>
      </div>
      <div className="hr-preview-body">
        <div>
          <h2 className="hr-mobile-title">{L(`سلفة ${a.employee.fullNameAr}`, `${a.employee.fullNameAr}’s advance`)}</h2>
          <div className="hr-caption"><span className="hr-id">{a.employee.employeeNo}</span> · {L(`${a.installmentCount} أقساط تبدأ ${month(a.firstInstallmentMonth)}`, `${a.installmentCount} instalments from ${month(a.firstInstallmentMonth)}`)}</div>
        </div>
        <div className="hr-meta">
          <StatusDot map={ADVANCE_STATUS} value={st} />
          {a.isMine ? <Flag tone="info">{L("طلبتها أو تخصّك", "Your own request")}</Flag> : null}
        </div>
        {act.error && !dialog ? <Notice tone="danger">{act.error}</Notice> : null}
        {a.capCheck && !a.capCheck.ok ? <div data-testid="hr-advance-cap-warning"><Notice tone="warning">{capWarning(a.capCheck, lang)}</Notice></div> : null}
        <KV rows={[
          [L("المبلغ", "Amount"), <span key="a" className="hr-num">{money(a.amount)}</span>],
          [L("المسدد", "Repaid"), <span key="s" className="hr-num">{money(Number(a.settled) + Number(a.repaid))}{Number(a.repaid) > 0 ? <span className="hr-caption"> ({L("نقدًا", "cash")} {money(a.repaid)})</span> : null}</span>],
          [L("محجوز في مسير", "Reserved in payroll"), <span key="r" className="hr-num">{money(a.reserved)}</span>, reserved > 0 ? "warning" : undefined],
          [L("المتبقي", "Remaining"), <span key="o" className="hr-num">{st === "DISBURSED" || st === "CLOSED" ? money(a.outstanding) : "—"}</span>],
        ]} />
        <div className="hr-stack" style={{ gap: 4 }}>
          <span className="hr-label">{L("السبب", "Reason")}</span>
          <p className="hr-body-s" style={{ margin: 0 }}>{a.reason}</p>
        </div>
        <div className="hr-stack" style={{ gap: 4 }}>
          <span className="hr-label">{L("مسار القرار", "Decision trail")}</span>
          <KV rows={[
            [L("الطلب", "Request"), <span key="q" className="hr-num">{day(a.createdAt)}</span>],
            [L("الاعتماد المستقل", "Independent approval"), a.decidedAt
              ? <span key="d">{st === "REJECTED" ? L("مرفوضة", "Rejected") : L("معتمدة", "Approved")} · <span className="hr-num">{day(a.decidedAt)}</span>{a.decisionNote ? <span className="hr-caption" style={{ display: "block" }}>{a.decisionNote}</span> : null}</span>
              : st === "CANCELLED" ? L("أُلغيت قبل القرار", "Cancelled before a decision") : L("بانتظار", "Pending"), a.decidedAt ? undefined : "muted"],
            [L("الصرف المسجّل", "Recorded payment"), a.disbursedOn
              ? <span key="p"><span className="hr-num">{a.disbursedOn}</span> · <span className="hr-id">{a.disbursementRef}</span></span>
              : "—", a.disbursedOn ? undefined : "muted"],
            ...(st === "CANCELLED" && a.decisionNote ? ([[L("سبب الإلغاء", "Reason for cancelling"), a.decisionNote]] as [ReactNode, ReactNode][]) : []),
            ...(a.closedAt ? ([[L("الإغلاق", "Closed"), <span key="c" className="hr-num">{day(a.closedAt)}</span>]] as [ReactNode, ReactNode][]) : []),
          ]} />
        </div>
        {a.installments.length ? (
          <div className="hr-stack" style={{ gap: 4 }}>
            <span className="hr-label">{L("الأقساط", "Instalments")}</span>
            <table className="hr-table is-dense">
              <thead><tr><th>{L("الشهر", "Month")}</th><th className="num">{L("المبلغ", "Amount")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
              <tbody>
                {a.installments.map((i) => (
                  <tr key={i.id}>
                    <td>{month(i.dueMonth)}</td>
                    <td className="num">{money(i.amount)}</td>
                    <td><StatusDot map={INSTALLMENT_STATUS} value={i.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hr-caption" style={{ margin: 0 }}>{L("القسط المحجوز يصبح مسددًا فقط عند تسجيل صرف المسير؛ إلغاء المسير يعيده مجدولًا. لا يُحجز القسط نفسه في مسيرين.", "A reserved instalment becomes repaid only when the payroll payment is recorded; cancelling the run makes it scheduled again. The same instalment is never reserved in two runs.")}</p>
          </div>
        ) : st === "REQUESTED" || st === "APPROVED" ? (
          <p className="hr-caption" style={{ margin: 0 }}>{L(`يُنشأ جدول الأقساط (${a.installmentCount} × ${money(perInstallment(a))} تقريبًا، يبدأ ${month(a.firstInstallmentMonth)}) عند تسجيل الصرف.`, `The instalment schedule (about ${a.installmentCount} × ${money(perInstallment(a))}, from ${month(a.firstInstallmentMonth)}) is created when the payment is recorded.`)}</p>
        ) : null}
        {a.repayments.length ? (
          <div className="hr-stack" style={{ gap: 4 }}>
            <span className="hr-label">{L("سداد مباشر", "Direct repayment")}</span>
            <KV rows={a.repayments.map((r) => [
              <span key="k"><span className="hr-num">{r.paidOn}</span> · {methodLabel(r.method, lang === "en")} · <span className="hr-id">{r.reference}</span></span>,
              <span key="v" className="hr-num">{money(r.amount)}</span>,
            ])} />
          </div>
        ) : null}
      </div>
      {foot.length ? <div className="hr-preview-foot">{foot}</div> : null}

      {dialog === "approve" ? (
        <NoteDialog title={L("اعتماد السلفة", "Approve advance")} confirm={L("اعتماد", "Approve")} busy={act.busy === "approve"} error={act.error} required={false} onClose={() => { setDialog(null); act.setError(null); }}
          body={<>{L(`اعتماد سلفة ${a.employee.fullNameAr} بمبلغ`, `Approve ${a.employee.fullNameAr}’s advance of`)} <span className="hr-num">{money(a.amount)}</span> {L(`على ${a.installmentCount} أقساط. الصرف يسجّله شخص غيرك.`, `over ${a.installmentCount} instalments. Someone else records the payment.`)}</>}
          onSubmit={(note) => run("approve", "decide", { decision: "APPROVE", note: note || undefined }, L("اعتُمدت السلفة، وهي بانتظار تسجيل الصرف.", "Advance approved; it awaits the payment record."))} />
      ) : null}
      {dialog === "reject" ? (
        <NoteDialog title={L("رفض السلفة", "Reject advance")} confirm={L("رفض", "Reject")} danger busy={act.busy === "reject"} error={act.error} required onClose={() => { setDialog(null); act.setError(null); }}
          body={L("سبب الرفض مطلوب ويُسجَّل.", "A reason is required and recorded.")}
          onSubmit={(note) => run("reject", "decide", { decision: "REJECT", note }, L("رُفضت السلفة.", "Advance rejected."))} />
      ) : null}
      {dialog === "cancel" ? (
        <NoteDialog title={L("إلغاء السلفة", "Cancel advance")} confirm={L("إلغاء السلفة", "Cancel advance")} danger busy={act.busy === "cancel"} error={act.error} required min={3} onClose={() => { setDialog(null); act.setError(null); }}
          body={L("تُلغى السلفة قبل صرفها فقط.", "An advance can be cancelled only before it is paid.")}
          onSubmit={(reason) => run("cancel", "cancel", { reason }, L("أُلغيت السلفة.", "Advance cancelled."))} />
      ) : null}
      {dialog === "disburse" ? (
        <DisburseDialog a={a} busy={act.busy === "disburse"} error={act.error} onClose={() => { setDialog(null); act.setError(null); }}
          onSubmit={(b) => run("disburse", "disburse", b, L("سُجّل صرف السلفة وأُنشئ جدول الأقساط.", "Advance payment recorded and the instalment schedule created."))} />
      ) : null}
      {dialog === "repay" ? (
        <RepayDialog max={repayable} busy={act.busy === "repay"} error={act.error} onClose={() => { setDialog(null); act.setError(null); }}
          onSubmit={(b) => run("repay", "repay", b, L("سُجّل السداد.", "Repayment recorded."))} />
      ) : null}
    </aside>
  );
}

function NoteDialog({ title, body, confirm, danger, required, min = 1, busy, error, onClose, onSubmit }: {
  title: string; body: ReactNode; confirm: string; danger?: boolean; required: boolean; min?: number; busy: boolean; error: string | null; onClose: () => void; onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const ok = !required || note.trim().length >= min;
  const { L } = useHrI18n();
  return (
    <Dialog open title={title} onClose={onClose} actions={<><Btn variant={danger ? "danger" : "primary"} busy={busy} disabled={!ok} onClick={() => onSubmit(note.trim())}>{confirm}</Btn><Btn onClick={onClose}>{L("تراجع", "Discard")}</Btn></>}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <p className="hr-body-s" style={{ margin: 0 }}>{body}</p>
      <Field label={required ? L("السبب *", "Reason *") : L("ملاحظة", "Note")}><textarea className="hr-textarea" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Dialog>
  );
}

function DisburseDialog({ a, busy, error, onClose, onSubmit }: { a: Advance; busy: boolean; error: string | null; onClose: () => void; onSubmit: (b: Record<string, string>) => void }) {
  const f = useForm({ paidOn: todayIso(), reference: "" });
  const ok = !!f.v.paidOn && !!f.v.reference.trim();
  const { L } = useHrI18n();
  return (
    <Dialog open title={L("تسجيل صرف السلفة", "Record advance payment")} onClose={onClose} actions={<><Btn variant="primary" busy={busy} disabled={!ok} onClick={() => onSubmit({ paidOn: f.v.paidOn, reference: f.v.reference.trim() })}>{L("تسجيل", "Record")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Notice tone="info">{L("يُسجَّل صرف", "Records the payment of")} <span className="hr-num">{money(a.amount)}</span> {L(`لـ${a.employee.fullNameAr} ومرجعه ويُرحَّل قيده، ولا يحوّل النظام أموالًا. لا يسجّل الصرف من اعتمد السلفة.`, `to ${a.employee.fullNameAr} with its reference and posts the entry; the system does not transfer money. Whoever approved the advance cannot record the payment.`)}</Notice>
      <div className="hr-form">
        <Field label={L("تاريخ الصرف *", "Payment date *")}><input className="hr-input" type="date" {...f.bind("paidOn")} /></Field>
        <Field label={L("المرجع *", "Reference *")} help={L("رقم الحوالة أو السند", "Transfer or voucher number")}><input className="hr-input" dir="ltr" {...f.bind("reference")} /></Field>
      </div>
    </Dialog>
  );
}

function RepayDialog({ max, busy, error, onClose, onSubmit }: { max: number; busy: boolean; error: string | null; onClose: () => void; onSubmit: (b: Record<string, string>) => void }) {
  const f = useForm({ amount: max.toFixed(2), paidOn: todayIso(), method: "CASH", reference: "" });
  const n = Number(f.v.amount);
  const ok = n > 0 && n <= max + 1e-9 && !!f.v.paidOn && !!f.v.reference.trim();
  const { L, lang } = useHrI18n();
  return (
    <Dialog open title={L("تسجيل سداد مباشر", "Record direct repayment")} onClose={onClose} actions={<><Btn variant="primary" busy={busy} disabled={!ok} onClick={() => onSubmit({ ...f.v, reference: f.v.reference.trim() })}>{L("تسجيل", "Record")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <p className="hr-body-s" style={{ margin: 0 }}>{L("يغطي السداد الأقساط المجدولة من آخر الجدول. لا يُسدَّد ما هو محجوز في مسير.", "The repayment covers scheduled instalments from the end of the schedule. Amounts reserved in a payroll run cannot be repaid.")}</p>
      <div className="hr-form">
        <Field label={L("المبلغ *", "Amount *")} help={L(`الحد الأقصى الآن ${money(max)}`, `Maximum now ${money(max)}`)} error={n > max + 1e-9 ? L("أكبر من المتاح للسداد", "More than can be repaid") : null}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("amount")} /></Field>
        <Field label={L("التاريخ *", "Date *")}><input className="hr-input" type="date" {...f.bind("paidOn")} /></Field>
        <Field label={L("الطريقة", "Method")}>
          <Select className="hr-select" {...f.bind("method")}>
            {Object.keys(METHOD).map((k) => <option key={k} value={k}>{methodLabel(k, lang === "en")}</option>)}
          </Select>
        </Field>
        <Field label={L("المرجع *", "Reference *")}><input className="hr-input" dir="ltr" {...f.bind("reference")} /></Field>
      </div>
    </Dialog>
  );
}

function CreateAdvance({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { meta } = useHrMeta();
  const f = useForm({ employeeId: "", amount: "", installmentCount: "3", firstInstallmentMonth: nextMonth(), reason: "" });
  const a = useAction();
  const n = Number(f.v.installmentCount);
  const amt = Number(f.v.amount);
  const { L } = useHrI18n();
  const ok = !!f.v.employeeId && amt > 0 && Number.isInteger(n) && n >= 1 && n <= 120 && /^\d{4}-\d{2}$/.test(f.v.firstInstallmentMonth) && f.v.reason.trim().length >= 3;
  const submit = () => a.run("create", async () => {
    const r = await hrFetch<{ id: string }>("/api/hr/advances", { json: { employeeId: f.v.employeeId, amount: f.v.amount, installmentCount: n, firstInstallmentMonth: f.v.firstInstallmentMonth, reason: f.v.reason.trim() } });
    onCreated(r.id);
  });
  return (
    <Dialog open title={L("سلفة جديدة", "New advance")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "create"} disabled={!ok} onClick={submit}>{L("تسجيل الطلب", "Record request")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {a.error ? <div data-testid="hr-advance-create-error"><Notice tone="danger">{a.error}</Notice></div> : null}
      <div className="hr-form">
        <Field label={L("الموظف *", "Employee *")} wide>
          <Select className="hr-select" {...f.bind("employeeId")}>
            <option value="">—</option>
            {meta?.people.map((p) => <option key={p.id} value={p.id}>{p.fullNameAr} · {p.employeeNo}</option>)}
          </Select>
        </Field>
        <Field label={L("المبلغ *", "Amount *")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("amount")} /></Field>
        <Field label={L("عدد الأقساط *", "Number of instalments *")} help={amt > 0 && n >= 1 ? L(`≈ ${money(Math.floor((amt / n) * 100) / 100)} للقسط`, `≈ ${money(Math.floor((amt / n) * 100) / 100)} per instalment`) : undefined}><input className="hr-input hr-num" type="number" min={1} max={120} {...f.bind("installmentCount")} /></Field>
        <Field label={L("أول قسط *", "First instalment *")}><input className="hr-input" type="month" {...f.bind("firstInstallmentMonth")} /></Field>
        <Field label={L("السبب *", "Reason *")} wide><textarea className="hr-textarea" {...f.bind("reason")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("سلفة قائمة واحدة لكل موظف (سياسة مقترحة). لا يُقبل قسط أكبر من حد الاستقطاع من الراتب الشهري. يعتمدها شخص غيرك وغير صاحبها، ثم يسجّل صرفها شخص غير المعتمد.", "One open advance per employee (proposed policy). No instalment above the monthly salary deduction cap is accepted. Someone other than you and the employee approves it, then someone other than the approver records the payment.")}</p>
    </Dialog>
  );
}

/** Why this request cannot be approved as it stands (F2 / finding 2); the server refuses the same. */
function capWarning(c: CapCheck, lang: Lang): string {
  const en = lang === "en";
  if (c.code === "NO_POLICY") return en ? "No payroll policy is in effect in the month of the first instalment, so the instalments cannot be checked against the deduction cap. The advance is not approved until then." : "لا توجد سياسة رواتب سارية في شهر أول قسط، فلا يمكن التحقق من الأقساط مقابل حد الاستقطاع. لا تُعتمد السلفة قبل ذلك.";
  if (c.code === "NO_COMPENSATION") return en ? "No salary is recorded for this employee, so the instalments cannot be checked against the deduction cap. The advance is not approved until then." : "لا يوجد راتب مسجّل لهذا الموظف، فلا يمكن التحقق من الأقساط مقابل حد الاستقطاع. لا تُعتمد السلفة قبل ذلك.";
  if (en) return `The largest instalment ${money(c.largestInstallment ?? "0")} exceeds the deduction cap ${money(c.cap ?? "0")} (${c.maxDeductionPercent}% of the monthly salary ${money(c.monthlyGross ?? "0")}), so it would not be deducted in any run. ${c.minInstallments ? `Spread it over at least ${c.minInstallments} instalments in a new request.` : "Lower the amount in a new request."}`;
  return `أكبر قسط ${money(c.largestInstallment ?? "0")} يتجاوز حد الاستقطاع ${money(c.cap ?? "0")} (${c.maxDeductionPercent}% من الراتب الشهري ${money(c.monthlyGross ?? "0")})، فلن يُخصم في أي مسيّر. ${c.minInstallments ? `وزّعها على ${c.minInstallments} أقساط على الأقل في طلب جديد.` : "خفّض المبلغ في طلب جديد."}`;
}
