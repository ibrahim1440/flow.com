"use client";
/**
 * Print settings · Paper & printer profiles (A-3), per design 1652:10127 (EN) / 1652:9690 (AR):
 * a card list of profiles with the job-limit card, an inline edit panel in millimetres (paired
 * inputs, segmented orientation, the four-margin dimension check, the A-8 block, Save / Duplicate as
 * new / Print calibration page) and the «Layout to scale» panel. Presets are read-only starting
 * points (duplicate to customise); authorized users create, edit, duplicate and delete their own
 * profiles (administrators: any). Administrators also set the job cap (default 200). Every rule is
 * enforced again by the API; this screen only offers what the server allows.
 */
import { Select } from "@/components/ui/Select";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Btn, Notice, OpsBanner, OpsError, OpsLoading, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../user-context";
import { dimText, dpiText, hasArabic } from "@/lib/print/bidi";
import { PROFILE_KINDS, PROFILE_LIMITS, fitSums, profileDisplayName, validateProfile, type PrintProfileData, type ProfileError, type ProfileInput } from "@/lib/print/profiles";
import { sheetSlots, pageSize } from "@/lib/print/layout";
import { PrintPortal } from "@/components/print/SheetView";
import { CalibrationSvg } from "@/components/print/CalibrationPage";
import { PrintSettingsTabs } from "@/components/print/SettingsTabs";
import { PRINT_GATE_NOTE_ID, PrintNotCertifiedNotice, notCertifiedText, usePrintCertified } from "@/components/print/Certification";
import "@/components/print/print.css";

type Row = PrintProfileData & { canEdit: boolean };
type Draft = Record<keyof ProfileInput, string>;
type NumKey = Exclude<keyof ProfileInput, "name" | "kind" | "orientation">;

const KIND_LABEL: Record<string, [string, string]> = {
  A4_PLAIN: ["ورق A4 عادي", "A4 plain"], A4_SHEET: ["ورقة ملصقات A4", "A4 label sheet"], THERMAL_ROLL: ["لفافة حرارية", "Thermal roll"], CUSTOM: ["مخصص", "Custom"],
};
const NUM_KEYS: NumKey[] = ["paperWidthMm", "paperHeightMm", "labelWidthMm", "labelHeightMm", "marginTopMm", "marginRightMm", "marginBottomMm", "marginLeftMm", "gapXMm", "gapYMm", "columns", "rows", "scalePct", "dpi", "offsetXMm", "offsetYMm", "defaultStartSlot", "defaultCopies"];
const BLANK: ProfileInput = { name: "", kind: "CUSTOM", paperWidthMm: 100, paperHeightMm: 70, labelWidthMm: 100, labelHeightMm: 70, marginTopMm: 0, marginLeftMm: 0, marginRightMm: 0, marginBottomMm: 0, gapXMm: 0, gapYMm: 3, columns: 1, rows: 1, orientation: "PORTRAIT", scalePct: 100, dpi: 203, offsetXMm: 0, offsetYMm: 0, defaultStartSlot: 1, defaultCopies: 1 };

const toDraft = (p: ProfileInput): Draft => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])) as Draft;
function fromDraft(d: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = { name: d.name, kind: d.kind, orientation: d.orientation };
  for (const k of NUM_KEYS) out[k] = d[k] === "" ? NaN : Number(d[k]);
  // Thermal roll (1661:14636): the paper is the liner width; its length is one label (plus the
  // margins), one row — the gap between labels is the driver's gap detection.
  if (d.kind === "THERMAL_ROLL") {
    out.rows = 1;
    out.paperHeightMm = Number(out.marginTopMm) + Number(out.labelHeightMm) + Number(out.marginBottomMm);
  }
  return out;
}

async function call<T>(url: string, method = "GET", json?: unknown) {
  const r = await fetch(url, { method, headers: json !== undefined ? { "Content-Type": "application/json" } : undefined, body: json !== undefined ? JSON.stringify(json) : undefined, cache: "no-store" });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: body as T & { error?: string; code?: string; errors?: ProfileError[] } };
}

