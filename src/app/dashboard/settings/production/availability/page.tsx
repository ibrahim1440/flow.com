"use client";
// RM4 «التوفر والصيانة» (Figma 393:1398 at 1440, 394:1571 at 1024): the status card of each roaster
// («جدولة صيانة» · «تغيير الحالة»), the week ahead with the planned maintenance windows, and the
// maintenance table (planned and past). The status dialog is RM4b; the maintenance form is the
// model's (ROASTERS.md §4 RoasterMaintenance) — the frame draws its button, not its form.
//
// Working hours and holidays are not drawn as fields anywhere in the approved frames, so they are
// not stored: the week shows each day and the windows planned on it.
import { useMemo, useState } from "react";
import { Btn, Dot, Field, OpsLoading, OpsRoot } from "@/components/ops/ui";
import { Dialog, dateTimeIn } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { useD21Phone, useD21Title, usePhone } from "@/components/shell/page-context";
import { SettingsFrame } from "../../../_components/tools-ui";
import {
  BASE, call, dayLabel, errText, kindText, M_STATUS, monthDay, N, Plus, ReadOnlyNote, Retry, riyadhDay, RoastersHead, Seg, stamp,
  StatusText, useLang, useOverview, weekdayName, windowText, type FieldError, type Maintenance, type Roaster,
} from "../_parts/shared";
import { StatusDialog } from "../_parts/status-dialog";

type MDraft = { roasterId: string; title: string; kind: "ROUTINE" | "ONE_OFF"; recurrenceWeeks: string; day: string; from: string; to: string; status: Maintenance["status"]; requestedById: string; notes: string };

const riyadhIso = (day: string, time: string) => `${day}T${time}:00+03:00`;

