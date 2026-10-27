/**
 * Label content: the resolved data a label prints (always produced by the server from ERP
 * records — the client never supplies label text), the label geometry used for text fit, and the
 * job warnings (A-4, B-6, B-7). Pure.
 */
import { MISSING, type PrintLang } from "./bidi";
import { truncateToLines, wrapLines } from "./fit";
import { LOGO_MIN_HEIGHT_MM, logoAllowed } from "./logo";
import { LEGACY_CAVEAT, NO_SHARED_NOTES, sharedNoteText, type CupResult } from "./cupping";
import { TYPE_SCALE, compactOmitsNotes, isShown, notesMaxLines, sizeClass, type FieldConfig, type SizeClass, type TemplateKey } from "./templates";

export { MISSING };
export type Bi = { en: string | null; ar: string | null };
export type Trace = { roastDate: string | null; batchNumber: string | null; lotRef: string | null };

export type OriginData = {
  kind: "origin";
  ref: string;
  productId: string;
  name: Bi;
  country: Bi; region: Bi; variety: Bi; process: Bi;
  altitude: string | null;
  cupNotes: Bi;
  roastPath: Bi;
  trace: Trace;
  /** The selected packed lot's SKU barcode (ProductSKU.barcode), printed when the «barcode» field is on. */
  barcode?: string | null;
};

export type CupData = {
  kind: "cup";
  ref: string;
  sessionId: string;
  cupId: string | null;
  cupNo: number | null;
  name: Bi;
  external: boolean;
  session: { name: string; date: string | null };
  result: CupResult;
  trace: Trace;
};

/** A green-coffee lot label (20261114090000_green_lot_labels), one per lot or one per sack. */
export type GreenLotData = {
  kind: "green";
  ref: string;
  greenBeanId: string;
  /** The barcode payload, «GL-00042». */
  code: string;
  serial: string;
  name: Bi;
  country: Bi; region: Bi; process: Bi;
  variety: string | null;
  altitude: string | null;
  /** From the lot's first receipt, when it came through one (a business name — never a person or a price). */
  supplier: string | null;
  /** The supplier's own invoice number, when the receipt belongs to a purchase invoice. */
  invoiceRef: string | null;
  receivedDate: string | null;
  /** Kilograms received on the lot's receipts (not today's balance). */
  receivedKg: number | null;
  /** «كيس 3 من 15» — a per-sack label; null for one label for the lot. */
  sack: { no: number; of: number; kg: number | null } | null;
  /** The lot's sacks as recorded (for the lot label: «15 × 60 كغ»). */
  sacks: { count: number; kg: number | null } | null;
  trace: Trace;
};

/** A shelf label of a stock material (bags, labels, café items). */
export type MaterialData = {
  kind: "material";
  ref: string;
  materialId: string;
  /** The barcode payload, «MT-00007». */
  code: string;
  itemCode: string;
  name: Bi;
  category: Bi;
  unit: string;
  trace: Trace;
};

export type LabelData = OriginData | CupData | GreenLotData | MaterialData;

export type WarningCode =
  | "TRACE_MISSING"            // a shown roast date / batch / lot has no record → omitted (B-7)
  | "FIELDS_MISSING"           // shown product fields print «—» (A-6)
  | "NOTES_TRUNCATED"          // notes cut to the line limit with «…» (B-6)
  | "NOTES_OMITTED_BI_COMPACT" // bilingual compact: notes left off for fit (P2-1)
  | "LOGO_OMITTED"             // below the minimum logo size (A-7)
  | "NOT_FINAL"                // a cupping label without a final score (open / incomplete)
  | "NO_SHARED_NOTES"          // finalized cup with no qualifying shared note
  | "NAMED_SCORERS_IGNORED"    // names requested without the permission + confirmed preset → anonymous (decision 2.1)
  | "LEGACY_COMPACT_BLOCKED"   // pre-policy caveat cannot fit legibly on this compact label (ruling 2)
  | "DOES_NOT_FIT";            // measured overflow in the preview (client-side, must be acknowledged)

export type PrintWarning = { code: WarningCode; ref?: string; field?: string; detail?: string };

/** Geometry used for text fit inside one label, mm. */
export function labelMetrics(wMm: number, hMm: number, lang: PrintLang) {
  const cls = sizeClass(wMm, hMm);
  const t = TYPE_SCALE[cls];
  const inner = wMm - 2 * t.padMm;
  // Bilingual standard rows have two key columns per row; 17 mm keeps paired keys («الحلاوة · المذاق المتبقي») to two lines.
  // 1646:6432: a 17 mm key column on standard labels in every language («SWEETNESS ·» / «AFTERTASTE»).
  const labelCol = cls === "large" ? 34 : cls === "standard" ? 17 : 0;
  const valueWidth = cls === "compact"
    ? inner
    : lang === "BI" ? (inner - 3) / 2 - labelCol : inner - labelCol - 2;
  return { cls, t, inner, labelCol, valueWidth, innerHeight: hMm - 2 * t.padMm };
}

