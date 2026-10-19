"use client";
// HR-04 · Leave — preview pane, ledger table and dialogs (used by ./page.tsx).
import { Select } from "@/components/ui/Select";
import { useState, type ReactNode } from "react";
import {
  Btn, Dialog, ErrorState, Field, Flag, KV, LoadingTable, Notice, ProposalTag, REQUEST_STATUS, StatusDot,
  days, hrFetch, todayIso, useAction, useCan, useForm, useHr, useHrI18n, useHrMeta, dateTimeIn
} from "@/components/hr/ui";
import { leaveTypeName } from "@/lib/i18n/hr";
import { hrText } from "@/lib/hr/messages-en";
import type { Lang } from "@/lib/i18n/translations";
import { DateRangeSummary, QuoteNotes, quoteRows, useLeaveQuote } from "@/components/hr/leave-quote";

// ── Shapes (see src/lib/hr/services/leave.ts) ──────────────────────────────────────

export type LeaveRow = {
  id: string; employeeId: string; leaveTypeId: string; startDate: string; endDate: string; days: string; status: string;
  reason: string | null; requestedBy: string; createdAt: string; decidedBy: string | null; decidedAt: string | null;
  decisionNote: string | null; cancelledAt: string | null; cancelReason: string | null;
  employee: { id: string; fullNameAr: string; employeeNo: string };
  leaveType: { code: string; nameAr: string; paid: boolean };
  isMine: boolean;
};
export type Balance = { leaveTypeId: string; code: string; nameAr: string; paid: boolean; tracksBalance: boolean; isProposal: boolean; balance: string; pending: string; available: string };
export type LedgerRow = { id: string; entryType: string; days: string; effectiveDate: string; requestId: string | null; reason: string | null; running: string; createdAt: string };
export type LeaveTypeFull = { id: string; code: string; nameAr: string; paid: boolean; tracksBalance: boolean; accrualDaysPerYear: string | null; allowNegative: boolean; active: boolean; isProposal: boolean };

export const ENTRY_TYPE: Record<string, [string, string]> = {
  OPENING: ["رصيد افتتاحي", "Opening balance"], GRANT: ["منحة", "Grant"], ADJUSTMENT: ["تسوية", "Adjustment"], ACCRUAL: ["استحقاق شهري", "Monthly accrual"], TAKE: ["إجازة معتمدة", "Approved leave"], REVERSAL: ["حركة عكسية · إلغاء", "Reversal · cancellation"],
};

const signed = (v: string) => {
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
};

/** A short day count: «3 أيام», «يوم واحد», «1.5 يوم» / "3 days", "1 day". */
export function dayCount(v: string | number, lang: Lang = "ar") {
  const n = Number(v);
  if (lang === "en") return n === 1 ? "1 day" : `${days(n)} days`;
  if (n === 1) return "يوم واحد";
  if (n === 2) return "يومان";
  if (Number.isInteger(n) && n >= 3 && n <= 10) return `${n} أيام`;
  return `${days(n)} يوم`;
}

// ── Ledger ─────────────────────────────────────────────────────────────────────────

