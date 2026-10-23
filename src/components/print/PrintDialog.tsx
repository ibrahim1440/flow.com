"use client";
/**
 * G-21 print summary dialog, expanded per B-1 (Figma 1647:5816 / 1647:7174 at 1440,
 * 1649:7798 / 1649:8148 at 1024, bottom sheet 1650:8158 / 1650:8405 at 390): template, paper &
 * printer profile, language, copies with totals, start slot, traceability, fields, warnings,
 * guidance and a live preview — then an authorized, audited print job and the browser's own
 * print dialog. Every value printed comes from the server; this component never builds label text
 * from anything but the API response.
 */
import { Select } from "@/components/ui/Select";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Btn, Dialog, Notice } from "@/components/hr/ui";
import { countNoun, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";
import { dimText, dpiText, hasArabic, type PrintLang } from "@/lib/print/bidi";
import { BLOCKING_CODES, type LabelData, type PrintWarning, type WarningCode } from "@/lib/print/content";
import { itemRef, type ItemIn } from "@/lib/print/items";
import { jobTotals, layoutWarnings, paginate, pageSize, perPage, validateJob, type LayoutError } from "@/lib/print/layout";
import { LOGO_MIN_HEIGHT_MM } from "@/lib/print/logo";
import { profileDisplayName, usesStartSlot, type PrintProfileData } from "@/lib/print/profiles";
import { FIELD_DEFS, TEMPLATES, defaultFields, defaultNotesLines, normalizeFields, notesMaxLines, sizeClass, type FieldConfig, type FieldKey, type TemplateKey } from "@/lib/print/templates";
import { mmToCssPx } from "@/lib/print/units";
import { PRINT_NOT_CERTIFIED_CODE, PRINT_NOT_CERTIFIED_MESSAGE } from "@/lib/print/certification";
import { LabelView, type LabelOptions } from "./LabelView";
import { PrintRoot, SheetPage } from "./SheetView";
import "./print.css";

export type DialogItem =
  // `batch`: a roasting batch the caller already knows (the roasting station's recorded screen):
  // traceability starts on with that batch selected; the server still checks it belongs to the coffee.
  | { kind: "product"; productId: string; label: string; batch?: { id: string; batchNumber: string } | null }
  | { kind: "cup"; sessionId: string; cupId: string | null; label: string };

type Profile = PrintProfileData & { canEdit?: boolean };
type Preset = { id: string; name: string; templateKey: TemplateKey; language: PrintLang; fields: unknown; notesMaxLines: number | null; showLogo: boolean; profileId: string | null; canEdit: boolean };
type NotesMode = "shared" | "scorer" | "both" | "none";
type Trace = { batchId?: string | null; lotId?: string | null; text?: string };
type Related = { batches: { id: string; batchNumber: string; roastDate: string | null }[]; lots: { id: string; batchNumber: string; packedDate: string | null; skuCode: string | null; batchId: string | null; roastDate: string | null }[] };

const LABEL_FORMS: [string, string, string, string, string, string] = ["ملصق واحد", "ملصقان", "ملصقات", "ملصقًا", "label", "labels"];
const SHEET_FORMS: [string, string, string, string, string, string] = ["ورقة واحدة", "ورقتان", "أوراق", "ورقة", "sheet", "sheets"];
const LRI = "⁦", PDI = "⁩";
const iso = (s: string) => `${LRI}${s}${PDI}`;
/** The server's refusal text, localized when it is the print certification gate (409 PRINTING_NOT_CERTIFIED). */
const refusal = (b: { error?: string; code?: string } | undefined, L: (ar: string, en: string) => string, status?: number) =>
  b?.code === PRINT_NOT_CERTIFIED_CODE ? L(PRINT_NOT_CERTIFIED_MESSAGE.ar, PRINT_NOT_CERTIFIED_MESSAGE.en) : b?.error ?? (status ? `HTTP ${status}` : undefined);

async function api<T>(url: string, init?: { method?: string; json?: unknown; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; body: T & { error?: string; code?: string } }> {
  const res = await fetch(url, {
    method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    signal: init?.signal,
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function Stepper({ value, onChange, min = 1, max, label }: { value: number; onChange: (v: number) => void; min?: number; max: number; label: string }) {
  return (
    <span className="pd-stepper" role="group" aria-label={label}>
      <button type="button" aria-label="−" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <input type="number" inputMode="numeric" min={min} max={max} value={value} aria-label={label}
        onChange={(e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v))); }} />
      <button type="button" aria-label="+" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </span>
  );
}

function Seg<K extends string>({ items, value, onChange, label, testId }: { items: { key: K; label: ReactNode; disabled?: boolean }[]; value: K; onChange: (k: K) => void; label: string; testId?: string }) {
  return (
    <div className="pd-seg" role="group" aria-label={label} data-testid={testId}>
      {items.map((it) => (
        <button key={it.key} type="button" aria-pressed={value === it.key} disabled={it.disabled} onClick={() => onChange(it.key)} data-key={it.key}>{it.label}</button>
      ))}
    </div>
  );
}

/** Searchable batch / lot selector limited to the coffee of the label (B-7). */
function BatchPicker({ productId, label, value, onChange }: { productId: string; label: string; value: Trace | undefined; onChange: (t: Trace | null) => void }) {
  const L = useL();
  const [q, setQ] = useState("");
  const [data, setData] = useState<Related | null>(null);
  const [err, setErr] = useState<{ body: { error?: string; code?: string }; status: number } | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      api<Related>(`/api/print/related?productId=${encodeURIComponent(productId)}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`, { signal: ac.signal })
        .then((r) => { if (r.ok) { setData(r.body); setErr(null); } else setErr({ body: r.body, status: r.status }); })
        .catch(() => {});
    }, 200);
    return () => { clearTimeout(t); ac.abort(); };
  }, [productId, q]);
  const options = [
    ...(data?.batches ?? []).map((b) => ({ key: `b:${b.id}`, t: { batchId: b.id, lotId: null, text: `${b.batchNumber} · ${b.roastDate ?? "—"}` }, text: `${b.batchNumber} · ${b.roastDate ?? "—"}`, kind: L("دفعة تحميص", "Roasting batch") })),
    ...(data?.lots ?? []).map((l) => ({ key: `l:${l.id}`, t: { batchId: null, lotId: l.id, text: `${l.batchNumber} · ${l.skuCode ?? ""} · ${l.packedDate ?? "—"}` }, text: `${l.batchNumber}${l.skuCode ? ` · ${l.skuCode}` : ""} · ${l.packedDate ?? "—"}`, kind: L("لوت معبأ", "Packed lot") })),
  ];
  const cur = value?.lotId ? `l:${value.lotId}` : value?.batchId ? `b:${value.batchId}` : null;
  return (
    <div className="pd-sel" data-testid={`batch-picker-${productId}`}>
      <span className="hr-label">{L("الدفعة", "Batch")} · {label}</span>
      <input className="hr-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("ابحث برقم الدفعة", "Search by batch number")} aria-label={`${L("ابحث عن دفعة", "Search batches")} · ${label}`} />
      {err ? <span className="hr-caption">{refusal(err.body, L, err.status)}</span> : null}
      <ul className="pd-sel-list">
        {options.length === 0 && data ? <li className="hr-caption" style={{ padding: 6 }}>{L("لا توجد دفعات مسجلة لهذا المنتج.", "No recorded batches for this coffee.")}</li> : null}
        {options.map((o) => (
          <li key={o.key}>
            <button type="button" aria-pressed={cur === o.key} onClick={() => onChange(cur === o.key ? null : o.t)}>
              <bdi dir="ltr" className="hr-num">{o.text}</bdi> <span className="hr-caption">· {o.kind}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PrintDialog({ open, onClose, items, initialTemplate, subtitle, onPrinted }: {
  open: boolean; onClose: () => void; items: DialogItem[]; initialTemplate: TemplateKey; subtitle?: string; onPrinted?: (jobId: string) => void;
}) {
  const L = useL();
  const { lang: uiLang } = useI18n();
  const template = initialTemplate;
  const [meta, setMeta] = useState<{ profiles: Profile[]; canManage: boolean; presets: Preset[]; canManagePresets: boolean; maxLabels: number } | null>(null);
  const [metaErr, setMetaErr] = useState<{ status: number; message: string } | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [lang, setLang] = useState<PrintLang>("BI");
  const [copies, setCopies] = useState<number[]>(() => items.map(() => 1));
  const [copiesTouched, setCopiesTouched] = useState(false);
  const [startSlot, setStartSlot] = useState(1);
  const [fields, setFields] = useState<FieldConfig>(() => defaultFields(template));
  // Notes mode (cupping): the template / preset sets the default; the dialog may override it for
  // this job only, and the override is recorded in the job's audit row.
  const notesModeOf = (f: FieldConfig): NotesMode => (f.some((x) => x.key === "scorerNotes" && x.show) ? (f.some((x) => x.key === "sharedNotes" && x.show) ? "both" : "scorer") : f.some((x) => x.key === "sharedNotes" && x.show) ? "shared" : "none");
  const [notesDefault, setNotesDefault] = useState<NotesMode>(() => notesModeOf(defaultFields(template)));
  const [notesLines, setNotesLines] = useState<number | null>(null);
  // Traceability follows the template's batch / roast-date fields (Cupping Results prints them by default).
  const [traceOn, setTraceOn] = useState(() => defaultFields(template).some((f) => f.key === "roastDate" && f.show) || items.some((it) => it.kind === "product" && !!it.batch));
  const [trace, setTrace] = useState<Record<string, Trace>>(() => Object.fromEntries(items.flatMap((it) => (it.kind === "product" && it.batch ? [[it.productId, { batchId: it.batch.id, lotId: null, text: it.batch.batchNumber }]] : []))));
  const [preview, setPreview] = useState<{ labels: LabelData[]; warnings: PrintWarning[] } | null>(null);
  const [previewErr, setPreviewErr] = useState<{ code?: string; message: string; totals?: { labels: number; pages: number } } | null>(null);
  const [page, setPage] = useState(0);
  const [actual, setActual] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showFields, setShowFields] = useState(false);
  const [measured, setMeasured] = useState<{ overflow: string[]; clamped: string[] }>({ overflow: [], clamped: [] });
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [printErr, setPrintErr] = useState<string | null>(null);
  const [job, setJob] = useState<{ id: string; labels: LabelData[] } | null>(null);
  const [presetName, setPresetName] = useState("");
  // The applied saved preset: the server authorizes named scorers only through one (decision 2.1).
  const [presetId, setPresetId] = useState<string | null>(null);
  const [presetMsg, setPresetMsg] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(400);

  // ── Meta: profiles, presets, job cap (server-authorized) ──────────────────────────
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      const [p, s, pr] = await Promise.all([api<{ profiles: Profile[]; canManage: boolean }>("/api/print/profiles"), api<{ maxLabelsPerJob: number }>("/api/print/settings"), api<{ presets: Preset[]; canManage: boolean }>("/api/print/presets")]);
      if (!alive) return;
      if (!p.ok || !s.ok) { setMetaErr({ status: p.ok ? s.status : p.status, message: (p.ok ? s : p).body.error ?? "" }); return; }
      setMeta({ profiles: p.body.profiles, canManage: p.body.canManage, presets: pr.ok ? pr.body.presets : [], canManagePresets: pr.ok ? pr.body.canManage : false, maxLabels: s.body.maxLabelsPerJob });
      const want = template === "CUPPING_RESULTS" ? "THERMAL_100x70" : "A4_L7165";
      const def = p.body.profiles.find((x) => x.presetKey === want) ?? p.body.profiles[0];
      setProfileId((cur) => cur ?? def?.id ?? null);
    })().catch((e) => alive && setMetaErr({ status: 0, message: String(e) }));
    return () => { alive = false; };
  }, [open, template]);

  const profile = meta?.profiles.find((p) => p.id === profileId) ?? null;

  // Profile defaults (copies, start slot) apply until the user changes them.
  useEffect(() => {
    if (!profile) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived defaults when the profile changes
    setStartSlot(usesStartSlot(profile) ? profile.defaultStartSlot : 1);
    if (!copiesTouched) setCopies(items.map(() => profile.defaultCopies));
    setPage(0);
  }, [profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const effFields = useMemo<FieldConfig>(() => fields.map((f) => (f.key === "roastDate" || f.key === "batchNumber" ? { ...f, show: traceOn } : f)), [fields, traceOn]);

  const reqItems: ItemIn[] = useMemo(() => items.map((it, i) => (it.kind === "product"
    ? { kind: "product", productId: it.productId, batchId: traceOn ? trace[it.productId]?.batchId ?? null : null, lotId: traceOn ? trace[it.productId]?.lotId ?? null : null, copies: copies[i] ?? 1 }
    : { kind: "cup", sessionId: it.sessionId, cupId: it.cupId, copies: copies[i] ?? 1 })), [items, copies, trace, traceOn]);

  const jobItems = useMemo(() => reqItems.map((it) => ({ ref: itemRef(it), copies: it.copies })), [reqItems]);
  const layoutErrors: LayoutError[] = profile && meta ? validateJob(profile, jobItems, startSlot, meta.maxLabels) : [];
  const totals = profile ? jobTotals(profile, jobItems, usesStartSlot(profile) ? startSlot : 1) : null;
  const pages = useMemo(() => (profile && layoutErrors.length === 0 ? paginate(profile, jobItems, usesStartSlot(profile) ? startSlot : 1) : []), [profile, jobItems, startSlot, layoutErrors.length]);

  // ── Preview data from the server (debounced) ─────────────────────────────────────
  const notesMode = notesModeOf(fields);
  const notesOverridden = template === "CUPPING_RESULTS" && notesMode !== notesDefault;
  const setNotesMode = (m: NotesMode) => setFields((all) => all.map((x) => (x.key === "sharedNotes" ? { ...x, show: m === "shared" || m === "both" } : x.key === "scorerNotes" ? { ...x, show: m === "scorer" || m === "both" } : x)));
  const body = useMemo(() => profile ? { template, language: lang, profileId: profile.id, startSlot: usesStartSlot(profile) ? startSlot : 1, items: reqItems, fields: effFields, notesLines, presetId, options: { notesMode, notesModeDefault: notesDefault } } : null, [template, lang, profile, startSlot, reqItems, effFields, notesLines, presetId, notesMode, notesDefault]);
  const bodyKey = JSON.stringify(body);
  useEffect(() => {
    if (!open || !body) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      api<{ labels: LabelData[]; warnings: PrintWarning[]; totals: { labels: number; pages: number } }>("/api/print/label-data", { json: body, signal: ac.signal })
        .then((r) => {
          if (r.ok) { setPreview({ labels: r.body.labels, warnings: r.body.warnings }); setPreviewErr(null); }
          else setPreviewErr({ code: r.body.code, message: refusal(r.body, L, r.status) ?? "", totals: (r.body as { totals?: { labels: number; pages: number } }).totals });
        })
        .catch(() => {});
    }, 200);
    return () => { clearTimeout(t); ac.abort(); };
  }, [open, bodyKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const byRef = useMemo(() => new Map((preview?.labels ?? []).map((l) => [l.ref, l])), [preview]);
  const opts: LabelOptions = { template, lang, fields: effFields, notesLines };
  const label = profile ? { w: profile.labelWidthMm * profile.scalePct / 100, h: profile.labelHeightMm * profile.scalePct / 100 } : { w: 100, h: 70 };
  const cls = sizeClass(label.w, label.h);

  // ── Preview stage width → scale ──────────────────────────────────────────────────
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageW(el.clientWidth));
    ro.observe(el);
    setStageW(el.clientWidth);
    return () => ro.disconnect();
  }, [open, meta]);
  const paperPx = profile ? mmToCssPx(pageSize(profile).w) : 1;
  const scale = actual ? 1 : Math.min(1, stageW / paperPx);
  // Cupping results on a sheet: the labels stack at ≤ 90 % (1664:182033); Origin shows the sheet.
  const stacked = !!profile && template === "CUPPING_RESULTS" && usesStartSlot(profile);
  const stackScale = actual ? 1 : Math.min(0.9, (stageW - 2) / mmToCssPx(label.w));
  const stackedRefs = useMemo(() => pages.flatMap((pg) => pg.slots.map((s) => s.ref).filter((r): r is string => !!r)), [pages]);
  const sheetName = profile ? `${pageSize(profile).w === 210 && pageSize(profile).h === 297 ? "A4" : dimText(pageSize(profile).w, pageSize(profile).h)} · ${perPage(profile)}` : "";

  // ── Measure the rendered labels: overflow (does not fit) and CSS clamping ────────
  useLayoutEffect(() => {
    const host = measureRef.current;
    if (!host || !preview) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const overflow: string[] = [], clamped: string[] = [];
      host.querySelectorAll<HTMLElement>("[data-label-ref]").forEach((el) => {
        const ref = el.dataset.labelRef!;
        const inner = el.querySelector<HTMLElement>(".pl-inner");
        if (inner && (inner.scrollHeight > inner.clientHeight + 1 || inner.scrollWidth > inner.clientWidth + 1)) overflow.push(ref);
        el.querySelectorAll<HTMLElement>(".is-notes .pl-v, .pl-c-notes").forEach((n) => { if (n.scrollHeight > n.clientHeight + 1) clamped.push(ref); });
      });
      setMeasured({ overflow: [...new Set(overflow)], clamped: [...new Set(clamped)] });
    };
    run();
    document.fonts?.ready.then(run);
    return () => { cancelled = true; };
  }, [preview, bodyKey]);

  const warnings: PrintWarning[] = useMemo(() => {
    const w = [...(preview?.warnings ?? [])];
    for (const r of measured.overflow) w.push({ code: "DOES_NOT_FIT", ref: r });
    for (const r of measured.clamped) if (!w.some((x) => x.code === "NOTES_TRUNCATED" && x.ref === r)) w.push({ code: "NOTES_TRUNCATED", ref: r });
    return w;
  }, [preview, measured]);
  const has = (c: WarningCode) => warnings.some((w) => w.code === c);
  const blocked = warnings.some((w) => BLOCKING_CODES.includes(w.code));
  const needsAck = has("DOES_NOT_FIT");
  const nameOf = (ref?: string) => {
    const d = ref ? byRef.get(ref) : null;
    if (!d) return "";
    const n = (uiLang === "ar" ? d.name.ar ?? d.name.en : d.name.en ?? d.name.ar) ?? "—";
    return d.kind === "cup" && d.cupNo ? `${L("كوب", "Cup")} ${d.cupNo} · ${n}` : n;
  };

  // ── Print: authorize + audit on the server, then the browser print dialog ───────
  const doPrint = useCallback(async () => {
    if (!body) return;
    setBusy(true); setPrintErr(null);
    const r = await api<{ jobId: string; labels: LabelData[] }>("/api/print/jobs", { json: { ...body, warnings: warnings.map((w) => w.code) } }).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) { setPrintErr(refusal(r?.body, L) ?? L("تعذّر بدء الطباعة.", "Printing could not start.")); return; }
    setJob({ id: r.body.jobId, labels: r.body.labels });
  }, [body, warnings, L]);

  const onReady = useCallback(() => {
    const done = () => {
      window.removeEventListener("afterprint", done);
      const id = job?.id;
      setJob(null);
      if (id) onPrinted?.(id);
    };
    window.addEventListener("afterprint", done);
    window.print();
  }, [job, onPrinted]);

  const savePreset = async () => {
    setPresetMsg(null);
    const r = await api<Preset>("/api/print/presets", { json: { name: presetName, templateKey: template, language: lang, fields: effFields, notesMaxLines: notesLines, showLogo: true, profileId } });
    if (r.ok) { setMeta((m) => (m ? { ...m, presets: [...m.presets, r.body] } : m)); setPresetName(""); setPresetMsg(L("حُفظ الإعداد.", "Preset saved.")); }
    else setPresetMsg(r.body.error ?? `HTTP ${r.status}`);
  };
  const applyPreset = (id: string) => {
    const p = meta?.presets.find((x) => x.id === id);
    setPresetId(p ? p.id : null);
    if (!p) return;
    setLang(p.language);
    const f = normalizeFields(template, p.fields);
    setFields(f);
    setNotesDefault(notesModeOf(f));
    setTraceOn(f.some((x) => x.key === "roastDate" && x.show));
    setNotesLines(p.notesMaxLines);
    if (p.profileId && meta?.profiles.some((x) => x.id === p.profileId)) setProfileId(p.profileId);
  };

  const n = totals?.labels ?? 0;
  const title = `${L("طباعة", "Print")} ${countNoun(n, uiLang, LABEL_FORMS)}${template === "CUPPING_RESULTS" ? ` · ${L("نتائج التذوق", "Cupping results")}` : ""}`;

  if (!open) return null;

  // Unauthorized (B-9): the server refused the print metadata.
  if (metaErr) {
    return (
      <Dialog open title={L("طباعة الملصقات", "Print labels")} onClose={onClose} closeLabel={L("إغلاق", "Close")} className="pd-dialog" testId="print-dialog"
        actions={<Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn>}>
        <Notice tone={metaErr.status === 403 || metaErr.status === 401 ? "warning" : "danger"}>
          <span data-testid="print-denied">
            {metaErr.status === 403 || metaErr.status === 401
              ? L("لا تملك صلاحية طباعة الملصقات (labels.print). اطلبها من المسؤول.", "You don't have permission to print labels (labels.print). Ask an administrator.")
              : `${L("تعذّر التحميل.", "Could not load.")} ${metaErr.message}`}
          </span>
        </Notice>
      </Dialog>
    );
  }

  const roll = profile ? !usesStartSlot(profile) && perPage(profile) === 1 : false;
  const totalText = totals ? (roll
    ? `${L("المجموع", "Total")}: ${countNoun(totals.labels, uiLang, LABEL_FORMS)} ${profile?.kind === "THERMAL_ROLL" ? L("على اللفافة", "on the roll") : ""}`
    : `${L("المجموع", "Total")}: ${countNoun(totals.labels, uiLang, LABEL_FORMS)} · ${countNoun(totals.pages, uiLang, SHEET_FORMS)}${usesStartSlot(profile!) ? ` · ${L("الخانات", "slots")} ${startSlot} ${L("إلى", "to")} ${Math.min(perPage(profile!), startSlot - 1 + totals.labels)}` : ""}`) : "";
  const tooLarge = layoutErrors.find((e) => e.code === "TOO_MANY_LABELS" || e.code === "TOO_MANY_PAGES" || e.code === "TOO_MANY_ITEMS");
  const truncatedRef = warnings.find((w) => w.code === "NOTES_TRUNCATED")?.ref ?? preview?.labels[0]?.ref;

  const canPrint = !!profile && !!preview && !previewErr && layoutErrors.length === 0 && !blocked && (!needsAck || ack) && !busy;

  return (
    <>
      <Dialog open title={title} sub={subtitle} onClose={onClose} closeLabel={L("إغلاق", "Close")} className="pd-dialog" testId="print-dialog"
        actions={<>
          <Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn>
          <Btn variant="primary" onClick={doPrint} disabled={!canPrint} busy={busy} data-testid="print-submit">{L("طباعة", "Print")}</Btn>
          <span className="pd-audit" data-testid="pd-audit">{L("تُسجَّل أوامر الطباعة المحمية في سجل التدقيق.", "Protected print jobs are recorded in the audit log.")}</span>
        </>}>
        {!meta || !profile ? <span className="hr-caption">{L("جارٍ التحميل…", "Loading…")}</span> : (
          <div className="pd-grid">
            <div className="pd-opts">
              <section className="pd-sec">
                <h3>{L("القالب", "Template")}</h3>
                <Seg label={L("القالب", "Template")} value={template} onChange={() => {}} testId="pd-template"
                  items={[{ key: "COFFEE_ORIGIN", label: L("منشأ القهوة", "Coffee origin"), disabled: template !== "COFFEE_ORIGIN" }, { key: "CUPPING_RESULTS", label: L("نتائج التذوق", "Cupping results"), disabled: template !== "CUPPING_RESULTS" }]} />
                {template === "COFFEE_ORIGIN" ? <span className="hr-caption">{L("«نتائج التذوق» متاحة عند الطباعة من نتائج جلسة تذوق.", "“Cupping results” is available when printing from a cupping session’s results.")}</span> : null}
              </section>

              <section className="pd-sec">
                <h3><label htmlFor="pd-profile">{L("الورق وملف الطابعة", "Paper & printer profile")}</label></h3>
                <Select id="pd-profile" className="hr-select" value={profile.id} onChange={(e) => setProfileId(e.target.value)} data-testid="pd-profile">
                  {meta.profiles.map((p) => { const nm = profileDisplayName(p, uiLang === "ar" ? "ar" : "en"); return <option key={p.id} value={p.id}>{hasArabic(nm) ? nm : iso(nm)} · {iso(dimText(p.labelWidthMm, p.labelHeightMm))}</option>; })}
                </Select>
                <a className="ops-link hr-caption" href="/dashboard/labels/profiles" style={{ width: "fit-content" }}>{L("إدارة الملفات", "Manage profiles")}</a>
                {layoutWarnings(profile).includes("SCALE_NOT_100") ? <Notice tone="warning">{L("مقياس الملف ليس 100٪ — الملصقات ستُطبع بغير مقاسها الفعلي.", "The profile scale is not 100 % — labels will not print at actual size.")}</Notice> : null}
                {layoutWarnings(profile).includes("GRID_OFF_PAPER") ? <Notice tone="danger">{L("الإزاحة أو المقياس تُخرج الملصقات عن الورقة.", "Offset or scale pushes labels off the paper.")}</Notice> : null}
              </section>

              <section className="pd-sec">
                <h3>{L("اللغة", "Language")}</h3>
                <Seg label={L("اللغة", "Language")} value={lang} onChange={setLang} testId="pd-lang"
                  items={[{ key: "AR", label: "عربي" }, { key: "EN", label: "English" }, { key: "BI", label: L("ثنائي اللغة", "Bilingual") }]} />
              </section>

              {/* 1664:182033: the warnings sit under the language, then the guest note and notes mode. */}
              <Warnings warnings={warnings} nameOf={nameOf} lang={lang} cls={cls} template={template} labelDims={dimText(label.w, label.h)} lines={notesMaxLines(cls, notesLines, lang)} onExpand={() => setExpanded(true)} />
              {needsAck ? (
                <label className="pd-switch" data-testid="pd-ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />{L("أفهم أن بعض المحتوى لا يتسع وأريد الطباعة رغم ذلك.", "I understand some content does not fit and want to print anyway.")}</label>
              ) : null}

              {template === "CUPPING_RESULTS" ? (
                <>
                  <div className="pd-note" data-testid="pd-guest-note">{L("ملاحظات الضيوف متاحة في التطبيق فقط — لا تُطبع على ملصقات النتائج.", "Guest feedback is available in the app only — it is never printed on results labels.")}</div>
                  <section className="pd-sec" data-testid="pd-notes-mode">
                    <h3><label htmlFor="pd-notes-select">{L("وضع الإيحاءات", "Notes mode")}</label></h3>
                    <Select id="pd-notes-select" className={`hr-select${notesOverridden ? " pd-changed" : ""}`} value={notesMode} onChange={(e) => setNotesMode(e.target.value as NotesMode)} data-testid="pd-notes-select">
                      <option value="shared">{L("المشتركة (القاعدة المعتمدة)", "Shared (approved rule)")}</option>
                      <option value="scorer">{L("لكل مقيّم", "Per scorer")}</option>
                      {notesMode === "both" || notesDefault === "both" ? <option value="both">{L("المشتركة ولكل مقيّم", "Shared and per scorer")}</option> : null}
                      <option value="none">{L("بلا إيحاءات", "None")}</option>
                    </Select>
                    {notesOverridden ? (
                      <div className="pd-changed-note" data-testid="pd-notes-changed">
                        <span className="pd-changed-mark">{L("تغيّرت لهذه المهمة", "Changed for this job")}</span>
                        <span className="hr-caption">{L("افتراضي القالب", "Template default")}: {notesDefault === "shared" ? L("المشتركة (القاعدة المعتمدة)", "Shared (approved rule)") : notesDefault === "scorer" ? L("لكل مقيّم", "Per scorer") : notesDefault === "both" ? L("المشتركة ولكل مقيّم", "Shared and per scorer") : L("بلا إيحاءات", "None")}. {L("ينطبق هذا التغيير على هذه المهمة فقط ولا يُحفظ في القالب.", "This change applies to this job only and is not saved to the template.")}</span>
                        <button type="button" className="ops-link pd-linkbtn" onClick={() => setNotesMode(notesDefault)}>{L("استعادة افتراضي القالب", "Restore template default")}</button>
                      </div>
                    ) : <span className="hr-caption">{L("افتراضي القالب. المشتركة: إيحاء سجّله أكثر من نصف المقيّمين المؤهلين واثنان على الأقل؛ المقيّمون بلا أسماء («مقيّم 1»).", "The template default. Shared: a note recorded by more than half of the eligible scorers and by at least two; scorers are anonymous («Scorer 1»).")}</span>}
                  </section>
                </>
              ) : null}

              {cls === "compact" ? (
                <section className="pd-sec" data-testid="pd-compact-fields">
                  <h3>{L("الحقول على الملصق المضغوط", "Fields on the compact label")}</h3>
                  <ol style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 13 }}>
                    {TEMPLATES[template].compact.map((c, i) => {
                      const omitted = c === "notes" && lang === "BI";
                      const txt = c === "name" ? L("الاسم", "Name") : c === "score" ? L("النتيجة النهائية أو حالتها", "Final score or its state") : c === "notes" ? L("الإيحاءات", "Notes") : c === "origin" ? L("سطر المنشأ", "Origin line") : L("الدفعة · تاريخ التحميص", "Batch · roast date");
                      return <li key={c} className={omitted ? "hr-muted" : undefined}><span className="hr-num">{i + 1}.</span> {txt}{omitted ? ` (${L("محذوفة — لا مساحة", "left off — no room")})` : ""}</li>;
                    })}
                    <li className="hr-muted"><span className="hr-num">{TEMPLATES[template].compact.length + 1}.</span> {L("الشعار", "Logo")} ({L("محذوف — غير مقروء بهذا المقاس", "left off — not legible at this size")})</li>
                  </ol>
                </section>
              ) : null}

              <section className="pd-sec">
                <h3>{template === "CUPPING_RESULTS" ? L("النسخ لكل كوب", "Copies per cup") : L("النسخ لكل منتج", "Copies per product")}</h3>
                {items.map((it, i) => (
                  <div className="pd-row" key={i}>
                    <span>{it.kind === "cup" && preview ? nameOf(itemRef(reqItems[i])) || it.label : it.label}</span>
                    <Stepper value={copies[i] ?? 1} max={100} label={`${L("النسخ", "Copies")} · ${it.label}`} onChange={(v) => { setCopiesTouched(true); setCopies((c) => c.map((x, j) => (j === i ? v : x))); }} />
                  </div>
                ))}
                <div className="pd-total" data-testid="pd-total">{totalText}</div>
                <span className="hr-caption">{L("الحد الأقصى", "Maximum")} {meta.maxLabels} {L("ملصقًا لكل مهمة طباعة.", "labels per job.")}</span>
                {tooLarge ? (
                  <Notice tone="danger"><span data-testid="pd-too-large">
                    {L("المهمة أكبر من المسموح", "This job is larger than allowed")}: {countNoun(totals?.labels ?? 0, uiLang, LABEL_FORMS)} · {countNoun(totals?.pages ?? 0, uiLang, SHEET_FORMS)}. {L("الحد", "The limit is")} {meta.maxLabels} {L("ملصقًا لكل مهمة — قلّل النسخ أو قسّم المهمة.", "labels per job — reduce copies or split the job.")}
                  </span></Notice>
                ) : null}
              </section>

              {usesStartSlot(profile) ? (
                <section className="pd-sec">
                  <h3>{L("موضع البدء على الورقة", "Start position on the sheet")}</h3>
                  <div className="pd-slots" style={{ gridTemplateColumns: `repeat(${profile.columns}, auto)` }} role="group" aria-label={L("خانة البدء", "Start slot")} data-testid="pd-slots">
                    {Array.from({ length: perPage(profile) }, (_, i) => i + 1).map((s) => (
                      <button key={s} type="button" className={s < startSlot ? "is-used" : undefined} aria-pressed={s === startSlot} onClick={() => setStartSlot(s)}
                        aria-label={`${L("ابدأ من الخانة", "Start at slot")} ${s}`}>{s < startSlot ? L("مستخدمة", "Used") : s}</button>
                    ))}
                  </div>
                  <span className="hr-caption">{L("اختر أول خانة فارغة. تُملأ الخانات صفًّا صفًّا من أعلى يسار الورقة في اللغتين.", "Click the first empty slot. Slots fill row by row from the top left of the sheet in both languages.")}</span>
                </section>
              ) : null}

              <section className="pd-sec">
                {/* Origin: optional switch + batch selector (1647:7512). Cupping: the per-cup rows from the
                    session record (1664:182033); the batch / roast-date fields switch them on the label. */}
                <h3>{template === "CUPPING_RESULTS" ? L("التتبع", "Traceability") : L("التتبع (اختياري)", "Traceability (optional)")}</h3>
                {template === "COFFEE_ORIGIN" ? <label className="pd-switch"><input type="checkbox" role="switch" checked={traceOn} onChange={(e) => setTraceOn(e.target.checked)} data-testid="pd-trace" />{L("إضافة تاريخ التحميص والدفعة", "Add roast date and batch")}</label> : null}
                {template === "CUPPING_RESULTS" && !traceOn ? <span className="hr-caption" data-testid="pd-trace-off">{L("الدفعة وتاريخ التحميص مخفيّان من الحقول.", "Batch and roast date are hidden in the fields.")}</span> : null}
                {traceOn && template === "COFFEE_ORIGIN" ? items.map((it) => it.kind === "product" ? (
                  <BatchPicker key={it.productId} productId={it.productId} label={it.label} value={trace[it.productId]} onChange={(t) => setTrace((m) => { const n2 = { ...m }; if (t) n2[it.productId] = t; else delete n2[it.productId]; return n2; })} />
                ) : null) : null}
                {traceOn && template === "CUPPING_RESULTS" ? <>
                  <div className="pd-trace-rows" data-testid="pd-cup-batches">
                    {(preview?.labels ?? []).map((d) => {
                      const cup = d.kind === "cup" && d.cupNo ? `${L("كوب", "Cup")} ${d.cupNo}` : nameOf(d.ref);
                      return d.trace.batchNumber
                        ? <div key={d.ref} className="pd-trace-row">{cup} · {L("دفعة", "batch")} <bdi dir="ltr" className="hr-num">{d.trace.batchNumber}</bdi> · {L("تحميص", "roasted")} <bdi dir="ltr" className="hr-num">{d.trace.roastDate ?? "—"}</bdi></div>
                        : <div key={d.ref} className="pd-trace-row is-missing">{d.kind === "cup" && d.external
                          ? `${cup} ${L("عيّنة خارجية بلا دفعة تحميص — يُحذف السطر من ملصقها.", "is an external sample with no roasting batch — the line is left off its label.")}`
                          : `${cup}: ${L("بلا دفعة تحميص مسجلة — يُحذف السطر من ملصقه.", "no roasting batch recorded — the line is left off its label.")}`}</div>;
                    })}
                  </div>
                  <span className="hr-caption">{L("لكل كوب من سجل الجلسة (CuppingSessionBatch) · للقراءة فقط. محدد الدفعة لقالب منشأ القهوة فقط.", "Per cup from the session record (CuppingSessionBatch) · read-only. The batch selector is for the Coffee origin template only.")}</span>
                </> : null}
                {traceOn && template === "COFFEE_ORIGIN" ? <span className="hr-caption">{L("البحث محصور في دفعات هذا المنتج. التاريخ من سجل الدفعة بصيغة YYYY-MM-DD.", "Search is limited to this product’s batches. Date from the batch record, YYYY-MM-DD.")}</span> : null}
              </section>

              <section className="pd-sec">
                <button type="button" className="hr-btn is-ghost is-sm" style={{ width: "fit-content" }} aria-expanded={showFields} onClick={() => setShowFields((v) => !v)} data-testid="pd-fields-toggle">
                  {showFields ? "▾" : "▸"} {L("الحقول وترتيبها", "Fields and order")}
                </button>
                {showFields ? (
                  <>
                    <ul className="pd-fields" data-testid="pd-fields">
                      {fields.map((f, i) => {
                        const def = FIELD_DEFS[f.key as FieldKey];
                        // Origin: the traceability switch drives these two; Cupping: they are switched here.
                        const traceKey = (f.key === "roastDate" || f.key === "batchNumber") && template === "COFFEE_ORIGIN";
                        // Decision 2.1: scorer names come only from a privacy-confirmed preset; locked here.
                        const locked = f.key === "scorerNames";
                        return (
                          <li key={f.key}>
                            <label><input type="checkbox" checked={traceKey || f.key === "roastDate" || f.key === "batchNumber" ? traceOn : f.show} disabled={traceKey || locked} onChange={(e) => (f.key === "roastDate" || f.key === "batchNumber" ? setTraceOn(e.target.checked) : setFields((all) => all.map((x) => (x.key === f.key ? { ...x, show: e.target.checked } : x))))} />
                              <span className={f.show ? undefined : "is-off"}>{uiLang === "ar" ? def.ar : def.en}{locked ? <span className="hr-caption"> · {L("(مقفل) يتطلب تفويضًا منفصلًا ومتطلبات الخصوصية", "(locked) needs a separate authorization and privacy requirements")}</span> : null}</span></label>
                            <Btn size="sm" variant="ghost" aria-label={`${L("أعلى", "Up")} · ${uiLang === "ar" ? def.ar : def.en}`} disabled={i === 0} onClick={() => setFields((all) => { const c = [...all]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; })}>↑</Btn>
                            <Btn size="sm" variant="ghost" aria-label={`${L("أسفل", "Down")} · ${uiLang === "ar" ? def.ar : def.en}`} disabled={i === fields.length - 1} onClick={() => setFields((all) => { const c = [...all]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; return c; })}>↓</Btn>
                          </li>
                        );
                      })}
                    </ul>
                    {cls !== "compact" ? (
                      <label className="hr-field"><span className="hr-label">{L("أقصى عدد أسطر للإيحاءات", "Notes: maximum lines")}</span>
                        <Select className="hr-select" value={notesLines ?? ""} onChange={(e) => setNotesLines(e.target.value === "" ? null : Number(e.target.value))} data-testid="pd-notes-lines">
                          <option value="">{L("حسب المقاس", "By size")} ({defaultNotesLines(cls, lang)})</option>
                          {[1, 2, 3, 4, 5, 6].map((v) => <option key={v} value={v}>{v}</option>)}
                        </Select></label>
                    ) : null}
                    {meta.presets.filter((p) => p.templateKey === template).length ? (
                      <label className="hr-field"><span className="hr-label">{L("إعداد محفوظ", "Saved preset")}</span>
                        <Select className="hr-select" defaultValue="" onChange={(e) => applyPreset(e.target.value)} data-testid="pd-preset">
                          <option value="">{L("— اختر —", "— Choose —")}</option>
                          {meta.presets.filter((p) => p.templateKey === template).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </Select></label>
                    ) : null}
                    {meta.canManagePresets ? (
                      <div className="pd-row">
                        <input className="hr-input" value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder={L("اسم الإعداد", "Preset name")} aria-label={L("اسم الإعداد", "Preset name")} />
                        <Btn size="sm" disabled={!presetName.trim()} onClick={savePreset}>{L("حفظ كإعداد", "Save as preset")}</Btn>
                      </div>
                    ) : null}
                    {presetMsg ? <span className="hr-caption">{presetMsg}</span> : null}
                  </>
                ) : null}
              </section>

              <dl className="pd-kv">
                <dt>{L("الحقول الناقصة", "Missing fields")}</dt>
                <dd>{(() => {
                  const m = warnings.filter((w) => w.code === "FIELDS_MISSING");
                  return m.length ? m.map((w) => `«${nameOf(w.ref)}»`).join(L("، ", ", ")) + ` · ${L("تُطبع «—»", "print «—»")}` : L("لا شيء في المحدد", "None in the selection");
                })()}</dd>
                <dt>{L("الطابعة", "Printer")}</dt>
                <dd>{L("تُختار في نافذة الطباعة في المتصفح", "Chosen in the browser’s print dialog")}</dd>
              </dl>

              {previewErr && !tooLarge ? <Notice tone="danger"><span data-testid="pd-error">{previewErr.message}</span></Notice> : null}
              {printErr ? <Notice tone="danger">{printErr}</Notice> : null}

              <Guidance profile={profile} />
            </div>

            <div className="pd-preview" data-testid="pd-preview">
              <div className="pd-preview-head">
                <span>{L("معاينة", "Preview")}{pages.length && !roll && !stacked ? <> · {L("صفحة", "Page")} <span className="hr-num">{page + 1}</span> {L("من", "of")} <span className="hr-num">{pages.length}</span></> : null}</span>
                <button type="button" className="ops-link" style={{ background: "none", border: 0, cursor: "pointer", font: "inherit", fontSize: 13 }} onClick={() => setActual((v) => !v)}>{actual ? L("ملاءمة", "Fit") : L("المقاس الفعلي", "Actual size")}</button>
              </div>
              <div className="pd-preview-stage" dir="ltr" ref={stageRef} style={{ overflow: actual ? "auto" : "hidden" }}>
                {stacked && preview ? stackedRefs.map((ref, i) => byRef.get(ref) ? (
                  // 1664:182033: the job's labels one under another, scaled to 90 % at most.
                  <div key={`${ref}-${i}`} className="pd-stack-item" style={{ width: mmToCssPx(label.w) * stackScale, height: mmToCssPx(label.h) * stackScale, flex: "none" }}>
                    <div className="pd-preview-scale" style={{ transform: `scale(${stackScale})` }}>
                      <div className="pl-page is-preview" style={{ width: `${label.w}mm`, height: `${label.h}mm` }}><LabelView data={byRef.get(ref)!} opts={opts} wMm={label.w} hMm={label.h} /></div>
                    </div>
                  </div>
                ) : null) : null}
                {!stacked && pages[page] && preview ? (roll ? pages.slice(0, 12) : [pages[page]]).map((pg) => (
                  <div key={pg.index} style={{ width: paperPx * scale, height: mmToCssPx(pageSize(profile).h) * scale, flex: "none" }}>
                    <div className="pd-preview-scale" style={{ transform: `scale(${scale})` }}>
                      <SheetPage page={pg} profile={profile} byRef={byRef} opts={opts} mode="preview" emptyText={L("فارغ", "empty")} />
                    </div>
                  </div>
                )) : null}
                {!preview || (!stacked && !pages[page]) ? <span className="hr-caption">{tooLarge ? "" : L("جارٍ إعداد المعاينة…", "Preparing the preview…")}</span> : null}
              </div>
              {pages.length > 1 && !roll && !stacked ? (
                <div className="pd-pager">
                  <Btn size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label={L("الصفحة السابقة", "Previous page")}>{uiLang === "ar" ? "→" : "←"}</Btn>
                  <Btn size="sm" disabled={page >= pages.length - 1} onClick={() => setPage((p) => p + 1)} aria-label={L("الصفحة التالية", "Next page")}>{uiLang === "ar" ? "←" : "→"}</Btn>
                </div>
              ) : null}
              <div className="pd-preview-cap" data-testid="pd-preview-cap">
                {stacked ? <>
                  {countNoun(totals?.labels ?? 0, uiLang, LABEL_FORMS)} {L("على ورقة", "on an")} {iso(sheetName)} {L("", "sheet")} · {L("الخانات", "slots")} {iso(`${startSlot}–${Math.min(perPage(profile), startSlot - 1 + (totals?.labels ?? 0))}`)} · {L("المعاينة مصغّرة", "preview scaled")} {iso(`${Math.round(stackScale * 100)}%`)}
                </> : <>
                  {totals && usesStartSlot(profile) && startSlot > 1 ? `${L("الخانات", "Slots")} 1–${startSlot - 1} ${L("مستخدمة", "used")} · ` : ""}
                  {countNoun(totals?.labels ?? 0, uiLang, LABEL_FORMS)}{roll ? <> · {iso(dimText(profile.labelWidthMm, profile.labelHeightMm))}{profile.gapYMm ? ` · ${L("فاصل", "gap")} ${iso(`${profile.gapYMm} mm`)}` : ""}</> : null} · {L("الخط المتقطع = حافة القص", "dashed line = cut edge")}
                </>}
              </div>
              {expanded && preview && truncatedRef && byRef.get(truncatedRef) ? (
                <div className="pd-expanded" data-testid="pd-expanded">
                  <figure>
                    <div style={{ width: mmToCssPx(label.w) * Math.min(1.6, (stageW / 2 - 8) / mmToCssPx(label.w)), height: mmToCssPx(label.h) * Math.min(1.6, (stageW / 2 - 8) / mmToCssPx(label.w)) }}>
                      <div className="pd-preview-scale" style={{ transform: `scale(${Math.min(1.6, (stageW / 2 - 8) / mmToCssPx(label.w))})` }}>
                        <div className="pl-page is-preview" style={{ width: `${label.w}mm`, height: `${label.h}mm` }}><LabelView data={byRef.get(truncatedRef)!} opts={opts} wMm={label.w} hMm={label.h} /></div>
                      </div>
                    </div>
                    <figcaption>{L("كما يُطبع", "As printed")}</figcaption>
                  </figure>
                  <figure>
                    <div style={{ width: mmToCssPx(label.w) * Math.min(1.6, (stageW / 2 - 8) / mmToCssPx(label.w)), height: mmToCssPx(label.h * 1.6) * Math.min(1.6, (stageW / 2 - 8) / mmToCssPx(label.w)), overflow: "hidden" }}>
                      <div className="pd-preview-scale" style={{ transform: `scale(${Math.min(1.6, (stageW / 2 - 8) / mmToCssPx(label.w))})` }}>
                        <div className="pl-page is-preview" style={{ width: `${label.w}mm`, height: `${label.h * 1.6}mm` }}><LabelView data={byRef.get(truncatedRef)!} opts={{ ...opts, fullNotes: true }} wMm={label.w} hMm={label.h * 1.6} /></div>
                      </div>
                    </div>
                    <figcaption>{L("النص الكامل في السجل (لا يُطبع)", "Full text in the record (not printed)")}</figcaption>
                  </figure>
                  <Btn size="sm" onClick={() => setExpanded(false)}>{L("إغلاق المعاينة الموسعة", "Close the expanded preview")}</Btn>
                </div>
              ) : null}
            </div>
          </div>
        )}
        {/* Off-screen measurement of every distinct label at actual size (fit detection). */}
        {preview && profile ? (
          <div ref={measureRef} aria-hidden="true" style={{ position: "fixed", left: -20000, top: 0, visibility: "hidden", pointerEvents: "none" }}>
            {preview.labels.map((d) => <LabelView key={d.ref} data={d} opts={opts} wMm={label.w} hMm={label.h} refAttr={d.ref} />)}
          </div>
        ) : null}
      </Dialog>
      {job && profile ? (
        <PrintRoot pages={paginate(profile, jobItems, usesStartSlot(profile) ? startSlot : 1)} profile={profile} byRef={new Map(job.labels.map((l) => [l.ref, l]))} opts={opts} onReady={onReady} />
      ) : null}
    </>
  );
}