/** The notes text of a label side, as recorded (before truncation). */
export function notesText(d: LabelData, side: "en" | "ar", template: TemplateKey, fields: FieldConfig, translate: (tag: string, lang: "ar" | "en") => string = (x) => x, short = false): string | null {
  if (d.kind === "origin") return isShown(fields, "cupNotes") ? d.cupNotes[side] : null;
  if (d.kind !== "cup") return null;
  const r = d.result;
  const parts: string[] = [];
  if (isShown(fields, "sharedNotes") && r.state === "FINAL" && r.sharedNotes) {
    parts.push(r.sharedNotes.length ? r.sharedNotes.map((n) => sharedNoteText(translate(n.text, side), n.count, r.eligibleEvaluations, side, short)).join(" · ") : NO_SHARED_NOTES[side]);
  }
  if (isShown(fields, "scorerNotes") && r.scorerNotes) {
    // Owner decision 2.1: anonymous «مقيّم 1» / "Scorer 1" (submission order) unless the server
    // authorized named attribution; guests never appear (2.2).
    const names = isShown(fields, "scorerNames");
    for (const n of r.scorerNotes) {
      const who = names && n.scorer ? n.scorer : `${side === "ar" ? "مقيّم" : "Scorer"} ${n.no}`;
      const desc = n.descriptors.map((x) => translate(x, side)).join(side === "ar" ? "، " : ", ");
      const body = [desc, n.notes].filter(Boolean).join(" — ");
      if (body) parts.push(`${who}: ${body}`);
    }
  }
  void template;
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Decision 2.3 on compact labels: the full disclosure (in every printed language) must fit on at
 * most two lines at the 7 pt Arabic minimum within the label's inner width; otherwise the compact
 * template is blocked for pre-policy sessions — never abbreviated.
 */
export const LEGACY_CAVEAT_PT = 7;
export function legacyCaveatFits(wMm: number, hMm: number, lang: PrintLang): boolean {
  const m = labelMetrics(wMm, hMm, lang);
  const lines = sides(lang).reduce((a, s) => a + wrapLines(LEGACY_CAVEAT[s], m.inner, LEGACY_CAVEAT_PT).length, 0);
  return lines <= 2;
}

/** Notes as printed on one side: truncated to the line limit with «…». */
export function printedNotes(text: string | null, wMm: number, hMm: number, lang: PrintLang, configuredLines: number | null, side: "en" | "ar") {
  if (!text) return { text: null, truncated: false };
  const m = labelMetrics(wMm, hMm, lang);
  const pt = side === "ar" ? m.t.valueAr : m.t.value;
  const r = truncateToLines(text, notesMaxLines(m.cls, configuredLines, lang), m.valueWidth, pt);
  return { text: r.text, truncated: r.truncated };
}

const sides = (lang: PrintLang): ("en" | "ar")[] => (lang === "BI" ? ["en", "ar"] : lang === "AR" ? ["ar"] : ["en"]);

/** Whether the logo prints on a label of this size (A-7, A-4). */
export function logoPrints(cls: SizeClass, wMm: number, showLogo: boolean): boolean {
  if (!showLogo || cls === "compact") return false;
  const h = Math.max(TYPE_SCALE[cls].logoMm, LOGO_MIN_HEIGHT_MM);
  return logoAllowed(h, wMm / 2);
}

/** Job warnings from the data and the configuration (the preview adds DOES_NOT_FIT). */
export function contentWarnings(
  data: LabelData[], template: TemplateKey, fields: FieldConfig, lang: PrintLang,
  label: { wMm: number; hMm: number }, opts: { notesLines?: number | null; translate?: (tag: string, lang: "ar" | "en") => string } = {},
): PrintWarning[] {
  const out: PrintWarning[] = [];
  const m = labelMetrics(label.wMm, label.hMm, lang);
  const compact = m.cls === "compact";
  if (isShown(fields, "logo") && !logoPrints(m.cls, label.wMm, true)) out.push({ code: "LOGO_OMITTED" });
  const notesShown = template === "COFFEE_ORIGIN" ? isShown(fields, "cupNotes") : isShown(fields, "sharedNotes") || isShown(fields, "scorerNotes");
  if (compact && compactOmitsNotes(lang) && notesShown) out.push({ code: "NOTES_OMITTED_BI_COMPACT" });
  for (const d of data) {
    if (d.kind === "green" || d.kind === "material") {
      // Record labels: a missing name in a printed language prints «—»; supplier / invoice are omitted when unknown.
      const missing: string[] = [];
      if (sides(lang).some((s) => !d.name[s])) missing.push("name");
      if (d.kind === "green" && isShown(fields, "country") && sides(lang).some((s) => !d.country[s])) missing.push("country");
      if (missing.length) out.push({ code: "FIELDS_MISSING", ref: d.ref, detail: missing.join(",") });
      continue;
    }
    for (const f of ["roastDate", "batchNumber", "lotRef"] as const) {
      if (isShown(fields, f) && !d.trace[f] && !(d.kind === "cup" && f === "lotRef")) out.push({ code: "TRACE_MISSING", ref: d.ref, field: f });
    }
    if (d.kind === "origin") {
      const keys = ["country", "region", "variety", "process", "roastPath", "cupNotes"] as const;
      const missing = keys.filter((k) => isShown(fields, k) && sides(lang).some((s) => !d[k][s]));
      if (isShown(fields, "altitude") && !d.altitude) missing.push("altitude" as never);
      if (sides(lang).some((s) => !d.name[s])) missing.push("name" as never);
      if (missing.length) out.push({ code: "FIELDS_MISSING", ref: d.ref, detail: missing.join(",") });
    } else {
      if (d.result.state !== "FINAL" && d.result.state !== "CLOSED_LEGACY") out.push({ code: "NOT_FINAL", ref: d.ref, detail: d.result.state });
      if (d.result.state === "FINAL" && isShown(fields, "sharedNotes") && d.result.sharedNotes?.length === 0) out.push({ code: "NO_SHARED_NOTES", ref: d.ref });
      if (d.result.state === "CLOSED_LEGACY" && compact && isShown(fields, "score") && !legacyCaveatFits(label.wMm, label.hMm, lang)) {
        out.push({ code: "LEGACY_COMPACT_BLOCKED", ref: d.ref });
      }
    }
    if (notesShown && !(compact && compactOmitsNotes(lang))) {
      for (const s of sides(lang)) {
        const p = printedNotes(notesText(d, s, template, fields, opts.translate), label.wMm, label.hMm, lang, opts.notesLines ?? null, s);
        if (p.truncated) { out.push({ code: "NOTES_TRUNCATED", ref: d.ref, field: s }); break; }
      }
    }
  }
  return out;
}

export const WARNING_CODES: WarningCode[] = ["TRACE_MISSING", "FIELDS_MISSING", "NOTES_TRUNCATED", "NOTES_OMITTED_BI_COMPACT", "LOGO_OMITTED", "NOT_FINAL", "NO_SHARED_NOTES", "NAMED_SCORERS_IGNORED", "LEGACY_COMPACT_BLOCKED", "DOES_NOT_FIT"];
/** Warnings that refuse the job (the server enforces them too). */
export const BLOCKING_CODES: WarningCode[] = ["LEGACY_COMPACT_BLOCKED"];

/**
 * The vertical rhythm of a label: one gap between header, rule, score, fields, rule and footer, as
 * the Figma auto-layout of each variant sets it (G-20 1646:6432 «Print/Label · Cupping Results»,
 * 1646:5655 «Print/Label · Coffee Origin»; frames drawn at 4 px per mm):
 *   - compact 50 × 30: 0.5 mm (every variant, gap 2); large (A4) has no variant and stays 0.5 mm;
 *   - Coffee Origin standard: 1.0 mm (1646:4906 … 1646:5512, gap 4);
 *   - Arabic-only / English-only standard: 1.0 mm (e.g. 1646:5882, 1646:6082, 1655:10336, gap 4);
 *   - bilingual, closed before the policy (with or without a score): 0.375 mm (1655:10543, 1667:182009, gap 1.5);
 *   - bilingual Final with notes by scorer and scorer names hidden — the fullest variant: 0.5 mm (1646:5656, gap 2);
 *   - every other bilingual variant: 0.75 mm (1646:5776 open, 1655:10230 incomplete, 1646:6282 /
 *     1655:10871 shared notes, 1656:10860 scorer names shown; gap 3).
 */
export function labelGapMm(data: LabelData, lang: PrintLang, cls: SizeClass, fields: FieldConfig): number {
  // Compact keeps its 0.5 mm; the A4 full-page class has no Figma variant and keeps the 0.5 mm it had.
  if (cls !== "standard") return 0.5;
  if (data.kind !== "cup" || lang !== "BI") return 1;
  const r = (data as CupData).result;
  if (r.state === "CLOSED_LEGACY") return 0.375;
  const perScorer = isShown(fields, "scorerNotes") && (r.scorerNotes?.length ?? 0) > 0;
  if (r.state === "FINAL" && perScorer && !isShown(fields, "scorerNames")) return 0.5;
  return 0.75;
}
