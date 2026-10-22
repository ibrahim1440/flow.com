"use client";
// The roaster form — RM2 «إضافة حمّاصة» (389:640, phone 379:49) and RM3 «تعديل» (391:1012). Five
// label-column sections (الهوية · النوع · السعة والحدود · التشغيل · الحالة), the error summary,
// inline errors, the unsaved bar (edit) and the save / cancel row. The rules are the API's; the
// page shows the field errors it returns (ROASTERS.md §7) and keeps every input on a failure.
import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { usePhone } from "@/components/shell/page-context";
import { useUnsavedGuard } from "../../../_components/useUnsavedGuard";
import { BASE, call, errText, ErrorSummary, N, Seg, STATUS, useLang, type ApiError, type FieldError, type Person, type Roaster } from "./shared";

export type Draft = {
  name: string; manufacturerModel: string; type: "PRODUCTION" | "SAMPLE";
  nominalCapacityKg: string; defaultTargetKg: string; minBatchKg: string; maxBatchKg: string; cycleMinutes: string;
  defaultOperatorId: string; status: "AVAILABLE" | "MAINTENANCE" | "STOPPED"; statusReason: string; isDefault: boolean;
  /** Scheduling hours (RM6–RM8): «0,1,2,3,4», «07:00», «15:00». */
  workDays: string; workStart: string; workEnd: string;
};

/** ROASTERS.md §4 example (illustrative until the owner confirms, D6). */
const DEFAULT_HOURS = { days: [0, 1, 2, 3, 4], start: "07:00", end: "15:00" };

export const draftOf = (r: Roaster): Draft => ({
  name: r.name, manufacturerModel: r.manufacturerModel ?? "", type: r.type,
  nominalCapacityKg: r.nominalCapacityKg, defaultTargetKg: r.defaultTargetKg, minBatchKg: r.minBatchKg, maxBatchKg: r.maxBatchKg,
  cycleMinutes: String(r.cycleMinutes), defaultOperatorId: r.defaultOperatorId ?? "",
  status: r.status === "RETIRED" ? "STOPPED" : r.status, statusReason: r.statusReason ?? "", isDefault: r.isDefault,
  workDays: (r.workingHours ?? DEFAULT_HOURS).days.join(","), workStart: (r.workingHours ?? DEFAULT_HOURS).start, workEnd: (r.workingHours ?? DEFAULT_HOURS).end,
});

export const emptyDraft = (type: "PRODUCTION" | "SAMPLE" = "PRODUCTION"): Draft => ({
  name: "", manufacturerModel: "", type, nominalCapacityKg: "", defaultTargetKg: "", minBatchKg: "", maxBatchKg: "",
  cycleMinutes: "", defaultOperatorId: "", status: "AVAILABLE", statusReason: "", isDefault: false,
  workDays: DEFAULT_HOURS.days.join(","), workStart: DEFAULT_HOURS.start, workEnd: DEFAULT_HOURS.end,
});

const LABELS: Record<keyof Draft, [string, string]> = {
  name: ["اسم الحمّاصة", "Roaster name"], manufacturerModel: ["الشركة المصنّعة والطراز", "Manufacturer and model"], type: ["النوع", "Type"],
  nominalCapacityKg: ["سعة الحمّاصة (حسب الشركة المصنّعة)", "Roaster capacity (manufacturer rating)"], defaultTargetKg: ["كمية التحميص الافتراضية", "Default roast quantity"], minBatchKg: ["أقل كمية مسموحة للتحميص", "Minimum roast quantity"],
  maxBatchKg: ["أعلى كمية مسموحة للتحميص", "Maximum roast quantity"], cycleMinutes: ["الدورة", "Cycle"], defaultOperatorId: ["المشغّل الافتراضي", "Default operator"],
  status: ["الحالة", "Status"], statusReason: ["السبب", "Reason"], isDefault: ["الافتراضية", "Default"],
  workDays: ["أيام العمل", "Working days"], workStart: ["بداية العمل", "Work starts"], workEnd: ["نهاية العمل", "Work ends"],
};

/** «تغيير واحد غير محفوظ · مدة الدورة 30 ← 35 دقيقة» — the changed fields of the draft. */
export function changesOf(base: Draft, d: Draft): (keyof Draft)[] {
  return (Object.keys(base) as (keyof Draft)[]).filter((k) => {
    const a = base[k], b = d[k];
    if (typeof a === "string" && typeof b === "string" && /Kg$/.test(k)) return Number(a) !== Number(b) || (a.trim() === "") !== (b.trim() === "");
    return String(a).trim() !== String(b).trim();
  });
}

