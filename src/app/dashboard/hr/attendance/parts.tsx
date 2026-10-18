"use client";
// HR-05 · Attendance — dialogs (used by ./page.tsx).
import { useState } from "react";
import { Btn, Dialog, Field, Notice, hrFetch, useAction, useForm, useHrI18n } from "@/components/hr/ui";

export type Person = { id: string; fullNameAr: string; employeeNo: string };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function PersonSelect({ people, bind }: { people: Person[]; bind: { value: string; onChange: (e: { target: { value: string } }) => void } }) {
  return (
    <select className="hr-select" {...bind}>
      <option value="">—</option>
      {people.map((p) => <option key={p.id} value={p.id}>{p.fullNameAr} · {p.employeeNo}</option>)}
    </select>
  );
}

/** A reason/note prompt for rejecting overtime or a correction. */
export function NoteDialog({ title, label, help, required, confirm, onClose, onSubmit }: {
  title: string; label: string; help?: string; required?: boolean; confirm: string; onClose: () => void; onSubmit: (note: string) => Promise<unknown>;
}) {
  const [note, setNote] = useState("");
  const a = useAction();
  const { L } = useHrI18n();
  const ok = !required || note.trim().length >= 3;
  return (
    <Dialog open title={title} onClose={onClose} actions={<><Btn variant="danger" busy={a.busy === "go"} disabled={!ok} onClick={() => a.run("go", () => onSubmit(note.trim()))}>{confirm}</Btn><Btn onClick={onClose}>{L("تراجع", "Discard")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <Field label={required ? `${label} *` : label} help={help}>
        <textarea className="hr-textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
    </Dialog>
  );
}

export function ManualDayDialog({ people, day, initialEmployeeId, onClose, onDone }: { people: Person[]; day: string; initialEmployeeId?: string; onClose: () => void; onDone: () => void }) {
  const f = useForm({ employeeId: initialEmployeeId ?? "", workDate: day, mode: "times", checkIn: "", checkOut: "", reason: "" });
  const a = useAction();
  const { L } = useHrI18n();
  const absent = f.v.mode === "absent";
  const valid = f.v.employeeId && f.v.workDate && f.v.reason.trim().length >= 3 && (absent || (HHMM.test(f.v.checkIn) && HHMM.test(f.v.checkOut)));
  const submit = () => a.run("save", async () => {
    const base = { employeeId: f.v.employeeId, workDate: f.v.workDate, reason: f.v.reason.trim() };
    await hrFetch("/api/hr/attendance/manual", { json: absent ? { ...base, absent: true } : { ...base, checkIn: f.v.checkIn, checkOut: f.v.checkOut } });
    onDone();
  });
  return (
    <Dialog open title={L("تسجيل يدوي", "Manual entry")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} disabled={!valid} onClick={submit}>{L("تسجيل", "Record")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الموظف *", "Employee *")} wide><PersonSelect people={people} bind={f.bind("employeeId")} /></Field>
        <Field label={L("اليوم *", "Date *")}><input className="hr-input" type="date" {...f.bind("workDate")} /></Field>
        <Field label={L("التسجيل", "Entry")}><select className="hr-select" {...f.bind("mode")}><option value="times">{L("حضور وانصراف", "Check-in and check-out")}</option><option value="absent">{L("غياب", "Absent")}</option></select></Field>
        {!absent ? (
          <>
            <Field label={L("حضور *", "Check-in *")} help={L("بتوقيت الفرع", "Branch time")}><input className="hr-input hr-num" type="time" {...f.bind("checkIn")} /></Field>
            <Field label={L("انصراف *", "Check-out *")} help={L("قبل الحضور = اليوم التالي", "Before check-in = next day")}><input className="hr-input hr-num" type="time" {...f.bind("checkOut")} /></Field>
          </>
        ) : null}
        <Field label={L("السبب *", "Reason *")} wide><textarea className="hr-textarea" maxLength={300} {...f.bind("reason")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("للأيام التي لا سجل لها فقط؛ اليوم المسجّل يُغيَّر بطلب تصحيح. الإضافي الناتج ينتظر الاعتماد. لا تسجّل حضورك أنت.", "Only for days without a record; a recorded day is changed through a correction request. Any resulting overtime awaits approval. Do not record your own attendance.")}</p>
    </Dialog>
  );
}

export function CorrectionDialog({ people, day, onClose, onDone }: { people: Person[]; day: string; onClose: () => void; onDone: () => void }) {
  const f = useForm({ employeeId: "", workDate: day, checkIn: "", checkOut: "", reason: "" });
  const a = useAction();
  const { L } = useHrI18n();
  const timesOk = (f.v.checkIn || f.v.checkOut) && (!f.v.checkIn || HHMM.test(f.v.checkIn)) && (!f.v.checkOut || HHMM.test(f.v.checkOut));
  const valid = f.v.employeeId && f.v.workDate && timesOk && f.v.reason.trim().length >= 3;
  const submit = () => a.run("save", async () => {
    await hrFetch("/api/hr/attendance/corrections", { json: { employeeId: f.v.employeeId, workDate: f.v.workDate, checkIn: f.v.checkIn || undefined, checkOut: f.v.checkOut || undefined, reason: f.v.reason.trim() } });
    onDone();
  });
  return (
    <Dialog open title={L("طلب تصحيح", "Request correction")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} disabled={!valid} onClick={submit}>{L("إرسال للاعتماد", "Submit for approval")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الموظف *", "Employee *")} wide><PersonSelect people={people} bind={f.bind("employeeId")} /></Field>
        <Field label={L("اليوم *", "Date *")} wide><input className="hr-input" type="date" {...f.bind("workDate")} /></Field>
        <Field label={L("حضور", "Check-in")} help={L("اتركه فارغًا لإبقائه", "Leave empty to keep it")}><input className="hr-input hr-num" type="time" {...f.bind("checkIn")} /></Field>
        <Field label={L("انصراف", "Check-out")} help={L("اتركه فارغًا لإبقائه", "Leave empty to keep it")}><input className="hr-input hr-num" type="time" {...f.bind("checkOut")} /></Field>
        <Field label={L("السبب *", "Reason *")} wide><textarea className="hr-textarea" maxLength={500} {...f.bind("reason")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("التصحيح لا يعدّل السجل الأصلي حتى يعتمده شخص آخر، ويحفظ القيم السابقة.", "A correction does not change the original record until someone else approves it, and the previous values are kept.")}</p>
    </Dialog>
  );
}

export function OvertimeDialog({ people, day, onClose, onDone }: { people: Person[]; day: string; onClose: () => void; onDone: () => void }) {
  const f = useForm({ employeeId: "", workDate: day, minutes: "", reason: "" });
  const a = useAction();
  const { L } = useHrI18n();
  const m = Number(f.v.minutes);
  const valid = f.v.employeeId && f.v.workDate && Number.isInteger(m) && m >= 1 && m <= 960 && f.v.reason.trim().length >= 3;
  const submit = () => a.run("save", async () => {
    await hrFetch("/api/hr/attendance/overtime", { json: { employeeId: f.v.employeeId, workDate: f.v.workDate, minutes: m, reason: f.v.reason.trim() } });
    onDone();
  });
  return (
    <Dialog open title={L("إضافي يدوي", "Manual overtime")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} disabled={!valid} onClick={submit}>{L("إرسال للاعتماد", "Submit for approval")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الموظف *", "Employee *")} wide><PersonSelect people={people} bind={f.bind("employeeId")} /></Field>
        <Field label={L("اليوم *", "Date *")}><input className="hr-input" type="date" {...f.bind("workDate")} /></Field>
        <Field label={L("الدقائق *", "Minutes *")} help={L("من 1 إلى 960", "1 to 960")}><input className="hr-input hr-num" inputMode="numeric" dir="ltr" {...f.bind("minutes")} /></Field>
        <Field label={L("السبب *", "Reason *")} wide><textarea className="hr-textarea" maxLength={300} {...f.bind("reason")} /></Field>
      </div>
    </Dialog>
  );
}

export function ShiftDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const f = useForm({ code: "", name: "", startTime: "", endTime: "", breakMinutes: "0", graceMinutes: "0" });
  const a = useAction();
  const { L } = useHrI18n();
  const br = Number(f.v.breakMinutes);
  const gr = Number(f.v.graceMinutes);
  const valid = f.v.code.trim() && f.v.name.trim() && HHMM.test(f.v.startTime) && HHMM.test(f.v.endTime) && Number.isInteger(br) && br >= 0 && br <= 240 && Number.isInteger(gr) && gr >= 0 && gr <= 120;
  const submit = () => a.run("save", async () => {
    await hrFetch("/api/hr/attendance/shifts", { json: { code: f.v.code.trim(), name: f.v.name.trim(), startTime: f.v.startTime, endTime: f.v.endTime, breakMinutes: br, graceMinutes: gr } });
    onDone();
  });
  return (
    <Dialog open title={L("وردية جديدة", "New shift")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} disabled={!valid} onClick={submit}>{L("حفظ", "Save")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الرمز *", "Code *")}><input className="hr-input" dir="ltr" maxLength={20} {...f.bind("code")} /></Field>
        <Field label={L("الاسم *", "Name *")}><input className="hr-input" maxLength={80} {...f.bind("name")} /></Field>
        <Field label={L("البداية *", "Start *")} help={L("بتوقيت الفرع", "Branch time")}><input className="hr-input hr-num" type="time" {...f.bind("startTime")} /></Field>
        <Field label={L("النهاية *", "End *")} help={L("قبل البداية = وردية ليلية", "Before the start = night shift")}><input className="hr-input hr-num" type="time" {...f.bind("endTime")} /></Field>
        <Field label={L("الاستراحة (دقائق)", "Break (minutes)")} help="0–240"><input className="hr-input hr-num" inputMode="numeric" dir="ltr" {...f.bind("breakMinutes")} /></Field>
        <Field label={L("السماح بالتأخير (دقائق)", "Late grace (minutes)")} help="0–120"><input className="hr-input hr-num" inputMode="numeric" dir="ltr" {...f.bind("graceMinutes")} /></Field>
      </div>
    </Dialog>
  );
}