export default function ProfilesPage() {
  return <OpsRoot><ProfilesInner /></OpsRoot>;
}

/** The card's second line (1652:10127): «A4 · 99.1 × 67.7 mm · 2 × 4», «3 mm gap · 203 dpi». */
function cardMeta(p: Row, L: (ar: string, en: string) => string): ReactNode {
  const sheet = p.kind === "A4_SHEET" || p.kind === "A4_PLAIN" || (p.columns * p.rows > 1);
  const parts: ReactNode[] = [];
  if (!p.isPreset) parts.push(L("مخصص", "Custom"));
  if (p.kind === "THERMAL_ROLL" || !sheet) {
    const gap = <bdi dir="ltr" className="hr-num">{`${p.gapYMm}`}</bdi>;
    parts.push(<span key="g">{L("فاصل ", "")}{gap}{L(" مم", " mm gap")}</span>);
    parts.push(<bdi key="d" dir="ltr" className="hr-num">{dpiText(p.dpi)}</bdi>);
  } else {
    parts.push(<bdi key="p" dir="ltr">{p.paperWidthMm === 210 && p.paperHeightMm === 297 ? "A4" : dimText(p.paperWidthMm, p.paperHeightMm)}</bdi>);
    // A4 plain prints one page: its size is the paper's («A4 · 210 × 297 mm»).
    parts.push(<bdi key="l" dir="ltr" className="hr-num">{p.kind === "A4_PLAIN" ? dimText(p.paperWidthMm, p.paperHeightMm) : dimText(p.labelWidthMm, p.labelHeightMm)}</bdi>);
    if (p.columns * p.rows > 1) parts.push(<bdi key="c" dir="ltr" className="hr-num">{`${p.columns} × ${p.rows}`}</bdi>);
  }
  return parts.map((x, i) => <span key={i}>{i ? " · " : ""}{x}</span>);
}

/** «Layout to scale» (1652:10127): the oriented paper, every slot, and the top margin band. */
function LayoutToScale({ p }: { p: ProfileInput | null }) {
  const L = useL();
  if (!p) return <span className="hr-caption">{L("صحّح القيم لعرض المخطط.", "Correct the values to see the layout.")}</span>;
  const { w, h } = pageSize(p);
  const k = Math.min(231 / w, 327 / h);
  const slots = sheetSlots(p);
  return (
    <div className="pp-sheet" dir="ltr" style={{ width: w * k, height: h * k }} data-testid="profile-preview">
      {p.marginTopMm > 0 ? <div className="pp-sheet-margin" style={{ height: p.marginTopMm * k }} /> : null}
      {slots.map((s) => <div key={s.slot} className="pp-sheet-slot" style={{ left: s.xMm * k, top: s.yMm * k, width: s.wMm * k, height: s.hMm * k }} />)}
    </div>
  );
}

/** A millimetre (or %, dpi) input with its unit inside the box, as in the design's paired inputs. */
function UnitInput({ field, value, unit, onChange, invalid, label, disabled, placeholder, step }: { field: NumKey; value: string; unit?: string; onChange: (v: string) => void; invalid: boolean; label: string; disabled?: boolean; placeholder?: string; step?: string }) {
  return (
    <span className={`pp-input${invalid ? " is-invalid" : ""}${disabled ? " is-disabled" : ""}`}>
      <input type="number" inputMode="decimal" step={step ?? "0.01"} value={value} data-field={field} aria-label={label} aria-invalid={invalid}
        disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {unit ? <span className="pp-unit" dir="ltr">{unit}</span> : null}
    </span>
  );
}