function Warnings({ warnings, nameOf, lang, cls, template, labelDims, lines, onExpand }: { warnings: PrintWarning[]; nameOf: (ref?: string) => string; lang: PrintLang; cls: string; template: TemplateKey; labelDims: string; lines: number; onExpand: () => void }) {
  const L = useL();
  const { lang: uiLang } = useI18n();
  const by = (c: WarningCode) => warnings.filter((w) => w.code === c);
  const list = (ws: PrintWarning[]) => [...new Set(ws.map((w) => `«${nameOf(w.ref)}»`))].join(L("، ", ", "));
  const out: ReactNode[] = [];
  if (by("DOES_NOT_FIT").length) out.push(<Notice key="fit" tone="danger"><span data-testid="pd-warn-fit">{L("لا يتسع", "Doesn’t fit")}: {list(by("DOES_NOT_FIT"))} — {L("بعض المحتوى يتجاوز حدود الملصق. اختر ملصقًا أكبر أو أخفِ حقولًا.", "some content runs past the label edge. Choose a larger label or hide fields.")}</span></Notice>);
  if (by("LEGACY_COMPACT_BLOCKED").length) out.push(<Notice key="lcb" tone="danger"><span data-testid="pd-warn-legacy-blocked">{L("لا يمكن طباعة نتيجة جلسة سابقة للسياسة بهذا المقاس: لا يتسع التنبيه «قبل السياسة» بوضوح.", "A pre-policy score cannot print at this size: the «Pre-policy» caveat does not fit legibly.")}</span></Notice>);
  if (by("NOTES_OMITTED_BI_COMPACT").length) out.push(<Notice key="nbi" tone="warning"><span data-testid="pd-warn-notes-omitted">{L("لا يتسع: على", "Doesn’t fit: on")} <bdi dir="ltr">50 × 30 mm</bdi> {L("باللغتين لا تتسع الإيحاءات فتُحذف من الملصق. النص الكامل يبقى في السجل.", "in two languages the notes don’t fit and are left off the label. The full text stays in the record.")}</span> <button type="button" className="ops-link" style={{ background: "none", border: 0, cursor: "pointer", font: "inherit" }} onClick={onExpand}>{L("معاينة موسعة", "Expanded preview")}</button></Notice>);
  // 1664:182033: «Notes are shortened: bilingual on 99.1 × 67.7 mm fits up to 3 lines per language;
  // longer notes are cut at a whole word with «…».» + «Expanded preview».
  if (by("NOTES_TRUNCATED").length) {
    const where = lang === "BI" ? L("ثنائي اللغة", "bilingual") : lang === "AR" ? L("العربية", "Arabic") : L("الإنجليزية", "English");
    const fits = lang === "BI" ? L(`يتسع حتى ${lines} أسطر لكل لغة`, `fits up to ${lines} lines per language`) : L(`يتسع حتى ${lines} أسطر`, `fits up to ${lines} lines`);
    out.push(
      <div key="nt" className="pd-warn" data-testid="pd-warn-truncated-box">
        <span data-testid="pd-warn-truncated">{L("اختُصرت الإيحاءات", "Notes are shortened")}: {where} {L("على", "on")} <bdi dir="ltr">{labelDims}</bdi> {fits}{L("؛ يُقطع النص الأطول عند كلمة كاملة مع «…».", "; longer notes are cut at a whole word with «…».")}</span>
        <button type="button" className="ops-link pd-linkbtn" onClick={onExpand} data-testid="pd-expand">{L("معاينة موسّعة", "Expanded preview")}</button>
      </div>,
    );
  }
  // Cupping shows a missing batch on its cup's traceability row instead (1664:182033).
  if (by("TRACE_MISSING").length && template === "COFFEE_ORIGIN") {
    const refs = [...new Set(by("TRACE_MISSING").map((w) => w.ref))];
    out.push(<Notice key="tm" tone="warning"><span data-testid="pd-warn-trace">{refs.map((r) => `«${nameOf(r)}»`).join(L("، ", ", "))}: {L("لا دفعة تحميص محددة أو مسجلة — يُحذف السطر من ملصقه ولا يُخترع.", "no roasting batch selected or recorded — the line is left off its label, never invented.")}</span></Notice>);
  }
  if (by("NOT_FINAL").length) out.push(<Notice key="nf" tone="warning"><span data-testid="pd-warn-not-final">{list(by("NOT_FINAL"))}: {L("بلا نتيجة نهائية — يُطبع «غير نهائية» أو «غير مكتملة» دون رقم.", "no final score — prints «Not final» or «Incomplete» without a number.")}</span></Notice>);
  if (by("NAMED_SCORERS_IGNORED").length) out.push(<Notice key="nsi" tone="info"><span data-testid="pd-warn-named">{L("أسماء المقيّمين لا تُطبع: تتطلب صلاحية منفصلة وإعدادًا مؤكَّدًا للخصوصية. تُطبع «مقيّم 1، مقيّم 2…».", "Scorer names are not printed: that needs a separate permission and a privacy-confirmed preset. Labels read «Scorer 1, Scorer 2…».")}</span></Notice>);
  if (by("NO_SHARED_NOTES").length) out.push(<Notice key="ns" tone="info">{list(by("NO_SHARED_NOTES"))}: {L("لا إيحاءات مشتركة — يُطبع «لا توجد إيحاءات مشتركة».", "no shared notes — the label says «No shared notes».")}</Notice>);
  if (by("LOGO_OMITTED").length && cls !== "compact") out.push(<Notice key="lo" tone="info">{L("الشعار محذوف: أصغر من حده الأدنى", "Logo left off: below its minimum of")} {LOGO_MIN_HEIGHT_MM} {L("مم.", "mm.")}</Notice>);
  void lang; void uiLang;
  return out.length ? <div className="hr-stack" style={{ gap: 8 }} data-testid="pd-warnings">{out}</div> : null;
}

