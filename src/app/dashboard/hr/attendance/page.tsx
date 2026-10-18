"use client";
// HR-05 · Attendance (Figma 1JbZgpMqmPkUVne8ms9Ozz · 452:20877). One day's board in the
// HR policy's time zone, the pending corrections and overtime queues, and shifts. Instants
// are stored in UTC; the server converts them to branch wall-clock times for display.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Btn, Empty, ErrorState, Flag, LoadingTable, NoPermission, Notice, PageHeader, StatusDot, Tabs,
  hrFetch, todayIso, useAction, useCan, useHr, useHrI18n, useHrMeta, type StatusEntry,
} from "@/components/hr/ui";
import { WEEKDAYS, leaveTypeName } from "@/lib/i18n/hr";
import { CorrectionDialog, ManualDayDialog, NoteDialog, OvertimeDialog, ShiftDialog, type Person } from "./parts";

type BoardRow = {
  employee: { id: string; employeeNo: string; fullNameAr: string };
  shift: { name: string; startTime: string; endTime: string } | null;
  attendance: { checkIn: string | null; checkOut: string | null; lateMinutes: number | null; workedMinutes: number | null; overtimeMinutes: number | null; source: string; status: string; notes: string | null } | null;
  overtimeStatus: string | null;
  leave: { nameAr: string; paid: boolean } | null;
};
type OvertimeRow = { id: string; employeeId: string; employeeName: string; workDate: string; minutes: number; source: string; isMine: boolean };
type CorrectionRow = { id: string; employeeId: string; employeeName: string; workDate: string; checkIn: string | null; checkOut: string | null; reason: string; isMine: boolean };
type Board = { day: string; timezone: string; rows: BoardRow[]; overtime: OvertimeRow[]; corrections: CorrectionRow[] };
type Shift = { id: string; code: string; name: string; startTime: string; endTime: string; breakMinutes: number; graceMinutes: number; active: boolean };
type View = "today" | "corrections" | "overtime" | "shifts";
type Modal =
  | { kind: "manual"; employeeId?: string } | { kind: "correction" } | { kind: "overtime" } | { kind: "shift" }
  | { kind: "rejectOt"; row: OvertimeRow } | { kind: "rejectCorr"; row: CorrectionRow };