export function RoasterForm({
  mode, initial, current, people, othersOfType, onSaved, headerExtra,
}: {
  mode: "add" | "edit";
  initial: Draft;
  current?: Roaster;
  people: Person[];
  /** Other roasters of each type still in service (the «ستصبح الافتراضية تلقائيًا» hint). */
  othersOfType: Record<"PRODUCTION" | "SAMPLE", number>;
  onSaved: (r: Roaster) => void;
  headerExtra?: ReactNode;
}) {
  const { ar, L } = useLang();
  const phone = usePhone();
  const router = useRouter();
  const [base, setBase] = useState(initial);
  const [d, setD] = useState(initial);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [alert, setAlert] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moveDefault, setMoveDefault] = useState<{ id: string; name: string } | null>(null);
  const changed = useMemo(() => changesOf(base, d), [base, d]);
  const dirty = mode === "edit" ? changed.length > 0 : changed.length > 0 && !busy;
  useUnsavedGuard(dirty, L("لديك تغييرات غير محفوظة.", "You have unsaved changes."));

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setD((x) => ({ ...x, [k]: v })); };
  const err = (f: string) => errors.find((e) => e.field === f);
  const errMsg = (f: string) => {
    const e = err(f);
    if (!e) return null;
    if (phone) {
      // The phone frame's short forms (379:49): «أقل من أقل كمية مسموحة للتحميص.», «أكبر من سعة الحمّاصة.».
      if (e.summaryAr === "كمية التحميص الافتراضية أقل من أقل كمية مسموحة للتحميص") return L("أقل من أقل كمية مسموحة للتحميص.", "Below the minimum roast quantity.");
      if (e.summaryAr === "أعلى كمية مسموحة للتحميص أكبر من سعة الحمّاصة") return L("أكبر من سعة الحمّاصة.", "Above the roaster capacity.");
    }
    return ar ? e.ar : e.en;
  };

  async function save(confirmMoveDefault = false) {
    if (busy) return;
    setBusy(true);
    setAlert(null);
    const body: Record<string, unknown> = {
      name: d.name, manufacturerModel: d.manufacturerModel, type: d.type,
      defaultTargetKg: d.defaultTargetKg, minBatchKg: d.minBatchKg, maxBatchKg: d.maxBatchKg, cycleMinutes: d.cycleMinutes,
      defaultOperatorId: d.defaultOperatorId || null, status: d.status, statusReason: d.statusReason, isDefault: d.isDefault,
      ...(mode === "add" ? { nominalCapacityKg: d.nominalCapacityKg } : { expectedUpdatedAt: current?.updatedAt }),
      ...(confirmMoveDefault ? { confirmMoveDefault: true } : {}),
      // Scheduling hours: sent on add, and on edit only when changed (a roaster never given hours keeps the built-in ones).
      ...(mode === "add" || ["workDays", "workStart", "workEnd"].some((k) => changed.includes(k as keyof Draft))
        ? { workingHours: { days: d.workDays.split(",").filter(Boolean).map(Number), start: d.workStart, end: d.workEnd } } : {}),
    };
    const r = mode === "add"
      ? await call<{ roaster: Roaster }>("/api/settings/production/roasters", "POST", body)
      : await call<{ roaster: Roaster }>(`/api/settings/production/roasters/${current!.id}`, "PATCH", body);
    setBusy(false);
    if (r.ok) {
      setErrors([]);
      setConflict(false);
      const next = draftOf(r.data.roaster);
      setBase(next);
      setD(next);
      onSaved(r.data.roaster);
      return;
    }
    const e: ApiError = r.data;
    if (e.code === "INVALID_FIELDS" && e.fields) { setErrors(e.fields); return; }
    setErrors([]);
    if (e.code === "DEFAULT_EXISTS" && e.currentDefault) { setMoveDefault(e.currentDefault); return; }
    if (e.code === "CONFLICT") setConflict(true);
    setAlert(errText(e, ar));
  }

  const typeOthers = othersOfType[d.type] - (mode === "edit" && current?.type === d.type ? 1 : 0);
  const autoDefault = typeOthers <= 0;
  const statusOpts: ["AVAILABLE" | "MAINTENANCE" | "STOPPED", string][] = (["AVAILABLE", "MAINTENANCE", "STOPPED"] as const).map((s) => [s, ar ? STATUS[s][0] : STATUS[s][1]]);
  // The owner's names are the labels as given (no unit in them); the unit sits in the input as its
  // suffix, «كغ» — kilograms of green coffee, as the section caption says.
  const kgLabel = (k: "nominalCapacityKg" | "defaultTargetKg" | "minBatchKg" | "maxBatchKg") => (ar ? LABELS[k][0] : LABELS[k][1]);
  const req = (s: string) => `${s} *`;
  const opt = (s: string) => `${s} ${L("(اختياري)", "(optional)")}`;
  const num = (k: "nominalCapacityKg" | "defaultTargetKg" | "minBatchKg" | "maxBatchKg", help?: ReactNode, disabled?: boolean) => (
    <Field label={req(kgLabel(k))} error={errMsg(k)} help={help}>
      <span className="ss-unitin">
        <input className="hr-input ss-numin" dir="ltr" inputMode="decimal" value={d[k]} disabled={disabled} aria-invalid={err(k) ? true : undefined}
          onChange={(e) => set(k, e.target.value)} data-testid={`f-${k}`} />
        <span aria-hidden>{L("كغ", "kg")}</span>
      </span>
    </Field>
  );
  const eligible = people.filter((p) => p.authorized || p.id === d.defaultOperatorId);

  // On a phone (379:49) the sections lose their label column; only the four weights sit two by two.
  const sec = (title: string, caption: string, body: ReactNode, cols = 2) => phone ? <div className={`ss-fbody${cols === 2 && title === L("السعة والحدود", "Capacity and limits") ? "" : " is-one"}`}>{body}</div> : (
    <section className="tl-sec ss-fsec">
      <header><h2>{title}</h2><p>{caption}</p></header>
      <div className={`tl-body ss-fgrid${cols === 1 ? " is-one" : ""}`}>{body}</div>
    </section>
  );

  const changeText = (() => {
    if (mode !== "edit" || changed.length === 0) return null;
    if (changed.length === 1) {
      const k = changed[0];
      const label = k === "cycleMinutes" ? L("مدة الدورة", "Cycle time") : ar ? LABELS[k][0] : LABELS[k][1];
      const show = (v: Draft[keyof Draft]) => k === "status" ? (ar ? STATUS[v as Draft["status"]][0] : STATUS[v as Draft["status"]][1])
        : k === "defaultOperatorId" ? people.find((p) => p.id === v)?.name ?? "—" : k === "isDefault" ? (v ? L("نعم", "yes") : L("لا", "no")) : String(v) || "—";
      const unit = k === "cycleMinutes" ? ` ${L("دقيقة", "min")}` : "";
      return <>{L("تغيير واحد غير محفوظ", "1 unsaved change")} · {label} <N>{show(base[k])}</N> ← <N>{show(d[k])}</N>{unit}</>;
    }
    const n = changed.length;
    return ar ? (n === 2 ? "تغييران غير محفوظين" : n <= 10 ? `${n} تغييرات غير محفوظة` : `${n} تغييرًا غير محفوظ`) : `${n} unsaved changes`;
  })();

  return (
    <form className="ss-form" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="roaster-form">
      {headerExtra}
      {changeText ? (
        <div className="ss-unsaved" role="status" data-testid="unsaved-bar">
          <span className="ss-dotw" aria-hidden />
          <span className="ss-unsaved-text">{changeText}</span>
          <span className="ss-unsaved-acts">
            <Btn size="sm" variant="ghost" onClick={() => { setD(base); setErrors([]); setAlert(null); }} data-testid="unsaved-discard">{L("تجاهل", "Discard")}</Btn>
            <Btn size="sm" variant="primary" type="submit" busy={busy}>{L("حفظ التغييرات", "Save changes")}</Btn>
          </span>
        </div>
      ) : null}
      <ErrorSummary errors={errors} phone={phone} />
      {alert ? (
        <div className="hr-notice tone-danger" role="alert" data-testid="form-alert">
          {alert}
          {conflict ? <> <Btn size="sm" onClick={() => router.refresh()}>{L("إعادة التحميل", "Reload")}</Btn></> : null}
        </div>
      ) : null}

      {sec(L("الهوية", "Identity"), L("اسم يظهر في الجدولة وفي «تسجيل دفعة».", "A name shown in scheduling and in «Record batch»."), <>
        <Field label={req(ar ? LABELS.name[0] : LABELS.name[1])} error={errMsg("name")}>
          <input className="hr-input" value={d.name} maxLength={80} aria-invalid={err("name") ? true : undefined} onChange={(e) => set("name", e.target.value)} data-testid="f-name" />
        </Field>
        {phone && mode === "add" ? null : (
          <Field label={opt(ar ? LABELS.manufacturerModel[0] : LABELS.manufacturerModel[1])} error={errMsg("manufacturerModel")}>
            <input className="hr-input" value={d.manufacturerModel} maxLength={160} placeholder={mode === "add" ? L("مثال: الشركة · الطراز", "e.g. Maker · Model") : L("غير مُدخل", "Not entered")} onChange={(e) => set("manufacturerModel", e.target.value)} data-testid="f-manufacturerModel" />
          </Field>
        )}
      </>)}
      {sec(L("النوع", "Type"), L("حمّاصة الإنتاج تخدم أوامر الإنتاج، وحمّاصة العينات تخدم العينات والتذوق.", "A production roaster serves production orders; a sample roaster serves samples and cupping."), (
        <div className="hr-field">
          <span className="hr-label">{req(L("النوع", "Type"))}</span>
          <Seg value={d.type} label={L("النوع", "Type")} options={[["PRODUCTION", L("إنتاج", "Production")], ["SAMPLE", L("عينات", "Sample")]]} onChange={(v) => set("type", v)} testId="f-type" />
          {err("type") ? <span className="hr-err">{errMsg("type")}</span> : null}
        </div>
      ), 1)}
      {sec(L("السعة والحدود", "Capacity and limits"), L("بالكيلوغرام الأخضر لكل دفعة. للتخطيط والتحقق فقط.", "In kg of green coffee per batch. For planning and validation only."), <>
        {mode === "add"
          ? num("nominalCapacityKg", phone ? undefined : L("تقييم الشركة المصنّعة. لا تتجاوزها أي دفعة.", "The manufacturer's rating. No batch exceeds it."))
          : num("nominalCapacityKg", L("مواصفة معتمدة. تغييرها طلب منفصل بمستند يُراجَع ويُسجَّل، ولا تتجاوزها أي دفعة.", "A verified specification. Changing it is a separate request with a document that is reviewed and recorded; no batch exceeds it."), true)}
        {num("defaultTargetKg", mode === "edit" ? L("يُقترح في «تسجيل دفعة» وفي تخطيط الدفعات.", "Suggested in «Record batch» and in batch planning.") : undefined)}
        {num("minBatchKg")}
        {num("maxBatchKg", mode === "edit" ? L("لا يتجاوز سعة الحمّاصة.", "Not above the roaster capacity.") : undefined)}
      </>)}
      {sec(L("التشغيل", "Operation"), L("تقدير مدة الخانة والمشغّل المقترح.", "The estimated slot length and the suggested operator."), <>
        <Field label={req(L("مدة الدورة التقديرية", "Estimated cycle time"))} error={errMsg("cycleMinutes")}
          help={mode === "edit" && current && String(current.cycleMinutes) !== d.cycleMinutes.trim()
            ? <>{L("تُستخدم لخانات الجدولة الجديدة فقط. الخانات الحالية", "Used for new schedule slots only. Current slots")} (<N>{current.cycleMinutes}</N> {L("دقيقة", "min")}) {L("لا تتغير.", "do not change.")}</>
            : L("تحميص وتبريد وتجهيز الدفعة التالية.", "Roast, cool and prepare the next batch.")}>
          <span className="ss-unitin">
            <input className="hr-input ss-numin" dir="ltr" inputMode="numeric" value={d.cycleMinutes} aria-invalid={err("cycleMinutes") ? true : undefined} onChange={(e) => set("cycleMinutes", e.target.value)} data-testid="f-cycleMinutes" />
            <span aria-hidden>{L("دقيقة", "min")}</span>
          </span>
        </Field>
        <div className="hr-field is-wide">
          <span className="hr-label">{L("أيام العمل وساعاته (للجدولة)", "Working days and hours (for scheduling)")}</span>
          <span style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }} data-testid="f-workingHours">
            {(ar ? ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]).map((name, dow) => {
              const on = d.workDays.split(",").filter(Boolean).map(Number).includes(dow);
              return (
                <label key={dow} className="tl-check">
                  <input type="checkbox" checked={on} onChange={(e) => {
                    const cur = new Set(d.workDays.split(",").filter(Boolean).map(Number));
                    if (e.target.checked) cur.add(dow); else cur.delete(dow);
                    set("workDays", [...cur].sort().join(","));
                  }} data-testid={`f-workDay-${dow}`} />
                  <span>{name}</span>
                </label>
              );
            })}
            <input className="hr-input" type="time" dir="ltr" step={300} style={{ width: 120 }} value={d.workStart} aria-label={L("بداية العمل", "Work starts")} onChange={(e) => set("workStart", e.target.value)} data-testid="f-workStart" />
            <span>–</span>
            <input className="hr-input" type="time" dir="ltr" step={300} style={{ width: 120 }} value={d.workEnd} aria-label={L("نهاية العمل", "Work ends")} onChange={(e) => set("workEnd", e.target.value)} data-testid="f-workEnd" />
          </span>
          {err("workingHours") ? <span className="hr-err">{errMsg("workingHours")}</span> : <span className="hr-help">{L("بتوقيت الرياض. تُوضع خانات الجدول داخلها فقط؛ تغييرها لا ينقل خانة معتمدة.", "Riyadh time. Schedule slots are placed inside these hours only; changing them never moves an approved slot.")}</span>}
        </div>
        <Field label={mode === "add" ? opt(ar ? LABELS.defaultOperatorId[0] : LABELS.defaultOperatorId[1]) : ar ? LABELS.defaultOperatorId[0] : LABELS.defaultOperatorId[1]} error={errMsg("defaultOperatorId")}>
          <Select className="hr-select" value={d.defaultOperatorId} onChange={(e) => set("defaultOperatorId", e.target.value)} placeholder={L("اختر مشغّلًا", "Choose an operator")} data-testid="f-defaultOperatorId">
            <option value="">{L("اختر مشغّلًا", "Choose an operator")}</option>
            {eligible.map((p) => <option key={p.id} value={p.id} disabled={!p.authorized}>{p.name}</option>)}
          </Select>
        </Field>
      </>)}
      {sec(L("الحالة", "Status"), L("الحمّاصة غير المتاحة لا تُجدول عليها دفعات.", "No batches are scheduled on a roaster that is not available."), <>
        <div className="hr-field">
          <span className="hr-label">{req(L("الحالة", "Status"))}</span>
          <Seg value={d.status} label={L("الحالة", "Status")} options={statusOpts} onChange={(v) => set("status", v)} testId="f-status" />
        </div>
        <div className="hr-field">
          <span className="hr-label">{L("الافتراضية", "Default")}</span>
          <label className="tl-check">
            <input type="checkbox" checked={d.isDefault || autoDefault} disabled={autoDefault} onChange={(e) => set("isDefault", e.target.checked)} data-testid="f-isDefault" />
            <span>{L("الحمّاصة الافتراضية لنوعها", "The default roaster of its type")}</span>
          </label>
          {autoDefault && mode === "add" ? <span className="hr-help">{d.type === "SAMPLE" ? L("لا توجد حمّاصة عينات أخرى. ستصبح الافتراضية تلقائيًا.", "There is no other sample roaster. It becomes the default automatically.") : L("لا توجد حمّاصة إنتاج أخرى. ستصبح الافتراضية تلقائيًا.", "There is no other production roaster. It becomes the default automatically.")}</span> : null}
        </div>
        {d.status !== "AVAILABLE" ? (
          <Field label={req(L("السبب", "Reason"))} error={errMsg("statusReason")} wide>
            <input className="hr-input" value={d.statusReason} maxLength={300} aria-invalid={err("statusReason") ? true : undefined} onChange={(e) => set("statusReason", e.target.value)} data-testid="f-statusReason" />
          </Field>
        ) : null}
      </>)}

      <div className={`ss-formacts${phone ? " is-sticky" : ""}`}>
        <Btn type="submit" variant="primary" busy={busy} data-testid="roaster-save">{mode === "add" ? L("حفظ الحمّاصة", "Save roaster") : L("حفظ التغييرات", "Save changes")}</Btn>
        {phone ? null : <Btn variant="ghost" className="ss-cancel" onClick={() => router.push(BASE)} data-testid="roaster-cancel">{L("إلغاء", "Cancel")}</Btn>}
      </div>

      <Dialog
        open={!!moveDefault}
        title={L("نقل الافتراضية", "Move the default")}
        onClose={() => setMoveDefault(null)}
        testId="move-default-dialog"
        actions={<>
          <Btn onClick={() => setMoveDefault(null)}>{L("إلغاء", "Cancel")}</Btn>
          <Btn variant="primary" busy={busy} onClick={() => { setMoveDefault(null); void save(true); }} data-testid="move-default-confirm">{L("نقل الافتراضية", "Move the default")}</Btn>
        </>}
      >
        <p style={{ margin: 0 }}>{ar
          ? `«${moveDefault?.name}» هي الافتراضية لهذا النوع. تصبح «${d.name || "هذه الحمّاصة"}» الافتراضية بدلًا منها.`
          : `«${moveDefault?.name}» is the default of this type. «${d.name || "This roaster"}» becomes the default instead.`}</p>
      </Dialog>
    </form>
  );
}