export default function AvailabilityPage() {
  const { ar, L } = useLang();
  const phone = usePhone();
  const { data, error, reload } = useOverview();
  const [statusFor, setStatusFor] = useState<Roaster | null>(null);
  const [mOpen, setMOpen] = useState<{ edit: Maintenance | null; roasterId?: string } | null>(null);
  useD21Title(L("التوفر والصيانة", "Availability & maintenance"));
  useD21Phone({ title: L("التوفر والصيانة", "Availability & maintenance"), sub: L("الإعدادات · المحامص", "Settings · Roasters"), back: BASE });

  // The seven days from today (Riyadh).
  const days = useMemo(() => {
    const t = riyadhDay(new Date());
    return Array.from({ length: 7 }, (_, i) => {
      const dt = new Date(Date.UTC(t.y, t.m - 1, t.d + i));
      return { key: dt.toISOString().slice(0, 10), d: dt.getUTCDate(), m: dt.getUTCMonth() + 1, dow: dt.getUTCDay() };
    });
  }, []);
  const roasters = data?.roasters ?? [];
  const byRoaster = (id: string) => data?.maintenance.filter((m) => m.roasterId === id) ?? [];
  const planned = (m: Maintenance) => m.status === "PLANNED" || m.status === "IN_PROGRESS";

  /** The hatched windows on one day, placed on a 24-hour track (no working hours are stored). */
  const cell = (r: Roaster, day: string) => {
    const wins = byRoaster(r.id).filter((m) => planned(m) && riyadhDay(m.startsAt).key <= day && riyadhDay(m.endsAt).key >= day);
    const dayStart = Date.parse(`${day}T00:00:00+03:00`);
    return (
      <div className={`ss-daycell${r.status !== "AVAILABLE" ? " is-off" : ""}`} key={day} data-testid="week-cell">
        {wins.map((m) => {
          const a = Math.max(0, (Date.parse(m.startsAt) - dayStart) / 864e5), b = Math.min(1, (Date.parse(m.endsAt) - dayStart) / 864e5);
          return <span key={m.id} className="ss-hatch" style={{ insetInlineStart: `${a * 100}%`, width: `${Math.max(4, (b - a) * 100)}%` }} title={`${m.title} · ${windowText(m, ar)}`} />;
        })}
      </div>
    );
  };

  const sinceLine = (r: Roaster) => {
    const parts = [`${L("منذ", "Since")} ${stamp(r.statusSince, ar)}`];
    if (r.statusReason) parts.push(r.statusReason);
    if (r.statusUntil) parts.push(`${L("حتى", "until")} ${dayLabel(r.statusUntil, ar, false)}`);
    return parts.join(" · ");
  };

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <RoastersHead tab="avail" data={data} />
        {error ? <Retry error={error} onRetry={reload} /> : !data ? <OpsLoading rows={6} /> : (
          <div className="ss-stack" data-testid="availability-page">
            {roasters.length === 0 ? <p className="ss-muted">{L("لا توجد محمصة مسجّلة.", "No roaster is registered.")}</p> : null}
            {roasters.map((r) => (
              <div className="ss-statuscard" key={r.id} data-testid="status-card">
                <div>
                  <span className="ss-mrow is-start"><strong>{r.name}</strong><StatusText status={r.status} ar={ar} /></span>
                  <span className="ss-sub">{sinceLine(r)}</span>
                </div>
                {data.can.edit ? (
                  <div className="tl-acts">
                    <Btn size="sm" onClick={() => setMOpen({ edit: null, roasterId: r.id })} data-testid="maintenance-add-card">{L("جدولة صيانة", "Schedule maintenance")}</Btn>
                    <Btn size="sm" onClick={() => setStatusFor(r)} data-testid="status-change">{L("تغيير الحالة", "Change status")}</Btn>
                  </div>
                ) : null}
              </div>
            ))}

            {roasters.length ? (
              <section>
                <div className="ss-bh">
                  <h2>{L("التوفر هذا الأسبوع", "Availability this week")}</h2>
                  {phone ? null : <span>{L("فترات الصيانة المخططة · الجدولة لا تضع دفعات خلالها", "Planned maintenance windows · scheduling puts no batch inside them")}</span>}
                </div>
                <div className="ss-weekwrap">
                  <div className="ss-week" style={{ gridTemplateColumns: `120px repeat(7, minmax(${phone ? 56 : 0}px, 1fr))` }}>
                    <div />
                    {days.map((d, i) => (
                      <div key={d.key} className="ss-dayhead">
                        <strong className={i === 0 ? "is-today" : undefined}>{weekdayName(d.dow, ar)}</strong>
                        <span>{monthDay(d.d, d.m, ar)}</span>
                      </div>
                    ))}
                    {roasters.map((r) => (
                      <div key={r.id} className="ss-weekrow">
                        <div className="ss-weekname"><strong>{r.name}</strong><span>{ar ? STATUS_SHORT[r.status][0] : STATUS_SHORT[r.status][1]}</span></div>
                        {days.map((d) => cell(r, d.key))}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="ss-legend">
                  <span><i className="ss-sw is-day" />{L("يوم عمل", "Working day")}</span>
                  <span><i className="ss-sw is-hatch" />{L("صيانة مخططة", "Planned maintenance")}</span>
                  <span><i className="ss-sw is-off" />{L("المحمصة غير متاحة", "Roaster not available")}</span>
                </div>
              </section>
            ) : null}

            <section>
              <div className="ss-bh">
                <h2>{L("الصيانة", "Maintenance")}</h2>
                <span>{L("مخططة وسابقة", "Planned and past")}</span>
                {data.can.edit && roasters.length ? <button type="button" className="ss-link" onClick={() => setMOpen({ edit: null })} data-testid="maintenance-add"><Plus />{L("جدولة صيانة", "Schedule maintenance")}</button> : null}
              </div>
              {data.maintenance.length === 0 ? <p className="ss-muted" data-testid="maintenance-empty">{L("لا صيانة مخططة أو سابقة.", "No planned or past maintenance.")}</p> : (
                <div className="hr-tablewrap">
                  <table className="hr-table" aria-label={L("الصيانة", "Maintenance")}>
                    <thead>
                      <tr>
                        <th>{L("الموعد", "When")}</th>
                        <th>{L("العمل", "Work")}</th>
                        <th className="hr-hide-compact">{L("النوع", "Type")}</th>
                        <th>{L("الحالة", "Status")}</th>
                        <th className="hr-hide-compact">{L("الأثر على الجدولة", "Effect on scheduling")}</th>
                        <th aria-label={L("إجراء", "Action")} />
                      </tr>
                    </thead>
                    <tbody>
                      {data.maintenance.map((m) => {
                        const [sa, se, tone] = M_STATUS[m.status];
                        const rn = roasters.length > 1 ? roasters.find((r) => r.id === m.roasterId)?.name : null;
                        return (
                          <tr key={m.id} data-testid="maintenance-row">
                            <td><span>{dayLabel(m.startsAt, ar)}</span><span className="ss-sub"><N>{windowText(m, ar)}</N></span></td>
                            <td><span className="strong">{m.title}</span>{rn ? <span className="ss-sub">{rn}</span> : null}</td>
                            <td className="hr-hide-compact">{kindText(m, ar)}</td>
                            <td><Dot tone={tone}>{ar ? sa : se}</Dot></td>
                            <td className="hr-hide-compact">—</td>
                            <td style={{ textAlign: "end" }}>{data.can.edit && planned(m) ? <Btn size="sm" onClick={() => setMOpen({ edit: m })} data-testid="maintenance-edit">{L("تعديل", "Edit")}</Btn> : null}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {data.can.edit ? null : <ReadOnlyNote />}
          </div>
        )}
      </SettingsFrame>
      <StatusDialog roaster={statusFor} open={!!statusFor} onClose={() => setStatusFor(null)} onSaved={() => reload()} />
      {data && mOpen ? <MaintenanceDialog edit={mOpen.edit} roasterId={mOpen.roasterId} roasters={roasters} people={data.people} onClose={() => setMOpen(null)} onSaved={() => { setMOpen(null); reload(); }} /> : null}
    </OpsRoot>
  );
}

const STATUS_SHORT: Record<Roaster["status"], [string, string]> = {
  AVAILABLE: ["متاحة", "Available"], MAINTENANCE: ["في الصيانة", "Maintenance"], STOPPED: ["متوقفة", "Stopped"], RETIRED: ["خارج الخدمة", "Retired"],
};

function MaintenanceDialog({ edit, roasterId, roasters, people, onClose, onSaved }: { edit: Maintenance | null; roasterId?: string; roasters: Roaster[]; people: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const { ar, L } = useLang();
  const init: MDraft = edit ? {
    roasterId: edit.roasterId, title: edit.title, kind: edit.kind, recurrenceWeeks: edit.recurrenceWeeks ? String(edit.recurrenceWeeks) : "",
    day: dateTimeIn(edit.startsAt).slice(0, 10), from: dateTimeIn(edit.startsAt).slice(11, 16), to: dateTimeIn(edit.endsAt).slice(11, 16),
    status: edit.status, requestedById: edit.requestedById ?? "", notes: edit.notes ?? "",
  } : { roasterId: roasterId ?? roasters.find((r) => r.isDefault)?.id ?? roasters[0]?.id ?? "", title: "", kind: "ONE_OFF", recurrenceWeeks: "", day: dateTimeIn(new Date()).slice(0, 10), from: "", to: "", status: "PLANNED", requestedById: "", notes: "" };
  const [d, setD] = useState<MDraft>(init);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof MDraft>(k: K, v: MDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const err = (f: string) => { const e = errors.find((x) => x.field === f); return e ? (ar ? e.ar : e.en) : null; };

  async function save() {
    if (busy) return;
    setBusy(true);
    setAlert(null);
    const body = {
      title: d.title, kind: d.kind, recurrenceWeeks: d.kind === "ROUTINE" ? d.recurrenceWeeks : null,
      startsAt: d.day && d.from ? riyadhIso(d.day, d.from) : "", endsAt: d.day && d.to ? riyadhIso(d.day, d.to) : "",
      requestedById: d.requestedById || null, notes: d.notes,
      ...(edit ? { status: d.status } : { roasterId: d.roasterId }),
    };
    const r = edit
      ? await call(`/api/settings/production/maintenance/${edit.id}`, "PATCH", body)
      : await call("/api/settings/production/maintenance", "POST", body);
    setBusy(false);
    if (r.ok) { onSaved(); return; }
    if (r.data.code === "INVALID_FIELDS" && r.data.fields) { setErrors(r.data.fields); return; }
    setAlert(errText(r.data, ar));
  }

  return (
    <Dialog
      open
      title={edit ? L("تعديل الصيانة", "Edit maintenance") : L("جدولة صيانة", "Schedule maintenance")}
      onClose={() => { if (!busy) onClose(); }}
      testId="maintenance-dialog"
      actions={<>
        <Btn onClick={onClose} disabled={busy}>{L("إلغاء", "Cancel")}</Btn>
        <Btn variant="primary" busy={busy} onClick={() => void save()} data-testid="maintenance-save">{L("حفظ", "Save")}</Btn>
      </>}
    >
      <form className="hr-form" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {!edit && roasters.length > 1 ? (
          <Field label={`${L("المحمصة", "Roaster")} *`} wide>
            <Select className="hr-select" value={d.roasterId} onChange={(e) => set("roasterId", e.target.value)}>
              {roasters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field label={`${L("العمل", "Work")} *`} error={err("title")} wide>
          <input className="hr-input" value={d.title} maxLength={160} aria-invalid={err("title") ? true : undefined} onChange={(e) => set("title", e.target.value)} data-testid="m-title" />
        </Field>
        <div className="hr-field is-wide">
          <span className="hr-label">{L("النوع", "Type")} *</span>
          <Seg value={d.kind} label={L("النوع", "Type")} onChange={(v) => set("kind", v)} options={[["ONE_OFF", L("لمرة واحدة", "One-off")], ["ROUTINE", L("دورية", "Routine")]]} testId="m-kind" />
        </div>
        {d.kind === "ROUTINE" ? (
          <Field label={L("التكرار · كل كم أسبوع", "Repeat · every N weeks")} error={err("recurrenceWeeks")} help={L("للعرض: لا يُنشئ النظام المواعيد التالية تلقائيًا.", "Shown only: the next windows are not created automatically.")}>
            <input className="hr-input" dir="ltr" inputMode="numeric" value={d.recurrenceWeeks} onChange={(e) => set("recurrenceWeeks", e.target.value)} data-testid="m-recurrence" />
          </Field>
        ) : (
          <Field label={L("بطلب", "Requested by")} error={err("requestedById")}>
            <Select className="hr-select" value={d.requestedById} onChange={(e) => set("requestedById", e.target.value)}>
              <option value="">{L("—", "—")}</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label={`${L("اليوم", "Day")} *`} error={err("startsAt")}>
          <input className="hr-input" type="date" dir="ltr" value={d.day} onChange={(e) => set("day", e.target.value)} data-testid="m-day" />
        </Field>
        <Field label={`${L("من", "From")} *`}>
          <input className="hr-input" type="time" dir="ltr" value={d.from} onChange={(e) => set("from", e.target.value)} data-testid="m-from" />
        </Field>
        <Field label={`${L("إلى", "To")} *`} error={err("endsAt")}>
          <input className="hr-input" type="time" dir="ltr" value={d.to} aria-invalid={err("endsAt") ? true : undefined} onChange={(e) => set("to", e.target.value)} data-testid="m-to" />
        </Field>
        {edit ? (
          <div className="hr-field is-wide">
            <span className="hr-label">{L("الحالة", "Status")}</span>
            <Seg value={d.status} label={L("الحالة", "Status")} onChange={(v) => set("status", v)} testId="m-status"
              options={(["PLANNED", "IN_PROGRESS", "DONE", "CANCELLED"] as const).map((s) => [s, ar ? M_STATUS[s][0] : M_STATUS[s][1]])} />
          </div>
        ) : null}
        <Field label={L("ملاحظات", "Notes")} error={err("notes")} wide>
          <input className="hr-input" value={d.notes} maxLength={300} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        {alert ? <div className="hr-notice tone-danger is-wide" role="alert">{alert}</div> : null}
      </form>
    </Dialog>
  );
}
