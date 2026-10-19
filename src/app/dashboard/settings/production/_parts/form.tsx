"use client";
// The roaster form — RM2 «إضافة محمصة» (389:640, phone 379:49) and RM3 «تعديل» (391:1012). Five
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
};

export const draftOf = (r: Roaster): Draft => ({
  name: r.name, manufacturerModel: r.manufacturerModel ?? "", type: r.type,
  nominalCapacityKg: r.nominalCapacityKg, defaultTargetKg: r.defaultTargetKg, minBatchKg: r.minBatchKg, maxBatchKg: r.maxBatchKg,
  cycleMinutes: String(r.cycleMinutes), defaultOperatorId: r.defaultOperatorId ?? "",
  status: r.status === "RETIRED" ? "STOPPED" : r.status, statusReason: r.statusReason ?? "", isDefault: r.isDefault,
});

export const emptyDraft = (type: "PRODUCTION" | "SAMPLE" = "PRODUCTION"): Draft => ({
  name: "", manufacturerModel: "", type, nominalCapacityKg: "", defaultTargetKg: "", minBatchKg: "", maxBatchKg: "",
  cycleMinutes: "", defaultOperatorId: "", status: "AVAILABLE", statusReason: "", isDefault: false,
});

const LABELS: Record<keyof Draft, [string, string]> = {
  name: ["اسم المحمصة", "Roaster name"], manufacturerModel: ["الشركة المصنّعة والطراز", "Manufacturer and model"], type: ["النوع", "Type"],
  nominalCapacityKg: ["السعة الاسمية", "Nominal capacity"], defaultTargetKg: ["الهدف", "Target"], minBatchKg: ["الحد الأدنى", "Minimum"],
  maxBatchKg: ["الحد الأقصى", "Maximum"], cycleMinutes: ["الدورة", "Cycle"], defaultOperatorId: ["المشغّل الافتراضي", "Default operator"],
  status: ["الحالة", "Status"], statusReason: ["السبب", "Reason"], isDefault: ["الافتراضية", "Default"],
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
      // The phone frame's short forms (379:49): «أقل من الحد الأدنى.», «أكبر من السعة الاسمية.».
      if (e.summaryAr === "الهدف الافتراضي أقل من الحد الأدنى") return L("أقل من الحد الأدنى.", "Below the minimum.");
      if (e.summaryAr === "الحد الأقصى أكبر من السعة الاسمية") return L("أكبر من السعة الاسمية.", "Above the nominal capacity.");
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
  const kgLabel = (k: "nominalCapacityKg" | "defaultTargetKg" | "minBatchKg" | "maxBatchKg") => {
    if (phone) return `${ar ? LABELS[k][0] : LABELS[k][1]} · ${L("كغ", "kg")}`;
    const full: Record<typeof k, [string, string]> = {
      nominalCapacityKg: ["السعة الاسمية · كغ أخضر", "Nominal capacity · kg green"], defaultTargetKg: ["الهدف الافتراضي · كغ أخضر", "Default target · kg green"],
      minBatchKg: ["الحد الأدنى للدفعة · كغ", "Minimum batch · kg"], maxBatchKg: ["الحد الأقصى للدفعة · كغ", "Maximum batch · kg"],
    };
    return ar ? full[k][0] : full[k][1];
  };
  const req = (s: string) => `${s} *`;
  const opt = (s: string) => `${s} ${L("(اختياري)", "(optional)")}`;
  const num = (k: "nominalCapacityKg" | "defaultTargetKg" | "minBatchKg" | "maxBatchKg", help?: ReactNode, disabled?: boolean) => (
    <Field label={req(kgLabel(k))} error={errMsg(k)} help={help}>
      <input className="hr-input ss-numin" dir="ltr" inputMode="decimal" value={d[k]} disabled={disabled} aria-invalid={err(k) ? true : undefined}
        onChange={(e) => set(k, e.target.value)} data-testid={`f-${k}`} />
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
      {sec(L("النوع", "Type"), L("محمصة الإنتاج تخدم أوامر الإنتاج، ومحمصة العينات تخدم العينات والتذوق.", "A production roaster serves production orders; a sample roaster serves samples and cupping."), (
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
        {num("maxBatchKg", mode === "edit" ? L("لا يتجاوز السعة الاسمية.", "Not above the nominal capacity.") : undefined)}
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
        <Field label={mode === "add" ? opt(ar ? LABELS.defaultOperatorId[0] : LABELS.defaultOperatorId[1]) : ar ? LABELS.defaultOperatorId[0] : LABELS.defaultOperatorId[1]} error={errMsg("defaultOperatorId")}>
          <Select className="hr-select" value={d.defaultOperatorId} onChange={(e) => set("defaultOperatorId", e.target.value)} placeholder={L("اختر مشغّلًا", "Choose an operator")} data-testid="f-defaultOperatorId">
            <option value="">{L("اختر مشغّلًا", "Choose an operator")}</option>
            {eligible.map((p) => <option key={p.id} value={p.id} disabled={!p.authorized}>{p.name}</option>)}
          </Select>
        </Field>
      </>)}
      {sec(L("الحالة", "Status"), L("المحمصة غير المتاحة لا تُجدول عليها دفعات.", "No batches are scheduled on a roaster that is not available."), <>
        <div className="hr-field">
          <span className="hr-label">{req(L("الحالة", "Status"))}</span>
          <Seg value={d.status} label={L("الحالة", "Status")} options={statusOpts} onChange={(v) => set("status", v)} testId="f-status" />
        </div>
        <div className="hr-field">
          <span className="hr-label">{L("الافتراضية", "Default")}</span>
          <label className="tl-check">
            <input type="checkbox" checked={d.isDefault || autoDefault} disabled={autoDefault} onChange={(e) => set("isDefault", e.target.checked)} data-testid="f-isDefault" />
            <span>{L("المحمصة الافتراضية لنوعها", "The default roaster of its type")}</span>
          </label>
          {autoDefault && mode === "add" ? <span className="hr-help">{d.type === "SAMPLE" ? L("لا توجد محمصة عينات أخرى. ستصبح الافتراضية تلقائيًا.", "There is no other sample roaster. It becomes the default automatically.") : L("لا توجد محمصة إنتاج أخرى. ستصبح الافتراضية تلقائيًا.", "There is no other production roaster. It becomes the default automatically.")}</span> : null}
        </div>
        {d.status !== "AVAILABLE" ? (
          <Field label={req(L("السبب", "Reason"))} error={errMsg("statusReason")} wide>
            <input className="hr-input" value={d.statusReason} maxLength={300} aria-invalid={err("statusReason") ? true : undefined} onChange={(e) => set("statusReason", e.target.value)} data-testid="f-statusReason" />
          </Field>
        ) : null}
      </>)}

      <div className={`ss-formacts${phone ? " is-sticky" : ""}`}>
        <Btn type="submit" variant="primary" busy={busy} data-testid="roaster-save">{mode === "add" ? L("حفظ المحمصة", "Save roaster") : L("حفظ التغييرات", "Save changes")}</Btn>
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
          ? `«${moveDefault?.name}» هي الافتراضية لهذا النوع. تصبح «${d.name || "هذه المحمصة"}» الافتراضية بدلًا منها.`
          : `«${moveDefault?.name}» is the default of this type. «${d.name || "This roaster"}» becomes the default instead.`}</p>
      </Dialog>
    </form>
  );
}