const SOURCE: Record<string, [string, string]> = { DEVICE: ["جهاز الحضور", "Attendance device"], SELF: ["الخدمة الذاتية", "Self-service"], MANUAL: ["يدوي", "Manual"], CORRECTION: ["تصحيح معتمد", "Approved correction"], ATTENDANCE: ["من الحضور", "From attendance"] };
const source = (s: string, en: boolean) => (SOURCE[s] ? SOURCE[s][en ? 1 : 0] : s);
const DAY_STATUS: Record<string, StatusEntry> = {
  CLOSED: ["مكتمل", "success", "Complete"], OPEN: ["لم ينصرف بعد", "info", "Not checked out yet"], OT: ["إضافي بانتظار", "warning", "Overtime pending"], NONE: ["لا سجل", "neutral", "No record"], OFF: ["لا وردية", "neutral", "No shift"],
};
const hm = (m: number | null | undefined) => (m === null || m === undefined ? "—" : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`);
const weekdayOf = (iso: string, lang: "ar" | "en") => WEEKDAYS[lang][new Date(`${iso}T00:00:00Z`).getUTCDay()];

/** «آسيا/الرياض (UTC+03:00)» style label for an IANA zone, computed by the browser. */
function zoneLabel(tz: string) {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
    const off = part.replace("GMT", "") || "+00:00";
    return `${tz} (UTC${off})`;
  } catch {
    return tz;
  }
}

export default function AttendancePage() {
  const can = useCan();
  const { meta, reload: reloadMeta } = useHrMeta();
  const allowed = !meta || can("attendance_manage") || can("attendance_approve");
  const [view, setView] = useState<View>("today");
  const [day, setDay] = useState("");
  const [version, setVersion] = useState(0);
  const [modal, setModal] = useState<Modal | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const a = useAction();
  const { L, lang } = useHrI18n();
  const url = useMemo(() => {
    const p = new URLSearchParams({ v: String(version) });
    if (day) p.set("day", day);
    return `/api/hr/attendance/board?${p}`;
  }, [day, version]);
  const { data, error, loading, reload } = useHr<Board>(meta && allowed ? url : null);

  const close = useCallback(() => setModal(null), []);
  const changed = useCallback(() => {
    setModal(null);
    setVersion((v) => v + 1);
  }, []);
  const people: Person[] = useMemo(() => {
    const m = new Map<string, Person>();
    for (const r of data?.rows ?? []) m.set(r.employee.id, r.employee);
    for (const p of meta?.people ?? []) if (!m.has(p.id)) m.set(p.id, p);
    return [...m.values()].sort((x, y) => x.employeeNo.localeCompare(y.employeeNo));
  }, [data, meta]);

  if (!allowed) return <div className="hr-page"><NoPermission duty={L("الحضور", "Attendance")} /></div>;

  // Before (or without) a board response the control still shows a real day, not «mm/dd/yyyy».
  const shownDay = day || data?.day || todayIso();
  const nCorr = data?.corrections.length;
  const nOt = data?.overtime.length;

  const decideOt = (r: OvertimeRow) => a.run(`ot:${r.id}`, async () => {
    await hrFetch(`/api/hr/attendance/overtime/${r.id}/decide`, { json: { decision: "APPROVE" } });
    setDone(L(`اعتُمد إضافي ${r.employeeName}.`, `Overtime for ${r.employeeName} approved.`));
    changed();
  });
  const decideCorr = (r: CorrectionRow) => a.run(`co:${r.id}`, async () => {
    await hrFetch(`/api/hr/attendance/corrections/${r.id}/decide`, { json: { decision: "APPROVE" } });
    setDone(L(`اعتُمد تصحيح ${r.employeeName}.`, `Correction for ${r.employeeName} approved.`));
    changed();
  });

  const corrections = data ? (
    <CorrectionsTable rows={data.corrections} busy={a.busy} onApprove={decideCorr} onReject={(row) => setModal({ kind: "rejectCorr", row })} />
  ) : null;
  const overtime = data ? (
    <OvertimeTable rows={data.overtime} busy={a.busy} onApprove={decideOt} onReject={(row) => setModal({ kind: "rejectOt", row })} />
  ) : null;

  return (
    <div className="hr-page is-tight-mobile">
      <PageHeader
        title={L("الحضور", "Attendance")}
        actions={can("attendance_manage") ? <Btn onClick={() => setModal({ kind: "manual" })}>{L("+ تسجيل يدوي", "+ Manual entry")}</Btn> : null}
      >
        <label className="hr-chip">{L("اليوم:", "Date:")}
          <input type="date" value={shownDay} onChange={(e) => setDay(e.target.value)} aria-label={L("اليوم", "Date")} style={{ border: 0, background: "transparent", font: "inherit", fontWeight: 600, color: "var(--hr-text)" }} className="hr-num" />
          {shownDay ? <span className="hr-muted">{weekdayOf(shownDay, lang)}</span> : null}
          {day ? <button type="button" className="hr-btn is-ghost is-sm" style={{ height: 22, padding: "0 4px" }} aria-label={L("العودة إلى اليوم", "Back to today")} onClick={() => setDay("")}>✕</button> : null}
        </label>
        <span className="hr-caption">{L("التوقيت:", "Time zone:")} <span className="hr-iso" dir="ltr">{zoneLabel(data?.timezone ?? meta?.policy?.timezone ?? "Asia/Riyadh")}</span><span className="hr-desktop-only">{L(" · الأوقات تُحفظ بتوقيت UTC وتُعرض بتوقيت الفرع", " · times are stored in UTC and shown in branch time")}</span></span>
      </PageHeader>
      <Tabs
        label={L("عروض الحضور", "Attendance views")}
        value={view}
        onChange={setView}
        items={[
          { key: "today", label: L("اليوم", "Today"), count: data?.rows.length },
          { key: "corrections", label: L("طلبات التصحيح", "Correction requests"), count: nCorr, danger: !!nCorr },
          { key: "overtime", label: L("إضافي بانتظار الاعتماد", "Overtime awaiting approval"), count: nOt },
          { key: "shifts", label: L("الورديات", "Shifts"), count: meta?.shifts.length },
        ]}
      />
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}

      {view !== "shifts" ? (
        <>
          {error ? <ErrorState error={error} onRetry={reload} /> : null}
          {loading && !data ? <LoadingTable /> : null}
        </>
      ) : null}

      {view === "today" && data ? (
        <>
          {data.rows.length === 0 ? <Empty title={L("لا يوجد موظفون في نطاقك لهذا اليوم", "No employees in your scope for this day")} body={L("يظهر هنا من باشر العمل قبل هذا اليوم ولم تنته خدمته.", "Shown here: everyone who started before this day and whose service has not ended.")} /> : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={L("حضور اليوم", "Attendance for the day")}>
                <thead>
                  <tr><th>{L("الموظف", "Employee")}</th><th>{L("الوردية", "Shift")}</th><th className="num">{L("حضور", "Check-in")}</th><th className="num">{L("انصراف", "Check-out")}</th><th className="num">{L("تأخير د", "Late (min)")}</th><th className="num">{L("ساعات", "Hours")}</th><th className="num">{L("إضافي", "Overtime")}</th><th className="hr-hide-compact">{L("المصدر", "Source")}</th><th>{L("الحالة", "Status")}</th></tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => <DayRow key={r.employee.id} r={r} canManage={can("attendance_manage")} onManual={() => setModal({ kind: "manual", employeeId: r.employee.id })} />)}
                </tbody>
              </table>
            </div>
          )}
          <div className="hr-cols-2">
            <section className="hr-stack" aria-label={L("طلبات التصحيح", "Correction requests")}>
              <h2 className="hr-section">{L("طلبات التصحيح", "Correction requests")}</h2>
              {corrections}
            </section>
            <section className="hr-stack" aria-label={L("إضافي بانتظار الاعتماد", "Overtime awaiting approval")}>
              <h2 className="hr-section">{L("إضافي بانتظار الاعتماد", "Overtime awaiting approval")}</h2>
              {overtime}
            </section>
          </div>
        </>
      ) : null}

      {view === "corrections" && data ? (
        <>
          {can("attendance_manage") ? <div className="hr-filterbar"><Btn size="sm" onClick={() => setModal({ kind: "correction" })}>{L("+ طلب تصحيح", "+ Request correction")}</Btn></div> : null}
          {corrections}
        </>
      ) : null}
      {view === "overtime" && data ? (
        <>
          {can("attendance_manage") ? <div className="hr-filterbar"><Btn size="sm" onClick={() => setModal({ kind: "overtime" })}>{L("+ إضافي يدوي", "+ Manual overtime")}</Btn></div> : null}
          {overtime}
        </>
      ) : null}
      {view === "shifts" ? <ShiftsTab version={version} onCreate={() => setModal({ kind: "shift" })} /> : null}

      {modal?.kind === "manual" ? <ManualDayDialog people={people} day={shownDay} initialEmployeeId={modal.employeeId} onClose={close} onDone={() => { setDone(L("سُجّل اليوم.", "Day recorded.")); changed(); }} /> : null}
      {modal?.kind === "correction" ? <CorrectionDialog people={people} day={shownDay} onClose={close} onDone={() => { setDone(L("أُرسل طلب التصحيح لمعتمد آخر.", "Correction request sent to another approver.")); changed(); }} /> : null}
      {modal?.kind === "overtime" ? <OvertimeDialog people={people} day={shownDay} onClose={close} onDone={() => { setDone(L("أُرسل الإضافي للاعتماد.", "Overtime sent for approval.")); changed(); }} /> : null}
      {modal?.kind === "shift" ? <ShiftDialog onClose={close} onDone={() => { setDone(L("أُضيفت الوردية.", "Shift added.")); reloadMeta(); changed(); }} /> : null}
      {modal?.kind === "rejectOt" ? (
        <NoteDialog title={L(`رفض إضافي ${modal.row.employeeName}`, `Reject overtime for ${modal.row.employeeName}`)} label={L("سبب الرفض", "Reason for rejection")} confirm={L("رفض", "Reject")} onClose={close}
          onSubmit={async (note) => { await hrFetch(`/api/hr/attendance/overtime/${modal.row.id}/decide`, { json: { decision: "REJECT", note: note || undefined } }); setDone(L("رُفض الإضافي.", "Overtime rejected.")); changed(); }} />
      ) : null}
      {modal?.kind === "rejectCorr" ? (
        <NoteDialog title={L(`رفض تصحيح ${modal.row.employeeName}`, `Reject correction for ${modal.row.employeeName}`)} label={L("سبب الرفض", "Reason for rejection")} help={L("مطلوب للرفض.", "Required to reject.")} required confirm={L("رفض", "Reject")} onClose={close}
          onSubmit={async (note) => { await hrFetch(`/api/hr/attendance/corrections/${modal.row.id}/decide`, { json: { decision: "REJECT", note } }); setDone(L("رُفض التصحيح.", "Correction rejected.")); changed(); }} />
      ) : null}
    </div>
  );
}

function DayRow({ r, canManage, onManual }: { r: BoardRow; canManage: boolean; onManual: () => void }) {
  const at = r.attendance;
  const { L, lang } = useHrI18n();
  let status: ReactNode;
  if (at?.status === "ABSENT") status = <Flag tone="danger">{L("غياب", "Absent")}</Flag>;
  else if (r.leave && !at) status = <StatusDot map={{ L: [`إجازة${r.leave.paid ? "" : " بدون راتب"} · ${r.leave.nameAr}`, "cancelled", `${r.leave.paid ? "Leave" : "Unpaid leave"} · ${leaveTypeName(r.leave, lang)}`] }} value="L" />;
  else if (at && r.overtimeStatus === "PENDING") status = <StatusDot map={DAY_STATUS} value="OT" />;
  else if (at) status = <StatusDot map={DAY_STATUS} value={at.status} />;
  else status = (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <StatusDot map={DAY_STATUS} value={r.shift ? "NONE" : "OFF"} />
      {canManage ? <Btn size="sm" variant="ghost" onClick={onManual}>{L("تسجيل", "Record")}</Btn> : null}
    </span>
  );
  const ot = at?.overtimeMinutes ?? 0;
  return (
    <tr>
      <td data-label={L("الموظف", "Employee")} className="strong m-title">{r.employee.fullNameAr}<span className="hr-msub">{r.shift ? <>{r.shift.name} <span className="hr-num">{r.shift.startTime}–{r.shift.endTime}</span></> : L("بلا وردية", "No shift")}{at?.checkIn ? <> · <span className="hr-num">{at.checkIn}</span> → <span className="hr-num">{at.checkOut ?? "—"}</span></> : null}{at?.lateMinutes ? <> · <span style={{ color: "var(--hr-warning)" }}>{L("تأخير", "Late")} <span className="hr-num">{at.lateMinutes}</span> {L("د", "min")}</span></> : null}</span></td>
      <td data-label={L("الوردية", "Shift")}>{r.shift ? <>{r.shift.name} <span className="hr-num hr-muted">{r.shift.startTime}–{r.shift.endTime}</span></> : <span className="hr-muted">—</span>}</td>
      <td data-label={L("حضور", "Check-in")} className="num">{at?.checkIn ?? "—"}</td>
      <td data-label={L("انصراف", "Check-out")} className="num">{at?.checkOut ?? "—"}</td>
      <td data-label={L("تأخير د", "Late (min)")} className="num" style={at?.lateMinutes ? { color: "var(--hr-warning)" } : undefined}>{at?.lateMinutes ?? (at?.checkIn ? 0 : "—")}</td>
      <td data-label={L("ساعات", "Hours")} className="num">{hm(at?.workedMinutes)}</td>
      <td data-label={L("إضافي", "Overtime")} className="num" style={ot && r.overtimeStatus === "PENDING" ? { color: "var(--hr-warning)" } : undefined}>{ot ? hm(ot) : "—"}</td>
      <td data-label={L("المصدر", "Source")} className="hr-hide-compact hr-muted">{at ? source(at.source, lang === "en") : "—"}</td>
      <td data-label={L("الحالة", "Status")} className="m-end is-stack"><span className="hr-mobile-only hr-num strong">{at?.workedMinutes ? hm(at.workedMinutes) : "—"}</span>{status}</td>
    </tr>
  );
}

function Decide({ isMine, busy, onApprove, onReject }: { isMine: boolean; busy: boolean; onApprove: () => void; onReject: () => void }) {
  const can = useCan();
  const { L } = useHrI18n();
  if (isMine) return <Flag>{L("طلبك · لغيرك", "Your own request")}</Flag>;
  if (!can("attendance_approve")) return null;
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      <Btn size="sm" busy={busy} onClick={onApprove}>{L("اعتماد", "Approve")}</Btn>
      <Btn size="sm" variant="ghost" onClick={onReject}>{L("رفض", "Reject")}</Btn>
    </span>
  );
}

function CorrectionsTable({ rows, busy, onApprove, onReject }: { rows: CorrectionRow[]; busy: string | null; onApprove: (r: CorrectionRow) => void; onReject: (r: CorrectionRow) => void }) {
  const { L } = useHrI18n();
  return (
    <>
      {rows.length === 0 ? <Empty title={L("لا طلبات تصحيح بانتظار القرار", "No correction requests awaiting a decision")} /> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("طلبات التصحيح", "Correction requests")}>
            <thead><tr><th>{L("الموظف", "Employee")}</th><th className="num">{L("اليوم", "Date")}</th><th>{L("المطلوب", "Requested")}</th><th className="hr-hide-compact">{L("السبب", "Reason")}</th><th aria-label={L("إجراءات", "Actions")} /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label={L("الموظف", "Employee")} className="strong m-title">{r.employeeName}<span className="hr-msub"><span className="hr-num">{r.workDate}</span>{r.checkIn ? <> · {L("حضور", "in")} <span className="hr-num">{r.checkIn}</span></> : null}{r.checkOut ? <> · {L("انصراف", "out")} <span className="hr-num">{r.checkOut}</span></> : null}</span></td>
                  <td data-label={L("اليوم", "Date")} className="num">{r.workDate}</td>
                  <td data-label={L("المطلوب", "Requested")}>
                    {[r.checkIn ? <span key="i">{L("حضور", "Check-in")} <span className="hr-num">{r.checkIn}</span></span> : null, r.checkOut ? <span key="o">{L("انصراف", "Check-out")} <span className="hr-num">{r.checkOut}</span></span> : null].filter(Boolean).reduce<ReactNode[]>((acc, x, i) => (i ? [...acc, " · ", x] : [x]), [])}
                  </td>
                  <td data-label={L("السبب", "Reason")} className="hr-hide-compact hr-muted">{r.reason}</td>
                  <td data-label="" className="m-end"><Decide isMine={r.isMine} busy={busy === `co:${r.id}`} onApprove={() => onApprove(r)} onReject={() => onReject(r)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hr-caption" style={{ margin: 0 }}>{L("التصحيح لا يعدّل السجل الأصلي؛ يحفظ القيم السابقة ومن اعتمدها. لا أحد يعتمد تصحيح نفسه.", "A correction does not edit the original record; it keeps the previous values and who approved it. Nobody approves their own correction.")}</p>
    </>
  );
}

function OvertimeTable({ rows, busy, onApprove, onReject }: { rows: OvertimeRow[]; busy: string | null; onApprove: (r: OvertimeRow) => void; onReject: (r: OvertimeRow) => void }) {
  const { L, lang } = useHrI18n();
  return (
    <>
      {rows.length === 0 ? <Empty title={L("لا إضافي بانتظار الاعتماد", "No overtime awaiting approval")} /> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("إضافي بانتظار الاعتماد", "Overtime awaiting approval")}>
            <thead><tr><th>{L("الموظف", "Employee")}</th><th className="num">{L("اليوم", "Date")}</th><th className="num">{L("الدقائق", "Minutes")}</th><th className="hr-hide-compact">{L("المصدر", "Source")}</th><th aria-label={L("إجراءات", "Actions")} /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label={L("الموظف", "Employee")} className="strong m-title">{r.employeeName}<span className="hr-msub"><span className="hr-num">{r.workDate}</span> · <span className="hr-num">{r.minutes}</span> {L("دقيقة", "min")}</span></td>
                  <td data-label={L("اليوم", "Date")} className="num">{r.workDate}</td>
                  <td data-label={L("الدقائق", "Minutes")} className="num">{r.minutes}</td>
                  <td data-label={L("المصدر", "Source")} className="hr-hide-compact hr-muted">{source(r.source, lang === "en")}</td>
                  <td data-label="" className="m-end"><Decide isMine={r.isMine} busy={busy === `ot:${r.id}`} onApprove={() => onApprove(r)} onReject={() => onReject(r)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hr-caption" style={{ margin: 0 }}>{L("لا يدخل المسير إلا الإضافي المعتمد. المعدّل من سياسة الرواتب.", "Only approved overtime enters payroll. The rate comes from the payroll policy.")}</p>
    </>
  );
}

function ShiftsTab({ version, onCreate }: { version: number; onCreate: () => void }) {
  const can = useCan();
  const { data, error, loading, reload } = useHr<Shift[]>(`/api/hr/attendance/shifts?v=${version}`);
  const { L } = useHrI18n();
  return (
    <>
      {can("attendance_manage") ? <div className="hr-filterbar"><Btn size="sm" onClick={onCreate}>{L("+ وردية", "+ Shift")}</Btn></div> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {loading && !data ? <LoadingTable rows={4} /> : null}
      {data && data.length === 0 ? <Empty title={L("لا توجد ورديات", "No shifts")} body={L("أنشئ وردية ثم أسندها للموظفين من ملفاتهم.", "Create a shift, then assign it to employees from their files.")} action={can("attendance_manage") ? <Btn variant="primary" onClick={onCreate}>{L("وردية جديدة", "New shift")}</Btn> : undefined} /> : null}
      {data && data.length > 0 ? (
        <div className="hr-tablewrap">
          <table className="hr-table is-stack" aria-label={L("الورديات", "Shifts")}>
            <thead><tr><th>{L("الرمز", "Code")}</th><th>{L("الوردية", "Shift")}</th><th className="num">{L("البداية", "Start")}</th><th className="num">{L("النهاية", "End")}</th><th className="num">{L("استراحة د", "Break (min)")}</th><th className="num">{L("سماح د", "Grace (min)")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}>
                  <td data-label={L("الرمز", "Code")}><span className="hr-id">{s.code}</span></td>
                  <td data-label={L("الوردية", "Shift")} className="strong">{s.name}</td>
                  <td data-label={L("البداية", "Start")} className="num">{s.startTime}</td>
                  <td data-label={L("النهاية", "End")} className="num">{s.endTime}</td>
                  <td data-label={L("استراحة د", "Break (min)")} className="num">{s.breakMinutes}</td>
                  <td data-label={L("سماح د", "Grace (min)")} className="num">{s.graceMinutes}</td>
                  <td data-label={L("الحالة", "Status")}><StatusDot map={{ A: ["فعّالة", "success", "Active"], I: ["موقوفة", "cancelled", "Inactive"] }} value={s.active ? "A" : "I"} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="hr-caption" style={{ margin: 0 }}>{L("أوقات الوردية بتوقيت الفرع. إذا تجاوز التأخير مدة السماح حُسب كاملًا. الإضافي ما زاد من ساعات العمل (بعد خصم الاستراحة) على مدة الوردية.", "Shift times are in branch time. Lateness beyond the grace period counts in full. Overtime is work time (after the break) beyond the shift length.")}</p>
    </>
  );
}
