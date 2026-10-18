"use client";
import { useCreateRequest } from "@/components/shell/page-context";
import { Plus } from "lucide-react";
import { useSearchParams } from "next/navigation";
// HR-04 · Leave (Figma 1JbZgpMqmPkUVne8ms9Ozz · 452:5848). Requests with a split preview
// showing the person's balance ledger; balances per person; leave types. The server refuses
// self-approval — rows the caller filed or that are about the caller carry «طلبك · لغيرك».
import { useCallback, useMemo, useState } from "react";
import {
  Btn, Empty, ErrorState, Flag, LoadingTable, NoPermission, Notice, PageHeader, ProposalTag, REQUEST_STATUS, StatusDot, Tabs,
  days, hrFetch, useAction, useCan, useHr, useHrI18n, useHrMeta,
} from "@/components/hr/ui";
import { leaveTypeName } from "@/lib/i18n/hr";
import {
  AccrualDialog, LedgerEntryDialog, LedgerTable, LeaveTypeDialog, NoteDialog, RequestLeaveDialog, RequestPreview,
  type Balance, type LeaveRow, type LeaveTypeFull,
} from "./parts";

type View = "mine" | "all" | "balances" | "types";
type Modal =
  | { kind: "request"; employeeId?: string } | { kind: "ledger"; employeeId?: string } | { kind: "accrue" } | { kind: "type" }
  | { kind: "reject"; row: LeaveRow } | { kind: "cancel"; row: LeaveRow };