export function LedgerTable({ employeeId, leaveTypeId, reloadKey }: { employeeId: string; leaveTypeId: string; reloadKey?: number }) {
  const { data, error, loading, reload } = useHr<LedgerRow[]>(`/api/hr/leave/ledger?employeeId=${encodeURIComponent(employeeId)}&leaveTypeId=${encodeURIComponent(leaveTypeId)}&k=${reloadKey ?? 0}`);
  const today = todayIso();
  const { L, lang } = useHrI18n();
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <LoadingTable rows={4} />;
  if (!data || data.length === 0) return <p className="hr-caption" style={{ margin: 0 }}>{L("لا توجد حركات على هذا الرصيد بعد.", "No entries on this balance yet.")}</p>;
  return (
    <div className="hr-tablewrap">
      <table className="hr-table is-stack is-dense" aria-label={L("سجل الرصيد", "Balance ledger")}>
        <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("الحركة", "Movement")}</th><th className="num">{L("أيام", "Days")}</th><th className="num">{L("الرصيد", "Balance")}</th></tr></thead>
        <tbody>
          {data.map((r) => {
            const future = r.effectiveDate > today;
            return (
              <tr key={r.id} style={future ? { color: "var(--hr-muted)" } : undefined}>
                <td data-label={L("التاريخ", "Date")}><span className="hr-num">{r.effectiveDate}</span></td>
                <td data-label={L("الحركة", "Movement")}><span className="hr-nowrap hr-ledger-entry">{ENTRY_TYPE[r.entryType] ? ENTRY_TYPE[r.entryType][lang === "en" ? 1 : 0] : r.entryType}{future ? L(" (قادم)", " (upcoming)") : ""}</span>{r.reason && r.entryType !== "TAKE" && r.entryType !== "ACCRUAL" ? <span className="sub hr-sub-clip" title={hrText(r.reason, lang)}>{hrText(r.reason, lang)}</span> : null}</td>
                <td data-label={L("أيام", "Days")} className="num"><span className="hr-num">{signed(r.days)}</span></td>
                <td data-label={L("الرصيد", "Balance")} className="num">{Number(r.running).toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Preview ────────────────────────────────────────────────────────────────────────

export function RequestPreview({ row, version, onClose, onChanged, onReject, onCancel }: {
  row: LeaveRow; version: number; onClose: () => void; onChanged: () => void; onReject: (r: LeaveRow) => void; onCancel: (r: LeaveRow) => void;
}) {
  const can = useCan();
  const { meta } = useHrMeta();
  const a = useAction();
  const type = meta?.leaveTypes.find((t) => t.id === row.leaveTypeId);
  const tracks = type?.tracksBalance ?? true;
  const bal = useHr<Balance[]>(`/api/hr/employees/${row.employeeId}/leave?v=${version}`);
  const b = bal.data?.find((x) => x.leaveTypeId === row.leaveTypeId);
  const pending = row.status === "PENDING";
  const { L, lang } = useHrI18n();
  const approve = () => a.run("approve", async () => {
    await hrFetch(`/api/hr/leave/requests/${row.id}/decide`, { json: { decision: "APPROVE" } });
    onChanged();
  });
  const withdraw = () => a.run("withdraw", async () => {
    await hrFetch(`/api/hr/leave/requests/${row.id}/withdraw`, { json: {} });
    onChanged();
  });

  const kv: [string, ReactNode, string?][] = [
    [L("من", "From"), <span key="f" className="hr-num">{row.startDate}</span>],
    [L("إلى", "To"), <span key="t" className="hr-num">{row.endDate}</span>],
    [L("أيام العمل المحسوبة", "Working days counted"), <span key="d" className="hr-num">{days(row.days)}</span>],
  ];
  if (tracks && b) {
    if (pending) {
      kv.push([L("الرصيد قبل", "Balance before"), <span key="b" className="hr-num">{days(b.balance)}</span>]);
      const after = Number(b.balance) - Number(row.days);
      kv.push([L("الرصيد بعد الاعتماد", "Balance after approval"), <span key="a" className="hr-num">{days(after)}</span>, after < 0 ? "danger" : "success"]);
    } else {
      kv.push([L("الرصيد الحالي", "Current balance"), <span key="b" className="hr-num">{days(b.balance)}</span>]);
    }
  } else if (!tracks) {
    kv.push([L("الرصيد", "Balance"), L("لا يُخصم من رصيد", "Not deducted from a balance"), "muted"]);
  }
  kv.push([L("تاريخ الطلب", "Request date"), <span key="c" className="hr-num">{dateTimeIn(row.createdAt)}</span>]);
  if (row.reason) kv.push([L("السبب", "Reason"), row.reason]);
  if (row.decisionNote) kv.push([L("ملاحظة القرار", "Decision note"), row.decisionNote]);
  if (row.cancelReason) kv.push([L("سبب الإلغاء", "Reason for cancelling"), row.cancelReason]);

  return (
    <aside className="hr-preview" aria-label={L("معاينة طلب الإجازة", "Leave request preview")}>
      <div className="hr-preview-head">
        <span className="hr-id">{row.leaveType.code} · {row.employee.employeeNo}</span>
        <Btn variant="ghost" size="sm" aria-label={L("إغلاق المعاينة", "Close preview")} onClick={onClose}>✕</Btn>
      </div>
      <div className="hr-preview-body">
        <div>
          <h2 className="hr-mobile-title">{lang === "en" ? `${leaveTypeName(row.leaveType, lang)} leave` : leaveTypeName(row.leaveType, lang)} · {dayCount(row.days, lang)}</h2>
          <div className="hr-caption">{row.employee.fullNameAr} · <span className="hr-id">{row.employee.employeeNo}</span>{row.leaveType.paid ? "" : L(" · بدون راتب", " · unpaid")}</div>
        </div>
        <div className="hr-meta">
          <StatusDot map={REQUEST_STATUS} value={row.status} />
          {pending && row.isMine ? <Flag>{L("طلبك · لغيرك", "Your own request")}</Flag> : null}
          {type?.isProposal ? <ProposalTag /> : null}
        </div>
        {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
        {bal.error ? <ErrorState error={bal.error} onRetry={bal.reload} /> : null}
        <KV rows={kv} />
        {tracks ? (
          <>
            <span className="hr-section">{L(`سجل رصيد ${row.leaveType.nameAr}`, `${leaveTypeName(row.leaveType, lang)} balance ledger`)}</span>
            <LedgerTable employeeId={row.employeeId} leaveTypeId={row.leaveTypeId} reloadKey={version} />
            <p className="hr-caption" style={{ margin: 0 }}>{L("الرصيد مجموع كل الحركات بما فيها الإجازات المعتمدة مستقبلًا، فلا يمكن حجز الأيام نفسها مرتين. الإلغاء بعد الاعتماد يضيف حركة عكسية ولا يحذف شيئًا.", "The balance is the sum of all movements, including approved future leave, so the same days cannot be booked twice. Cancelling after approval adds a reversing movement and deletes nothing.")}</p>
          </>
        ) : null}
        {pending && row.isMine ? <p className="hr-caption" style={{ margin: 0 }}>{L("قدّمت هذا الطلب أو هو عنك، فيعتمده معتمد آخر. يمكنك سحبه ما دام بانتظار القرار.", "You filed this request or it is about you, so another approver decides it. You can withdraw it while it awaits a decision.")}</p> : null}
      </div>
      <div className="hr-preview-foot">
        {pending && !row.isMine && can("leave_approve") ? (
          <>
            <Btn variant="primary" busy={a.busy === "approve"} onClick={approve}>{L("اعتماد", "Approve")}</Btn>
            <Btn variant="danger" onClick={() => onReject(row)}>{L("رفض", "Reject")}</Btn>
          </>
        ) : null}
        {pending && row.isMine ? <Btn busy={a.busy === "withdraw"} onClick={withdraw}>{L("سحب الطلب", "Withdraw request")}</Btn> : null}
        {row.status === "APPROVED" && (can("leave_manage") || row.isMine) ? <Btn variant="danger" onClick={() => onCancel(row)}>{L("إلغاء الإجازة", "Cancel leave")}</Btn> : null}
        <Btn variant="ghost" onClick={onClose}>{L("إغلاق", "Close")}</Btn>
      </div>
    </aside>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────────────

/** A reason/note prompt for reject and cancel. */
export function NoteDialog({ title, label, help, required, confirm, danger, onClose, onSubmit }: {
  title: string; label: string; help?: string; required?: boolean; confirm: string; danger?: boolean;
  onClose: () => void; onSubmit: (note: string) => Promise<unknown>;
}) {
  const [note, setNote] = useState("");
  const a = useAction();
  const ok = !required || note.trim().length >= 3;
  const { L } = useHrI18n();
  return (
    <Dialog open title={title} onClose={onClose} actions={<><Btn variant={danger ? "danger" : "primary"} busy={a.busy === "go"} disabled={!ok} onClick={() => a.run("go", () => onSubmit(note.trim()))}>{confirm}</Btn><Btn onClick={onClose}>{L("تراجع", "Discard")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <Field label={required ? `${label} *` : label} help={help}>
        <textarea className="hr-textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
    </Dialog>
  );
}

type Person = { id: string; fullNameAr: string; employeeNo: string };

export function RequestLeaveDialog({ people, initialEmployeeId, onClose, onDone }: { people: Person[]; initialEmployeeId?: string; onClose: () => void; onDone: () => void }) {
  const { meta } = useHrMeta();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const f = useForm({ employeeId: initialEmployeeId ?? "", leaveTypeId: "", startDate: todayIso(), endDate: todayIso(), reason: "" });
  const a = useAction();
  const type = meta?.leaveTypes.find((t) => t.id === f.v.leaveTypeId);
  const valid = f.v.employeeId && f.v.leaveTypeId && f.v.startDate && f.v.endDate && f.v.endDate >= f.v.startDate;
  const { L, t, lang } = useHrI18n();
  const q = useLeaveQuote("/api/hr/leave/quote", f.v.employeeId ? { employeeId: f.v.employeeId, leaveTypeId: f.v.leaveTypeId, startDate: f.v.startDate, endDate: f.v.endDate } : null);
  const submit = () => a.run("save", async () => {
    await hrFetch("/api/hr/leave/requests", { json: { ...f.v, reason: f.v.reason || undefined, idempotencyKey } });
    onDone();
  });
  return (
    <Dialog open title={L("تسجيل إجازة", "Record leave")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} disabled={!valid || q.blocking} onClick={submit}>{L("تسجيل", "Record")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الموظف *", "Employee *")} wide>
          <Select className="hr-select" {...f.bind("employeeId")}><option value="">—</option>{people.map((p) => <option key={p.id} value={p.id}>{p.fullNameAr} · {p.employeeNo}</option>)}</Select>
        </Field>
        <Field label={L("نوع الإجازة *", "Leave type *")} wide>
          <Select className="hr-select" {...f.bind("leaveTypeId")}><option value="">—</option>{meta?.leaveTypes.map((x) => <option key={x.id} value={x.id}>{leaveTypeName(x, lang)}{x.paid ? "" : L(" · بدون راتب", " · unpaid")}</option>)}</Select>
        </Field>
        <Field label={L("تاريخ البداية *", "Start date *")}><input className="hr-input" type="date" {...f.bind("startDate")} /></Field>
        <Field label={L("تاريخ النهاية (يُحتسب) *", "End date (counted) *")} error={f.v.endDate && f.v.startDate && f.v.endDate < f.v.startDate ? L("لا تنتهي الإجازة قبل بدايتها.", "The leave cannot end before it starts.") : null}><input className="hr-input" type="date" min={f.v.startDate} {...f.bind("endDate")} /></Field>
        <Field label={L("السبب", "Reason")} wide><textarea className="hr-textarea" maxLength={500} {...f.bind("reason")} /></Field>
      </div>
      <DateRangeSummary start={f.v.startDate} end={f.v.endDate} />
      {valid ? <KV rows={quoteRows(q, lang)} /> : null}
      {type && !type.tracksBalance ? <p className="hr-caption" style={{ margin: 0 }}>{L("هذا النوع لا يُخصم من رصيد.", "This type is not deducted from a balance.")}</p> : null}
      <QuoteNotes q={q} refused={!!a.error} />
      <p className="hr-caption" style={{ margin: 0 }}>{L("تُحسب أيام العمل فقط وفق أيام العطلة في السياسة السارية. لا يعتمد الطلب من سجّله، ولا يُقبل طلب يتداخل مع إجازة قائمة.", "Only working days count, per the weekend days in the active policy. Whoever recorded the request cannot approve it, and a request overlapping existing leave is refused.")}</p>
    </Dialog>
  );
}

export function LedgerEntryDialog({ people, initialEmployeeId, onClose, onDone }: { people: Person[]; initialEmployeeId?: string; onClose: () => void; onDone: () => void }) {
  const { meta } = useHrMeta();
  const f = useForm({ employeeId: initialEmployeeId ?? "", leaveTypeId: "", entryType: "OPENING", days: "", effectiveDate: todayIso(), reason: "" });
  const a = useAction();
  const types = meta?.leaveTypes.filter((x) => x.tracksBalance) ?? [];
  const { L, t, lang } = useHrI18n();
  const n = Number(f.v.days);
  const daysErr = f.v.days === "" ? null : !Number.isFinite(n) || n === 0 ? L("عدد غير صفري.", "A non-zero number.") : f.v.entryType !== "ADJUSTMENT" && n < 0 ? L("استخدم «تسوية» للإنقاص.", "Use Adjustment to reduce.") : null;
  const valid = f.v.employeeId && f.v.leaveTypeId && f.v.days !== "" && !daysErr && f.v.effectiveDate && f.v.reason.trim().length >= 3;
  const submit = () => a.run("save", async () => {
    await hrFetch("/api/hr/leave/ledger", { json: { ...f.v, days: f.v.days, reason: f.v.reason.trim() } });
    onDone();
  });
  return (
    <Dialog open title={L("منحة / رصيد افتتاحي", "Grant / opening balance")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} disabled={!valid} onClick={submit}>{L("إضافة الحركة", "Add entry")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الموظف *", "Employee *")} wide>
          <Select className="hr-select" {...f.bind("employeeId")}><option value="">—</option>{people.map((p) => <option key={p.id} value={p.id}>{p.fullNameAr} · {p.employeeNo}</option>)}</Select>
        </Field>
        <Field label={L("نوع الإجازة *", "Leave type *")}>
          <Select className="hr-select" {...f.bind("leaveTypeId")}><option value="">—</option>{types.map((x) => <option key={x.id} value={x.id}>{leaveTypeName(x, lang)}</option>)}</Select>
        </Field>
        <Field label={L("الحركة *", "Entry *")}>
          <Select className="hr-select" {...f.bind("entryType")}>
            <option value="OPENING">{L("رصيد افتتاحي", "Opening balance")}</option><option value="GRANT">{L("منحة", "Grant")}</option><option value="ADJUSTMENT">{L("تسوية (+/−)", "Adjustment (+/−)")}</option>
          </Select>
        </Field>
        <Field label={L("أيام *", "Days *")} error={daysErr} help={L("حتى منزلتين عشريتين.", "Up to two decimals.")}><input className="hr-input hr-num" inputMode="decimal" dir="ltr" {...f.bind("days")} /></Field>
        <Field label={L("تاريخ السريان *", "Effective date *")}><input className="hr-input" type="date" {...f.bind("effectiveDate")} /></Field>
        <Field label={L("السبب *", "Reason *")} wide><textarea className="hr-textarea" maxLength={500} {...f.bind("reason")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("السجل لا يُعدَّل ولا يُحذف؛ كل تغيير حركة جديدة تُنسب إليك. الرصيد الافتتاحي مرة واحدة لكل نوع، وبعدها «تسوية». لا تعدّل رصيدك أنت.", "The ledger is never edited or deleted; every change is a new entry attributed to you. The opening balance is once per type, then Adjustment. Do not change your own balance.")}</p>
    </Dialog>
  );
}

export function AccrualDialog({ onClose, onDone }: { onClose: () => void; onDone: (created: number, month: string) => void }) {
  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const a = useAction();
  const { L, t } = useHrI18n();
  const submit = () => a.run("run", async () => {
    const r = await hrFetch<{ month: string; created: number }>("/api/hr/leave/accrue", { json: { month } });
    onDone(r.created, r.month);
  });
  return (
    <Dialog open title={L("استحقاق الشهر", "Monthly accrual")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "run"} disabled={!/^\d{4}-\d{2}$/.test(month)} onClick={submit}>{L("تشغيل الاستحقاق", "Run accrual")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <Field label={L("الشهر *", "Month *")}><input className="hr-input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
      <p className="hr-caption" style={{ margin: 0 }}>{L("يضيف لكل موظف على رأس العمل في آخر يوم من الشهر جزءًا من اثني عشر من الاستحقاق السنوي لكل نوع له استحقاق. التشغيل مرة ثانية للشهر نفسه لا يضيف شيئًا.", "Adds one twelfth of the annual accrual of each accruing type for every employee active on the last day of the month. Running it again for the same month adds nothing.")}</p>
    </Dialog>
  );
}

export function LeaveTypeDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const f = useForm({ code: "", nameAr: "", paid: "1", tracksBalance: "1", accrualDaysPerYear: "", allowNegative: "0", reason: "" });
  const a = useAction();
  const { L, t } = useHrI18n();
  const valid = f.v.code.trim() && f.v.nameAr.trim() && f.v.reason.trim().length >= 5 && (f.v.accrualDaysPerYear === "" || (Number(f.v.accrualDaysPerYear) >= 0 && Number(f.v.accrualDaysPerYear) <= 366));
  const submit = () => a.run("save", async () => {
    await hrFetch("/api/hr/leave/types", {
      json: {
        code: f.v.code.trim(), nameAr: f.v.nameAr.trim(), paid: f.v.paid === "1", tracksBalance: f.v.tracksBalance === "1",
        accrualDaysPerYear: f.v.tracksBalance === "1" && f.v.accrualDaysPerYear !== "" ? f.v.accrualDaysPerYear : null, allowNegative: f.v.allowNegative === "1",
        reason: f.v.reason.trim(),
      },
    });
    onDone();
  });
  return (
    <Dialog open title={L("طلب نوع إجازة جديد", "New leave type request")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} disabled={!valid} onClick={submit}>{L("إرسال للاعتماد", "Send for approval")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الرمز *", "Code *")}><input className="hr-input" dir="ltr" maxLength={20} {...f.bind("code")} /></Field>
        <Field label={L("الاسم *", "Name *")}><input className="hr-input" maxLength={80} {...f.bind("nameAr")} /></Field>
        <Field label={L("الراتب", "Pay")}><Select className="hr-select" {...f.bind("paid")}><option value="1">{L("مدفوعة", "Paid")}</option><option value="0">{L("بدون راتب", "Unpaid")}</option></Select></Field>
        <Field label={L("الرصيد", "Balance")}><Select className="hr-select" {...f.bind("tracksBalance")}><option value="1">{L("تُخصم من رصيد", "Deducted from a balance")}</option><option value="0">{L("بلا رصيد", "No balance")}</option></Select></Field>
        {f.v.tracksBalance === "1" ? (
          <>
            <Field label={L("الاستحقاق السنوي (أيام)", "Annual accrual (days)")} help={L("فارغ = بلا استحقاق شهري.", "Empty = no monthly accrual.")}><input className="hr-input hr-num" dir="ltr" inputMode="decimal" {...f.bind("accrualDaysPerYear")} /></Field>
            <Field label={L("الرصيد السالب", "Negative balance")}><Select className="hr-select" {...f.bind("allowNegative")}><option value="0">{L("غير مسموح", "Not allowed")}</option><option value="1">{L("مسموح", "Allowed")}</option></Select></Field>
          </>
        ) : null}
        <Field label={L("سبب الطلب *", "Reason for the request *")} wide><textarea className="hr-textarea" maxLength={300} {...f.bind("reason")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("يُضاف النوع عند اعتماد الطلب من مسؤول سياسات آخر (من إعدادات الموارد البشرية). يُحفظ «مقترحًا» حتى تعتمد الإدارة الاستحقاق.", "The type is added once another policy manager approves the request (in HR settings). It is saved as proposed until management approves the accrual.")}</p>
    </Dialog>
  );
}