/** B-5 contextual guidance; browser printing cannot guarantee physical settings (A-1, A-2). */
function Guidance({ profile }: { profile: PrintProfileData }) {
  const L = useL();
  const { w, h } = pageSize(profile);
  const dims = iso(dimText(w, h));
  const thermal = profile.kind === "THERMAL_ROLL";
  return (
    <div className="pd-guide" data-testid="pd-guidance">
      <h4>{thermal ? L("إرشادات الطابعة الحرارية", "Thermal printer guidance") : profile.kind === "A4_SHEET" || profile.kind === "A4_PLAIN" ? L("إرشادات طباعة ورق A4", "A4 sheet printing guidance") : L("إرشادات الطباعة", "Printing guidance")}</h4>
      <ul>
        {thermal ? <>
          <li>{L("مقاس الورق في مشغّل الطابعة", "Driver paper size")} {dims}{L("، المقياس 100٪، الهوامش «بلا».", ", scale 100 %, margins None.")}</li>
          <li>{L("الاتجاه: تأكد من حافة التغذية، وفعّل كشف الفاصل في المشغّل.", "Orientation: check which edge feeds first. Turn on gap detection in the driver.")}</li>
          <li>{L("الحرارة والسرعة من المشغّل؛ اطبع ملصق اختبار واحدًا وتحقق من وضوح العربية.", "Heat/speed come from the driver; print one test label and check Arabic legibility.")} ({iso(dpiText(profile.dpi))} {L("مُعلنة في الملف، لا تُكتشف", "declared in the profile, not detected")})</li>
        </> : <>
          <li>{L("المقاس الفعلي 100٪، لا «ملاءمة للصفحة»؛ الهوامش «بلا».", "Actual size 100%, not «Fit to page»; margins «None».")}</li>
          <li>{L("نوع الورق في المشغّل: ملصقات؛ الاتجاه", "Driver paper type: labels; orientation")} {profile.orientation === "LANDSCAPE" ? L("أفقي", "landscape") : L("عمودي", "portrait")}.</li>
          <li>{L("اطبع صفحة معايرة على ورق عادي وطابقها مع ورقة الملصقات.", "Print a calibration page on plain paper and match it to the label sheet.")}</li>
        </>}
        {/* Phones (1658:11206 / 1658:11403): the platform's own print service. */}
        <li className="pd-guide-mobile">{L("الطباعة من الجوال أو الجهاز اللوحي غير معتمدة في المرحلة الأولى. اطبع من متصفح Chrome أو Edge على جهاز مكتبي.", "Printing from a phone or tablet is not certified in Phase 1. Print from Chrome or Edge on a desktop computer.")}</li>
        <li>{L("لا يستطيع المتصفح ضمان إعدادات الطابعة الفعلية؛ افحص أول ورقة.", "The browser cannot guarantee the printer’s physical settings; check the first sheet.")}</li>
      </ul>
    </div>
  );
}