export default function LeavePage() {
  const can = useCan();
  const { meta, reload: reloadMeta } = useHrMeta();
  const allowed = !meta || can("leave_manage") || can("leave_approve");
  const [view, setView] = useState<View | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Deep link from the directory preview (A-10): /dashboard/hr/leave?request=<employeeId>.
  const search = useSearchParams();
  const [modal, setModal] = useState<Modal | null>(() => { const e = search.get("request"); return e ? { kind: "request", employeeId: e } : null; });
  // «جديد» from the shell (A-3): `?new=1` opens the same form as «تسجيل إجازة».
  useCreateRequest("request", () => setModal({ kind: "request" }), can("leave_manage"));
  useCreateRequest("ledger", () => setModal({ kind: "ledger" }), can("leave_manage"));
  const [version, setVersion] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const a = useAction();
  const { L, t, lang } = useHrI18n();

  const mine = useHr<LeaveRow[]>(meta && allowed ? `/api/hr/leave/requests?view=mine&v=${version}` : null);
  const all = useHr<LeaveRow[]>(meta && allowed ? `/api/hr/leave/requests?view=all&v=${version}` : null);

  const close = useCallback(() => setModal(null), []);
  const closePreview = useCallback(() => setSelected(null), []);
  const changed = useCallback(() => {
    setModal(null);
    setVersion((v) => v + 1);
  }, []);

  // The person pickers: the directory list when the caller has it, plus anyone already on a request.
  const people = useMemo(() => {
    const m = new Map<string, { id: string; fullNameAr: string; employeeNo: string }>();
    for (const p of meta?.people ?? []) m.set(p.id, p);
    for (const r of all.data ?? []) if (!m.has(r.employee.id)) m.set(r.employee.id, r.employee);
    return [...m.values()].sort((x, y) => x.employeeNo.localeCompare(y.employeeNo));
  }, [meta, all.data]);

  if (!allowed) return <div className="hr-page"><NoPermission duty={L("الإجازات", "Leave")} /></div>;

  const current: View = view ?? (can("leave_approve") || !meta ? "mine" : "all");
  const list = current === "mine" ? mine : all;
  const row = selected ? (all.data?.find((r) => r.id === selected) ?? mine.data?.find((r) => r.id === selected) ?? null) : null;
  const showPreview = !!row && (current === "mine" || current === "all");

  const approve = (r: LeaveRow) => a.run(`ap:${r.id}`, async () => {
    await hrFetch(`/api/hr/leave/requests/${r.id}/decide`, { json: { decision: "APPROVE" } });
    setDone(L(`اعتُمدت إجازة ${r.employee.fullNameAr}.`, `Leave for ${r.employee.fullNameAr} approved.`));
    changed();
  });

  return (
    <div className={`hr-split${showPreview ? " has-preview" : ""}`}>
      <div className="hr-page">
        <PageHeader
          title={L("الإجازات", "Leave")}
          actions={
            <>
              {can("leave_manage") ? <Btn variant="ghost" onClick={() => setModal({ kind: "accrue" })}>{L("استحقاق الشهر", "Monthly accrual")}</Btn> : null}
              {can("leave_manage") ? <Btn onClick={() => setModal({ kind: "ledger" })}><Plus aria-hidden="true" /> {L("منحة / رصيد افتتاحي", "Grant / opening balance")}</Btn> : null}
              {can("leave_manage") ? <Btn variant="primary" onClick={() => setModal({ kind: "request" })}><Plus aria-hidden="true" /> {L("تسجيل إجازة", "Record leave")}</Btn> : null}
            </>
          }
        />
        <Tabs
          label={L("عروض الإجازات", "Leave views")}
          value={current}
          onChange={(k) => { setView(k); setSelected(null); }}
          items={[
            ...(can("leave_approve") ? [{ key: "mine" as View, label: L("بانتظار قراري", "Awaiting my decision"), count: mine.data?.length }] : []),
            { key: "all", label: L("كل الطلبات", "All requests"), count: all.data?.length },
            { key: "balances", label: L("الأرصدة", "Balances"), count: people.length || undefined },
            { key: "types", label: L("أنواع الإجازات", "Leave types"), count: meta?.leaveTypes.length },
          ]}
        />
        {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
        {done ? <Notice tone="success">{done}</Notice> : null}

        {current === "mine" || current === "all" ? (
          <>
            {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
            {list.loading && !list.data ? <LoadingTable /> : null}
            {list.data && list.data.length === 0 ? (
              current === "mine"
                ? <Empty title={L("لا طلبات بانتظار قرارك", "No requests awaiting your decision")} body={L("الطلبات التي قدّمتها أو التي عنك لا تظهر هنا؛ يعتمدها معتمد آخر.", "Requests you filed or that are about you are not shown here; another approver decides them.")} />
                : <Empty title={L("لا توجد طلبات إجازة", "No leave requests")} body={L("سجّل إجازة لموظف، أو ينتظر الطلبات من الخدمة الذاتية.", "Record leave for an employee, or wait for requests from self-service.")} action={can("leave_manage") ? <Btn variant="primary" onClick={() => setModal({ kind: "request" })}>{L("تسجيل إجازة", "Record leave")}</Btn> : undefined} />
            ) : null}
            {list.data && list.data.length > 0 ? (
              <>
                <div className="hr-tablewrap">
                  <table className="hr-table is-mrow" aria-label={L("طلبات الإجازة", "Leave requests")}>
                    <thead>
                      <tr><th>{L("الموظف", "Employee")}</th><th>{L("النوع", "Type")}</th><th className="num">{L("من", "From")}</th><th className="num">{L("إلى", "To")}</th><th className="num">{L("أيام", "Days")}</th><th>{L("الحالة", "Status")}</th><th aria-label={L("إجراءات", "Actions")} /></tr>
                    </thead>
                    <tbody>
                      {list.data.map((r) => {
                        const decidable = r.status === "PENDING" && !r.isMine && can("leave_approve");
                        return (
                          <tr key={r.id} className="is-clickable" aria-selected={selected === r.id} tabIndex={0} onClick={() => setSelected(r.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), setSelected(r.id))}>
                            <td data-label={L("الموظف", "Employee")} className="strong m-title hr-wrap-en"><span className="hr-nowrap">{r.employee.fullNameAr}</span><span className="sub hr-id hr-hide-mobile">{r.employee.employeeNo}</span><span className="hr-msub">{leaveTypeName(r.leaveType, lang)}{r.leaveType.paid ? null : L(" (بدون راتب)", " (unpaid)")} · <span className="hr-num">{r.startDate}</span>{r.endDate !== r.startDate ? <> → <span className="hr-num">{r.endDate}</span></> : null} · <span className="hr-num">{days(r.days)}</span> {L("يوم", "days")} · <span className="hr-id">{r.employee.employeeNo}</span></span></td>
                            <td data-label={t("type")}>{leaveTypeName(r.leaveType, lang)}{r.leaveType.paid ? null : <span className="sub">{L("بدون راتب", "Unpaid")}</span>}</td>
                            <td data-label={L("من", "From")} className="num">{r.startDate}</td>
                            <td data-label={L("إلى", "To")} className="num">{r.endDate}</td>
                            <td data-label={L("أيام", "Days")} className="num">{days(r.days)}</td>
                            <td data-label={L("الحالة", "Status")} className="m-end">{r.status === "PENDING" && r.isMine ? <Flag>{L("طلبك · لغيرك", "Your own request")}</Flag> : <StatusDot map={REQUEST_STATUS} value={r.status} />}</td>
                            <td data-label="">
                              {decidable ? (
                                <span style={{ display: "inline-flex", gap: 6 }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                                  <Btn size="sm" busy={a.busy === `ap:${r.id}`} onClick={() => approve(r)}>{L("اعتماد", "Approve")}</Btn>
                                  <Btn size="sm" variant="ghost" onClick={() => setModal({ kind: "reject", row: r })}>{L("رفض", "Reject")}</Btn>
                                </span>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="hr-caption hr-mobile-only" style={{ margin: 0 }}>{L("اضغط الطلب لفتحه: الأيام والرصيد قبل وبعد وسجل الرصيد، ثم «اعتماد» أو «رفض».", "Tap a request to open it: days, balance before and after and the ledger, then Approve or Reject.")}</p>
                <p className="hr-caption" style={{ margin: 0 }}>{L("«طلبك · لغيرك»: لا يستطيع مقدّم الطلب اعتماد طلبه ولا طلب إجازة لنفسه؛ يظهر لمعتمد آخر فقط. الرصيد لا يسمح بالسالب إلا لنوع إجازة يسمح بذلك صراحة.", "“Your own request”: whoever filed a request cannot approve it, nor their own leave; it is shown to another approver only. The balance cannot go negative unless the leave type explicitly allows it.")}</p>
              </>
            ) : null}
          </>
        ) : null}

        {current === "balances" ? <BalancesTab people={people} version={version} onGrant={(employeeId) => setModal({ kind: "ledger", employeeId })} /> : null}
        {current === "types" ? <TypesTab version={version} onCreate={() => setModal({ kind: "type" })} /> : null}
      </div>

      {showPreview && row ? (
        <>
          <div className="hr-scrim" onClick={closePreview} />
          <RequestPreview
            key={row.id}
            row={row}
            version={version}
            onClose={closePreview}
            onChanged={() => { setDone(null); changed(); }}
            onReject={(r) => setModal({ kind: "reject", row: r })}
            onCancel={(r) => setModal({ kind: "cancel", row: r })}
          />
        </>
      ) : null}

      {modal?.kind === "request" ? <RequestLeaveDialog people={people} initialEmployeeId={modal.employeeId} onClose={close} onDone={() => { setDone(L("سُجّلت الإجازة وهي بانتظار اعتماد معتمد آخر.", "Leave recorded; it is awaiting another approver.")); changed(); }} /> : null}
      {modal?.kind === "ledger" ? <LedgerEntryDialog people={people} initialEmployeeId={modal.employeeId} onClose={close} onDone={() => { setDone(L("أُضيفت الحركة إلى سجل الرصيد.", "Entry added to the balance ledger.")); changed(); }} /> : null}
      {modal?.kind === "accrue" ? <AccrualDialog onClose={close} onDone={(n, m) => { setDone(n ? L(`أُضيفت ${n} حركة استحقاق لشهر ${m}.`, `${n} accrual entries added for ${m}.`) : L(`استحقاق ${m} مسجّل من قبل؛ لم يُضف شيء.`, `The accrual for ${m} is already recorded; nothing was added.`)); changed(); }} /> : null}
      {modal?.kind === "type" ? <LeaveTypeDialog onClose={close} onDone={() => { setDone(L("أُرسل طلب نوع الإجازة للاعتماد؛ يُضاف عند اعتماده من مسؤول سياسات آخر.", "The leave type request was sent for approval; it is added once another policy manager approves it.")); reloadMeta(); changed(); }} /> : null}
      {modal?.kind === "reject" ? (
        <NoteDialog
          title={L(`رفض إجازة ${modal.row.employee.fullNameAr}`, `Reject leave for ${modal.row.employee.fullNameAr}`)} label={L("سبب الرفض", "Reason for rejection")} help={L("يظهر للموظف. مطلوب للرفض.", "Shown to the employee. Required to reject.")} required confirm={L("رفض", "Reject")} danger onClose={close}
          onSubmit={async (note) => { await hrFetch(`/api/hr/leave/requests/${modal.row.id}/decide`, { json: { decision: "REJECT", note } }); setDone(L("رُفض الطلب.", "Request rejected.")); changed(); }}
        />
      ) : null}
      {modal?.kind === "cancel" ? (
        <NoteDialog
          title={L(`إلغاء إجازة ${modal.row.employee.fullNameAr} المعتمدة`, `Cancel approved leave for ${modal.row.employee.fullNameAr}`)} label={L("سبب الإلغاء", "Reason for cancelling")} help={L("تعود الأيام إلى الرصيد بحركة عكسية؛ لا يُحذف شيء. لا يُلغى ما دخل مسيرًا معتمدًا أو مصروفًا.", "The days return to the balance through a reversing entry; nothing is deleted. Leave in an approved or paid payroll run cannot be cancelled.")} required confirm={L("إلغاء الإجازة", "Cancel leave")} danger onClose={close}
          onSubmit={async (reason) => { await hrFetch(`/api/hr/leave/requests/${modal.row.id}/cancel`, { json: { reason } }); setDone(L("أُلغيت الإجازة وأُضيفت حركة عكسية للرصيد.", "Leave cancelled and a reversing balance entry added.")); changed(); }}
        />
      ) : null}
    </div>
  );
}

function BalancesTab({ people, version, onGrant }: { people: { id: string; fullNameAr: string; employeeNo: string }[]; version: number; onGrant: (employeeId: string) => void }) {
  const can = useCan();
  const [personId, setPersonId] = useState("");
  const [typeId, setTypeId] = useState<string | null>(null);
  const { data, error, loading, reload } = useHr<Balance[]>(personId ? `/api/hr/employees/${personId}/leave?v=${version}` : null);
  const shown = data?.find((b) => b.leaveTypeId === typeId && b.tracksBalance);
  const { L, lang } = useHrI18n();
  return (
    <>
      <div className="hr-filterbar">
        <label className="hr-chip">{L("الموظف:", "Employee:")}
          <select value={personId} onChange={(e) => { setPersonId(e.target.value); setTypeId(null); }} aria-label={L("الموظف", "Employee")}>
            <option value="">{L("اختر موظفًا", "Choose an employee")}</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.fullNameAr} · {p.employeeNo}</option>)}
          </select>
        </label>
        {personId && can("leave_manage") ? <Btn size="sm" onClick={() => onGrant(personId)}><Plus aria-hidden="true" /> {L("منحة / رصيد افتتاحي", "Grant / opening balance")}</Btn> : null}
      </div>
      {!personId ? <Empty title={L("اختر موظفًا لعرض أرصدته", "Choose an employee to see their balances")} body={L("الرصيد مجموع حركات السجل، والمحجوز أيام الطلبات التي تنتظر القرار، والمتاح الفرق بينهما.", "The balance is the sum of ledger entries, reserved is the days of requests awaiting a decision, and available is the difference.")} /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {loading && !data ? <LoadingTable rows={4} /> : null}
      {personId && data && data.length === 0 ? <Empty title={L("لا توجد أنواع إجازات فعّالة", "No active leave types")} /> : null}
      {personId && data && data.length > 0 ? (
        <div className="hr-tablewrap">
          <table className="hr-table is-stack" aria-label={L("أرصدة الإجازات", "Leave balances")}>
            <thead><tr><th>{L("النوع", "Type")}</th><th className="num">{L("الرصيد", "Balance")}</th><th className="num">{L("المحجوز للطلبات", "Reserved for requests")}</th><th className="num">{L("المتاح", "Available")}</th><th /></tr></thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.leaveTypeId} className={b.tracksBalance ? "is-clickable" : undefined} aria-selected={typeId === b.leaveTypeId} tabIndex={b.tracksBalance ? 0 : undefined}
                  onClick={() => b.tracksBalance && setTypeId(b.leaveTypeId)} onKeyDown={(e) => b.tracksBalance && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setTypeId(b.leaveTypeId))}>
                  <td data-label={L("النوع", "Type")} className="strong">{leaveTypeName(b, lang)}{b.paid ? null : <span className="sub">{L("بدون راتب", "Unpaid")}</span>}</td>
                  {b.tracksBalance ? (
                    <>
                      <td data-label={L("الرصيد", "Balance")} className="num">{days(b.balance)}</td>
                      <td data-label={L("المحجوز للطلبات", "Reserved for requests")} className="num">{days(b.pending)}</td>
                      <td data-label={L("المتاح", "Available")} className="num" style={Number(b.available) < 0 ? { color: "var(--hr-danger)" } : undefined}>{days(b.available)}</td>
                    </>
                  ) : (
                    <td data-label={L("الرصيد", "Balance")} colSpan={3} className="hr-muted">{L("لا يُخصم من رصيد", "Not deducted from a balance")}</td>
                  )}
                  <td data-label="">{b.isProposal ? <ProposalTag /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {personId && shown ? (
        <div className="hr-stack">
          <span className="hr-section">{L(`سجل رصيد ${shown.nameAr}`, `${leaveTypeName(shown, lang)} balance ledger`)}</span>
          <LedgerTable employeeId={personId} leaveTypeId={shown.leaveTypeId} reloadKey={version} />
          <p className="hr-caption" style={{ margin: 0 }}>{L("الرصيد يشمل الإجازات المعتمدة مستقبلًا، فلا يمكن حجز الأيام نفسها مرتين. الإلغاء بعد الاعتماد يضيف حركة عكسية ولا يحذف شيئًا.", "The balance includes approved future leave, so the same days cannot be reserved twice. Cancelling after approval adds a reversing entry and deletes nothing.")}</p>
        </div>
      ) : personId && data?.some((b) => b.tracksBalance) ? <p className="hr-caption" style={{ margin: 0 }}>{L("اختر نوعًا لعرض سجل حركاته.", "Choose a type to see its ledger.")}</p> : null}
    </>
  );
}

function TypesTab({ version, onCreate }: { version: number; onCreate: () => void }) {
  const can = useCan();
  const { data, error, loading, reload } = useHr<LeaveTypeFull[]>(`/api/hr/leave/types?v=${version}`);
  const { L, lang } = useHrI18n();
  return (
    <>
      {can("policy_manage") ? <div className="hr-filterbar"><Btn size="sm" onClick={onCreate}>{L("+ نوع إجازة", "+ Leave type")}</Btn></div> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {loading && !data ? <LoadingTable rows={4} /> : null}
      {data && data.length === 0 ? <Empty title={L("لا توجد أنواع إجازات", "No leave types")} body={L("يضيفها من يملك صلاحية «السياسات».", "Added by users with the “Policies” permission.")} /> : null}
      {data && data.length > 0 ? (
        <div className="hr-tablewrap">
          <table className="hr-table is-stack" aria-label={L("أنواع الإجازات", "Leave types")}>
            <thead><tr><th>{L("الرمز", "Code")}</th><th>{L("النوع", "Type")}</th><th>{L("الراتب", "Pay")}</th><th>{L("الرصيد", "Balance")}</th><th className="num">{L("الاستحقاق السنوي", "Annual accrual")}</th><th>{L("السالب", "Negative")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
            <tbody>
              {data.map((lt) => (
                <tr key={lt.id}>
                  <td data-label={L("الرمز", "Code")}><span className="hr-id">{lt.code}</span></td>
                  <td data-label={L("النوع", "Type")} className="strong">{leaveTypeName(lt, lang)}</td>
                  <td data-label={L("الراتب", "Pay")}>{lt.paid ? L("مدفوعة", "Paid") : L("بدون راتب", "Unpaid")}</td>
                  <td data-label={L("الرصيد", "Balance")}>{lt.tracksBalance ? L("تُخصم من رصيد", "Deducted from a balance") : L("بلا رصيد", "No balance")}</td>
                  <td data-label={L("الاستحقاق السنوي", "Annual accrual")} className="num">
                    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                      {lt.isProposal ? <ProposalTag /> : null}
                      {lt.tracksBalance && lt.accrualDaysPerYear !== null ? `${days(lt.accrualDaysPerYear)} ${L("يوم", "days")}` : "—"}
                    </span>
                  </td>
                  <td data-label={L("السالب", "Negative")} className="hr-muted">{lt.tracksBalance ? (lt.allowNegative ? L("مسموح", "Allowed") : L("غير مسموح", "Not allowed")) : "—"}</td>
                  <td data-label={L("الحالة", "Status")}><StatusDot map={{ A: ["فعّال", "success", "Active"], I: ["موقوف", "cancelled", "Inactive"] }} value={lt.active ? "A" : "I"} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="hr-caption" style={{ margin: 0 }}>{L("«مقترح · غير معتمد»: الاستحقاق قيمة مقترحة لم تؤكدها الإدارة بعد. الاستحقاق الشهري جزء من اثني عشر من السنوي.", "“Proposed · not approved”: the accrual is a proposed value management has not confirmed yet. The monthly accrual is one twelfth of the annual.")}</p>
    </>
  );
}