function ProfilesInner() {
  const L = useL();
  const { lang } = useI18n();
  const user = useUser();
  const isAdmin = user?.role === "admin";
  const [rows, setRows] = useState<Row[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [err, setErr] = useState<{ status: number; message: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string | null; draft: Draft; readOnly: boolean } | null>(null);
  const [serverErrors, setServerErrors] = useState<ProfileError[]>([]);
  const [banner, setBanner] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<Row | null>(null);
  const [cap, setCap] = useState<{ value: number; draft: string; editing: boolean } | null>(null);
  // «Print calibration page» (design §P2-3): rulers + slot outlines of one profile, no ERP data.
  const [calib, setCalib] = useState<(ProfileInput & { title: string }) | null>(null);
  // The print certification gate (A-8): the calibration page prints only once the server
  // authorizes it (POST /api/print/calibration refuses with 409 while printing is not certified).
  const certified = usePrintCertified();
  const calibrate = async (p: ProfileInput & { title: string }) => {
    const r = await call<{ ok: boolean }>("/api/print/calibration", "POST");
    if (r.ok) { setCalib(p); return; }
    setBanner({ tone: "danger", text: notCertifiedText(r.body, lang === "ar" ? "ar" : "en") ?? r.body.error ?? `HTTP ${r.status}` });
  };
  const onCalibReady = useCallback(() => {
    const done = () => { window.removeEventListener("afterprint", done); setCalib(null); };
    window.addEventListener("afterprint", done);
    window.print();
  }, []);

  const name = useCallback((p: Row) => profileDisplayName(p, lang === "ar" ? "ar" : "en"), [lang]);
  const open = useCallback((p: Row) => {
    setServerErrors([]); setSelected(p.id);
    setEdit({ id: p.id, draft: toDraft({ ...p, name: p.isPreset ? profileDisplayName(p, "en") : p.name }), readOnly: !p.canEdit });
    // One column on a phone / tablet: bring the panel into view.
    if (typeof window !== "undefined" && window.innerWidth < 768) requestAnimationFrame(() => document.querySelector('[data-testid="profile-form"]')?.scrollIntoView({ block: "start" }));
  }, []);

  const load = useCallback(async (select?: string) => {
    const r = await call<{ profiles: Row[]; canManage: boolean }>("/api/print/profiles");
    if (!r.ok) { setErr({ status: r.status, message: r.body.error ?? `HTTP ${r.status}` }); return; }
    setErr(null); setRows(r.body.profiles); setCanManage(r.body.canManage);
    const pick = r.body.profiles.find((p) => p.id === select) ?? null;
    if (pick) open(pick);
    else setEdit((cur) => {
      if (cur && (cur.id === null || r.body.profiles.some((p) => p.id === cur.id))) return cur;
      const first = r.body.profiles.find((p) => !p.isPreset && p.canEdit) ?? r.body.profiles[0];
      if (!first) return null;
      setSelected(first.id);
      return { id: first.id, draft: toDraft({ ...first, name: first.isPreset ? profileDisplayName(first, "en") : first.name }), readOnly: !first.canEdit };
    });
    const s = await call<{ maxLabelsPerJob: number }>("/api/print/settings");
    if (s.ok) setCap({ value: s.body.maxLabelsPerJob, draft: String(s.body.maxLabelsPerJob), editing: false });
  }, [open]);
  useEffect(() => { load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect -- initial fetch

  const local = useMemo(() => (edit ? validateProfile(fromDraft(edit.draft)) : null), [edit]);
  const errs = (key: string) => [...(local && !local.ok ? local.errors : []), ...serverErrors].filter((e) => e.field === key);
  const set = (k: keyof ProfileInput, v: string) => setEdit((e) => (e ? { ...e, draft: { ...e.draft, [k]: v } } : e));

  const save = async () => {
    if (!edit || edit.readOnly || !local?.ok) return;
    const r = edit.id ? await call<Row>(`/api/print/profiles/${edit.id}`, "PUT", local.value) : await call<Row>("/api/print/profiles", "POST", local.value);
    if (!r.ok) { setServerErrors(r.body.errors ?? []); setBanner({ tone: "danger", text: r.body.error ?? `HTTP ${r.status}` }); return; }
    setServerErrors([]); setBanner({ tone: "success", text: L("حُفظ الملف.", "Profile saved.") }); load(r.body.id);
  };
  const duplicate = async (p: Row) => {
    const r = await call<Row>(`/api/print/profiles/${p.id}/duplicate`, "POST", { name: `${profileDisplayName(p, "en")} (${L("نسخة", "copy")})` });
    setBanner(r.ok ? { tone: "success", text: L("أُنشئت نسخة يمكنك تعديلها.", "A copy you can edit was created.") } : { tone: "danger", text: r.body.error ?? `HTTP ${r.status}` });
    load(r.ok ? r.body.id : undefined);
  };
  // «Duplicate as new» saves the values in the form as a new profile of the user's own.
  const duplicateAsNew = async () => {
    if (!local?.ok) return;
    const r = await call<Row>("/api/print/profiles", "POST", { ...local.value, name: `${local.value.name} (${L("نسخة", "copy")})`.slice(0, PROFILE_LIMITS.nameMax) });
    if (!r.ok) { setServerErrors(r.body.errors ?? []); setBanner({ tone: "danger", text: r.body.error ?? `HTTP ${r.status}` }); return; }
    setBanner({ tone: "success", text: L("أُنشئت نسخة يمكنك تعديلها.", "A copy you can edit was created.") }); load(r.body.id);
  };
  const remove = async (p: Row) => {
    const r = await call(`/api/print/profiles/${p.id}`, "DELETE");
    setConfirmDel(null);
    setBanner(r.ok ? { tone: "success", text: L("حُذف الملف.", "Profile deleted.") } : { tone: "danger", text: r.body.error ?? `HTTP ${r.status}` });
    if (r.ok) { setEdit(null); setSelected(null); }
    load();
  };
  const saveCap = async () => {
    if (!cap) return;
    const r = await call<{ maxLabelsPerJob: number }>("/api/print/settings", "PUT", { maxLabelsPerJob: Number(cap.draft) });
    setBanner(r.ok ? { tone: "success", text: L("حُفظ الحد الأقصى للمهمة.", "Job limit saved.") } : { tone: "danger", text: r.body.error ?? `HTTP ${r.status}` });
    if (r.ok) setCap({ value: r.body.maxLabelsPerJob, draft: String(r.body.maxLabelsPerJob), editing: false });
  };

  const header = <PageHeader title={L("إعدادات الطباعة", "Print settings")}><span>{L("ملفات الورق والطابعة · للمخوّلين", "Paper & printer profiles · authorized users")}</span></PageHeader>;
  if (err) {
    return (
      <div className="hr-page">
        {header}
        {err.status === 403 || err.status === 401
          ? <Notice tone="warning"><span data-testid="profiles-denied">{L("لا تملك صلاحية الطباعة أو إدارة ملفات الطابعة.", "You don’t have permission to print or to manage printer profiles.")}</span></Notice>
          : <OpsError message={err.message} onRetry={() => load()} />}
      </div>
    );
  }

  const draftProfile = local?.ok ? local.value : null;
  const current = rows?.find((p) => p.id === edit?.id) ?? null;
  const d = edit ? (fromDraft(edit.draft) as Record<string, number>) : null;
  const fit = d && [d.paperWidthMm, d.paperHeightMm, d.labelWidthMm, d.labelHeightMm, d.columns, d.rows, d.marginTopMm, d.marginRightMm, d.marginBottomMm, d.marginLeftMm, d.gapXMm, d.gapYMm].every(Number.isFinite)
    ? fitSums({ ...(d as unknown as ProfileInput), orientation: edit?.draft.orientation === "LANDSCAPE" ? "LANDSCAPE" : "PORTRAIT" }) : null;
  const ro = !!edit?.readOnly;
  const thermal = edit?.draft.kind === "THERMAL_ROLL";
  const num = (k: NumKey, unit: string | undefined, label: string, extra?: { step?: string }) => edit ? (
    <UnitInput field={k} value={edit.draft[k]} unit={unit} label={label} onChange={(v) => set(k, v)} invalid={errs(k).length > 0} disabled={ro} step={extra?.step} />
  ) : null;
  const errLine = (keys: NumKey[]) => {
    const bad = keys.filter((k) => errs(k).length > 0);
    return bad.length ? <span className="hr-err">{bad.map((k) => <span key={k} data-testid={`err-${k}`}>{L("خارج النطاق المسموح.", "Out of the allowed range.")} </span>)}</span> : null;
  };
  const mm = L("مم", "mm");

  return (
    <div className="hr-page">
      {header}
      <PrintSettingsTabs current="profiles" />
      {banner ? <OpsBanner tone={banner.tone} onClose={() => setBanner(null)}><span data-testid="profiles-banner">{banner.text}</span></OpsBanner> : null}
      {!canManage && rows ? <Notice tone="info"><span data-testid="profiles-readonly">{L("تستطيع اختيار هذه الملفات عند الطباعة. إنشاؤها وتعديلها يحتاج صلاحية «إدارة ملفات الورق والطابعة».", "You can choose these profiles when printing. Creating and editing them needs the “manage paper and printer profiles” permission.")}</span></Notice> : null}

      {!rows ? <OpsLoading rows={4} /> : (
        <div className="pp-main">
          <section className="pp-list" aria-label={L("ملفات الورق والطابعة", "Paper & printer profiles")} data-testid="profiles-table">
            <div className="pp-list-head">
              <h2>{L("ملفات الورق والطابعة", "Paper & printer profiles")}</h2>
              {canManage ? <Btn variant="primary" data-testid="profile-new" onClick={() => { setServerErrors([]); setSelected(null); setEdit({ id: null, draft: toDraft(BLANK), readOnly: false }); }}>{L("ملف جديد", "New profile")}</Btn> : null}
            </div>
            {rows.map((p) => (
              <article key={p.id} className={`pp-card${selected === p.id ? " is-selected" : ""}`} data-profile={p.presetKey ?? p.id} data-testid="profile-card">
                <div className="pp-card-title">
                  <strong>{p.isPreset || hasArabic(name(p)) ? name(p) : <bdi dir="ltr">{name(p)}</bdi>}</strong>
                  {p.isPreset ? <span className="pp-chip">{L("نقطة بداية", "Starting point")}</span> : null}
                  <span className="pp-chip is-warn" data-testid="cert-chip">{L("غير معتمد فعليًا", "Not physically certified")}</span>
                </div>
                <div className="pp-card-meta">{cardMeta(p, L)}</div>
                <div className="pp-card-links">
                  <button type="button" onClick={() => open(p)} data-testid="profile-edit">{L("تعديل", "Edit")}</button>
                  {canManage ? <button type="button" onClick={() => duplicate(p)} data-testid="profile-duplicate">{L("نسخ", "Duplicate")}</button> : null}
                </div>
              </article>
            ))}
            {cap ? (
              <article className="pp-card is-plain" data-testid="print-cap">
                <strong className="pp-cap-title">{L(`الحد الأقصى للطلب الواحد: ${cap.value} ملصق`, `Job limit: ${cap.value} labels per job`)}</strong>
                <span className="pp-card-meta">{L("حد أمان افتراضي يعدّله المسؤول، ويُطبّق في الخادم.", "Default safety cap, configurable by an administrator and enforced on the server.")}</span>
                {isAdmin ? (cap.editing ? (
                  <div className="pp-cap-edit">
                    <span className="pp-input"><input type="number" min={1} max={2000} value={cap.draft} onChange={(e) => setCap({ ...cap, draft: e.target.value })} aria-label={L("الحد الأقصى للملصقات في المهمة", "Maximum labels per job")} data-testid="print-cap-input" /><span className="pp-unit">1–2000</span></span>
                    <Btn size="sm" variant="primary" onClick={saveCap} disabled={cap.draft === String(cap.value)} data-testid="print-cap-save">{L("حفظ", "Save")}</Btn>
                    <Btn size="sm" onClick={() => setCap({ ...cap, draft: String(cap.value), editing: false })}>{L("إلغاء", "Cancel")}</Btn>
                  </div>
                ) : <div className="pp-card-links"><button type="button" onClick={() => setCap({ ...cap, editing: true })} data-testid="print-cap-edit">{L("تعديل", "Edit")}</button></div>) : null}
              </article>
            ) : null}
          </section>

          {edit ? (
            <section className="pp-form" aria-label={edit.id ? L("تعديل الملف", "Edit profile") : L("ملف جديد", "New profile")} data-testid="profile-form">
              <h2>{edit.id ? L("تعديل الملف", "Edit profile") : L("ملف جديد", "New profile")}</h2>
              {ro ? <span className="hr-caption" data-testid="profile-readonly-note">{current?.isPreset ? L("نقطة بداية للقراءة فقط — انسخها لتعديل القيم.", "A read-only starting point — duplicate it to change the values.") : L("للقراءة فقط.", "Read only.")}</span> : null}
              <label className="pp-field"><span className="pp-label">{L("الاسم", "Name")}</span>
                <input className="hr-input" value={ro && current ? name(current) : edit.draft.name} maxLength={PROFILE_LIMITS.nameMax} disabled={ro} onChange={(e) => set("name", e.target.value)} aria-invalid={errs("name").length > 0} data-field="name" />
                {errs("name").length ? <span className="hr-err">{L("الاسم مطلوب (حتى 80 حرفًا).", "A name is required (up to 80 characters).")}</span> : null}
              </label>
              <label className="pp-field"><span className="pp-label">{L("النوع", "Type")}</span>
                <Select className="hr-select" value={edit.draft.kind} disabled={ro} onChange={(e) => set("kind", e.target.value)} data-field="kind">
                  {PROFILE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k][lang === "ar" ? 0 : 1]}</option>)}
                </Select></label>
              <div className="pp-pairs">
                <div className="pp-field"><span className="pp-label">{L("الورق (العرض × الارتفاع)", "Paper (width × height)")}</span>
                  <div className="pp-pair">{num("paperWidthMm", mm, L("عرض الورق", "Paper width"))}{thermal ? <UnitInput field="paperHeightMm" value="" unit={mm} label={L("طول الورق — لفافة: طول ملصق واحد", "Paper length — roll: one label")} onChange={() => {}} invalid={false} disabled placeholder="—" /> : num("paperHeightMm", mm, L("ارتفاع الورق", "Paper height"))}</div>{errLine(["paperWidthMm", "paperHeightMm"])}</div>
                <div className="pp-field"><span className="pp-label">{L("الملصق (العرض × الارتفاع)", "Label (width × height)")}</span>
                  <div className="pp-pair">{num("labelWidthMm", mm, L("عرض الملصق", "Label width"))}{num("labelHeightMm", mm, L("ارتفاع الملصق", "Label height"))}</div>{errLine(["labelWidthMm", "labelHeightMm"])}</div>
              </div>
              <div className="pp-field"><span className="pp-label">{L("الهوامش (أعلى · يمين · أسفل · يسار)", "Margins (top · right · bottom · left)")}</span>
                <div className="pp-quad">{num("marginTopMm", mm, L("الهامش العلوي", "Top margin"))}{num("marginRightMm", mm, L("الهامش الأيمن", "Right margin"))}{num("marginBottomMm", mm, L("الهامش السفلي", "Bottom margin"))}{num("marginLeftMm", mm, L("الهامش الأيسر", "Left margin"))}</div>
                {errLine(["marginTopMm", "marginRightMm", "marginBottomMm", "marginLeftMm"])}</div>
              <div className="pp-pairs">
                <div className="pp-field"><span className="pp-label">{L("الفواصل (أفقي · عمودي)", "Gaps (horizontal · vertical)")}</span>
                  <div className="pp-pair">{num("gapXMm", mm, L("الفاصل الأفقي", "Horizontal gap"))}{num("gapYMm", mm, L("الفاصل العمودي", "Vertical gap"))}</div>{errLine(["gapXMm", "gapYMm"])}</div>
                <div className="pp-field"><span className="pp-label">{L("الأعمدة × الصفوف", "Columns × rows")}</span>
                  <div className="pp-pair">{num("columns", undefined, L("الأعمدة", "Columns"), { step: "1" })}{thermal ? <UnitInput field="rows" value="" label={L("الصفوف — لفافة: ملصق في كل صف", "Rows — roll: one label per row")} onChange={() => {}} invalid={false} disabled placeholder="—" /> : num("rows", undefined, L("الصفوف", "Rows"), { step: "1" })}</div>{errLine(["columns", "rows"])}</div>
              </div>
              <div className="pp-triple">
                <div className="pp-field"><span className="pp-label" id="pp-orient">{L("الاتجاه", "Orientation")}</span>
                  <div className="pd-seg pp-seg" role="group" aria-labelledby="pp-orient" data-testid="profile-orientation">
                    {(["PORTRAIT", "LANDSCAPE"] as const).map((o) => <button key={o} type="button" aria-pressed={edit.draft.orientation === o} disabled={ro} data-key={o} onClick={() => set("orientation", o)}>{o === "PORTRAIT" ? L("عمودي", "Portrait") : L("أفقي", "Landscape")}</button>)}
                  </div></div>
                <div className="pp-field"><span className="pp-label">{L("المقياس", "Scale")}</span>{num("scalePct", "%", L("المقياس", "Scale"), { step: "1" })}{errLine(["scalePct"])}</div>
                <div className="pp-field"><span className="pp-label">{L("الدقة (للحرارية)", "Resolution (thermal)")}</span>
                  {thermal ? num("dpi", "dpi", L("الدقة المعلنة", "Declared resolution"), { step: "1" })
                    : <UnitInput field="dpi" value="" unit="dpi" label={L("الدقة — للطابعات الحرارية فقط", "Resolution — thermal printers only")} onChange={() => {}} invalid={false} disabled placeholder="—" />}
                  {errLine(["dpi"])}</div>
              </div>
              <div className="pp-field"><span className="pp-label">{L("معايرة الإزاحة (أفقي · عمودي)", "Calibration offset (x · y)")}</span>
                <div className="pp-pair">{num("offsetXMm", mm, L("معايرة أفقية", "Calibration X"), { step: "0.1" })}{num("offsetYMm", mm, L("معايرة رأسية", "Calibration Y"), { step: "0.1" })}</div>{errLine(["offsetXMm", "offsetYMm", "defaultStartSlot", "defaultCopies"])}</div>

              {fit ? (
                // 1652:10127 (passed), 1661:14509 (failed: Save disabled, Duplicate stays), 1661:14636 (roll).
                <div className={`pp-dim${fit.width.ok && fit.height.ok ? "" : " is-bad"}`} data-testid={fit.width.ok && fit.height.ok ? "fit-ok" : "err-grid"}>
                  <span>{fit.width.ok && fit.height.ok ? L("التحقق من الأبعاد", "Dimension check")
                    : !fit.width.ok ? L("لا يمكن الحفظ: مجموع العروض أكبر من الورقة", "Can’t save: the widths add up to more than the paper")
                    : L("لا يمكن الحفظ: مجموع الارتفاعات أكبر من الورقة", "Can’t save: the heights add up to more than the paper")}</span>
                  <span className={fit.width.ok ? "is-ok" : undefined}><bdi dir="ltr" className="hr-num">{fit.width.display}</bdi>{thermal ? <> {L("(عرض اللفافة)", "(liner width)")}</> : null}</span>
                  {thermal
                    ? <span className="is-ok">{L("الطول: ملصق", "Length:")} <bdi dir="ltr" className="hr-num">{`${edit.draft.labelHeightMm} mm`}</bdi> {L("+ فاصل", "label +")} <bdi dir="ltr" className="hr-num">{`${edit.draft.gapYMm} mm`}</bdi> {L("لكل ملصق · كشف الفاصل في المشغّل", "gap per label · gap detection in the driver")}</span>
                    : <span className={fit.height.ok ? "is-ok" : undefined}><bdi dir="ltr" className="hr-num">{fit.height.display}</bdi></span>}
                </div>
              ) : null}
              <div className="pp-a8" data-testid="profile-a8">
                <strong>{L("الاعتماد الفعلي (A-8): مفتوح", "Physical certification (A-8): open")}</strong>
                <span>{L("لم يُختبر على طابعة فعلية. عند الاختبار يُسجَّل: الطراز، المشغّل، النظام، المتصفح، الورق، والنتيجة.", "Not tested on a real printer. When tested, record model, driver, OS, browser, stock and result.")}</span>
              </div>
              {certified === false ? <PrintNotCertifiedNotice /> : null}
              <div className="pp-actions">
                {!ro ? <Btn variant="primary" disabled={!local?.ok} onClick={save} data-testid="profile-save">{L("حفظ", "Save")}</Btn> : null}
                {canManage ? <Btn disabled={!local?.ok && !current} onClick={() => (current && (ro || !local?.ok) ? duplicate(current) : duplicateAsNew())} data-testid="profile-duplicate-new">{L("نسخ كملف جديد", "Duplicate as new")}</Btn> : null}
                <Btn disabled={!draftProfile || certified !== true} aria-describedby={certified === false ? PRINT_GATE_NOTE_ID : undefined} onClick={() => draftProfile && calibrate({ ...draftProfile, title: edit.draft.name })} data-testid="profile-calibrate">{L("طباعة صفحة معايرة", "Print calibration page")}</Btn>
                {current && current.canEdit && !current.isPreset ? <Btn variant="danger" className="pp-delete" onClick={() => setConfirmDel(current)} data-testid="profile-delete">{L("حذف", "Delete")}</Btn> : null}
              </div>
            </section>
          ) : <section className="pp-form"><span className="hr-caption">{L("اختر ملفًا لعرضه.", "Choose a profile to view it.")}</span></section>}

          <aside className="pp-scale" aria-label={L("المخطط بالمقياس", "Layout to scale")}>
            <h3>{L("المخطط بالمقياس", "Layout to scale")}</h3>
            <LayoutToScale p={draftProfile} />
          </aside>
        </div>
      )}

      {calib ? (
        <PrintPortal profile={calib} onReady={onCalibReady}>
          <div className="pl-page" dir="ltr" style={{ width: `${pageSize(calib).w}mm`, height: `${pageSize(calib).h}mm` }}>
            <CalibrationSvg profile={calib} title={calib.title} />
          </div>
        </PrintPortal>
      ) : null}

      <Dialog open={!!confirmDel} title={L("حذف الملف؟", "Delete the profile?")} onClose={() => setConfirmDel(null)} closeLabel={L("إغلاق", "Close")}
        actions={<><Btn variant="danger" onClick={() => confirmDel && remove(confirmDel)} data-testid="profile-delete-confirm">{L("حذف", "Delete")}</Btn><Btn onClick={() => setConfirmDel(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <p style={{ margin: 0 }}>{confirmDel?.name} — {L("الإعدادات المحفوظة التي تستخدمه تبقى بلا ملف. يُسجّل الحذف في سجل الطباعة.", "Saved presets that use it keep their fields without a profile. The deletion is recorded in the print audit.")}</p>
      </Dialog>
    </div>
  );
}
