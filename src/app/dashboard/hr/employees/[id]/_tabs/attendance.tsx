"use client";
// HR-02 · Attendance: shift assignment only. Day-by-day attendance lives on the attendance board.
import { Select } from "@/components/ui/Select";
import { useState } from "react";
import { Btn, Empty, Field, Notice, todayIso, useAction, useCan, useForm, useHrI18n, useHrMeta } from "@/components/hr/ui";
import { WEEKDAYS } from "@/lib/i18n/hr";
import { Check, SectionHead, mutate, type TabProps } from "./shared";

export default function AttendanceTab({ id, readOnly }: TabProps) {
  const can = useCan();
  const { meta } = useHrMeta();
  const shifts = meta?.shifts ?? [];
  const weekend = meta?.policy?.weekendDays ?? [5, 6];
  const f = useForm({ shiftId: "", effectiveFrom: todayIso() });
  const [days, setDays] = useState<number[]>(() => [0, 1, 2, 3, 4, 5, 6].filter((d) => !weekend.includes(d)));
  const [saved, setSaved] = useState<string | null>(null);
  const a = useAction();
  const { L, lang } = useHrI18n();
  const canAssign = can("attendance_manage") && !readOnly;
  const toggle = (d: number, on: boolean) => setDays((s) => (on ? [...new Set([...s, d])].sort((x, y) => x - y) : s.filter((x) => x !== d)));
  const submit = () => a.run("save", async () => {
    setSaved(null);
    await mutate(`/api/hr/employees/${id}/shift`, { json: { shiftId: f.v.shiftId, effectiveFrom: f.v.effectiveFrom, weekdays: days } });
    const s = shifts.find((x) => x.id === f.v.shiftId);
    setSaved(L(`عُيّنت وردية «${s?.name ?? ""}» اعتبارًا من ${f.v.effectiveFrom}.`, `Shift “${s?.name ?? ""}” assigned from ${f.v.effectiveFrom}.`));
  });

  if (!canAssign) {
    return <Empty title={L("تعيين الوردية", "Shift assignment")} body={readOnly ? L("انتهت خدمة الموظف؛ لا تُعيَّن له ورديات.", "The employee’s service has ended; no shifts are assigned.") : L("تحتاج صلاحية «إدارة الحضور» لتعيين وردية. سجل الحضور اليومي في لوحة الحضور.", "You need the “Manage attendance” permission to assign a shift. The daily record is on the attendance board.")} />;
  }
  return (
    <section className="hr-stack" style={{ maxWidth: 640 }}>
      <SectionHead title={L("تعيين وردية", "Assign a shift")} />
      <p className="hr-caption" style={{ margin: 0 }}>{L("التعيين الجديد يُغلق التعيين المفتوح في اليوم السابق لسريانه، ولا يُقبل تعيين يبدأ قبل تعيين لاحق قائم.", "A new assignment closes the open one the day before it takes effect; an assignment cannot start before a later existing one.")}</p>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      {saved ? <Notice tone="success">{saved}</Notice> : null}
      {shifts.length === 0 ? (
        <Empty title={L("لا توجد ورديات معرّفة", "No shifts defined")} body={L("عرّف الورديات من صفحة الحضور أولًا.", "Define shifts on the attendance page first.")} />
      ) : (
        <>
          <div className="hr-form">
            <Field label={L("الوردية *", "Shift *")}>
              <Select className="hr-select" {...f.bind("shiftId")}>
                <option value="">{L("— اختر —", "— Select —")}</option>
                {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.startTime}–{s.endTime}</option>)}
              </Select>
            </Field>
            <Field label={L("تسري من *", "Effective from *")}><input className="hr-input" type="date" {...f.bind("effectiveFrom")} /></Field>
          </div>
          <div className="hr-stack" style={{ gap: 6 }}>
            <span className="hr-label">{L("أيام العمل *", "Working days *")}</span>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              {WEEKDAYS[lang].map((w, i) => <Check key={i} checked={days.includes(i)} onChange={(on) => toggle(i, on)}>{w}</Check>)}
            </div>
          </div>
          <div><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!f.v.shiftId || !f.v.effectiveFrom || days.length === 0}>{L("تعيين الوردية", "Assign shift")}</Btn></div>
        </>
      )}
      <p className="hr-caption" style={{ margin: 0 }}>{L("لا يعرض الملف الوردية الحالية بعد؛ راجعها في لوحة الحضور.", "The file does not show the current shift yet; check it on the attendance board.")}</p>
    </section>
  );
}
