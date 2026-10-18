/**
 * The Template Manager registry (A-5): two templates, their field catalogue, default order and
 * visibility, the compact field priority (A-4 / design P2-1), and the type scale per label size.
 * Field configuration (show / hide and order) is a plain array of { key, show } — the same shape
 * stored in PrintTemplatePreset.fields.
 */
import { isCompactLabel } from "./profiles";
import type { PrintLang } from "./bidi";

export const TEMPLATE_KEYS = ["COFFEE_ORIGIN", "CUPPING_RESULTS"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const ATTRIBUTE_KEYS = ["fragranceAroma", "flavor", "aftertaste", "acidity", "body", "balance", "overall", "sweetness", "uniformity", "cleanCup"] as const;
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

export type FieldKey =
  | "logo" | "name" | "country" | "region" | "variety" | "process" | "altitude" | "cupNotes" | "roastPath"
  | "roastDate" | "batchNumber" | "lotRef" | "footer"
  | "score" | `attr_${AttributeKey}` | "sharedNotes" | "scorerNotes" | "session"
  | "scorerNames";

export type FieldDef = {
  key: FieldKey;
  en: string;
  ar: string;
  /** text = one line; notes = wraps to the notes line limit; trace = from a batch/lot record (omitted + warning when missing, B-7). */
  /** option = not printed itself; switches how another field prints (design review rulings 6–7). */
  kind: "text" | "notes" | "trace" | "logo" | "footer" | "score" | "attr" | "name" | "option";
  /** Never clipped silently; a label whose essential field overflows needs acknowledgement. */
  essential?: boolean;
};

export const FIELD_DEFS: Record<FieldKey, FieldDef> = {
  logo: { key: "logo", en: "Logo", ar: "الشعار", kind: "logo" },
  name: { key: "name", en: "Name", ar: "الاسم", kind: "name", essential: true },
  country: { key: "country", en: "Country", ar: "الدولة", kind: "text" },
  region: { key: "region", en: "Region", ar: "المنطقة", kind: "text" },
  variety: { key: "variety", en: "Variety", ar: "السلالة", kind: "text" },
  process: { key: "process", en: "Process", ar: "المعالجة", kind: "text" },
  altitude: { key: "altitude", en: "Altitude", ar: "الارتفاع", kind: "text" },
  cupNotes: { key: "cupNotes", en: "Cup notes", ar: "الإيحاءات", kind: "notes" },
  roastPath: { key: "roastPath", en: "Roast path", ar: "مسار القهوة", kind: "text" },
  roastDate: { key: "roastDate", en: "Roast date", ar: "تاريخ التحميص", kind: "trace" },
  batchNumber: { key: "batchNumber", en: "Batch", ar: "الدفعة", kind: "trace" },
  lotRef: { key: "lotRef", en: "Lot", ar: "اللوت", kind: "trace" },
  footer: { key: "footer", en: "Footer", ar: "التذييل", kind: "footer" },
  score: { key: "score", en: "Score", ar: "النتيجة", kind: "score", essential: true },
  attr_fragranceAroma: { key: "attr_fragranceAroma", en: "Fragrance / aroma", ar: "الرائحة والعبير", kind: "attr" },
  attr_flavor: { key: "attr_flavor", en: "Flavor", ar: "النكهة", kind: "attr" },
  attr_aftertaste: { key: "attr_aftertaste", en: "Aftertaste", ar: "المذاق المتبقي", kind: "attr" },
  attr_acidity: { key: "attr_acidity", en: "Acidity", ar: "الحموضة", kind: "attr" },
  attr_body: { key: "attr_body", en: "Body", ar: "القوام", kind: "attr" },
  attr_balance: { key: "attr_balance", en: "Balance", ar: "التوازن", kind: "attr" },
  attr_overall: { key: "attr_overall", en: "Overall", ar: "الانطباع العام", kind: "attr" },
  attr_sweetness: { key: "attr_sweetness", en: "Sweetness", ar: "الحلاوة", kind: "attr" },
  attr_uniformity: { key: "attr_uniformity", en: "Uniformity", ar: "التجانس", kind: "attr" },
  attr_cleanCup: { key: "attr_cleanCup", en: "Clean cup", ar: "نظافة الكوب", kind: "attr" },
  sharedNotes: { key: "sharedNotes", en: "Shared notes", ar: "الإيحاءات المشتركة", kind: "notes" },
  scorerNotes: { key: "scorerNotes", en: "Notes (by scorer)", ar: "الإيحاءات (حسب المقيّم)", kind: "notes" },
  session: { key: "session", en: "Session", ar: "الجلسة", kind: "text" },
  // Owner decision 2.1: anonymous by default («مقيّم 1»). Names print only with the
  // labels.cupping_named_scorers permission AND a preset whose privacy confirmation is recorded —
  // the server forces this off otherwise. Guest feedback is not a label option at all (2.2).
  scorerNames: { key: "scorerNames", en: "Scorer names in notes", ar: "أسماء المقيّمين في الملاحظات", kind: "option" },
};

export type TemplateDef = {
  key: TemplateKey;
  en: string;
  ar: string;
  /** Default print order; `show` is the default visibility. */
  defaults: { key: FieldKey; show: boolean }[];
  /** Compact (50 × 30 class) field set in priority order (A-4, P2-1). */
  compact: ("name" | "notes" | "origin" | "score" | "trace")[];
};

export const TEMPLATES: Record<TemplateKey, TemplateDef> = {
  COFFEE_ORIGIN: {
    key: "COFFEE_ORIGIN",
    en: "Coffee origin",
    ar: "منشأ القهوة",
    defaults: [
      { key: "logo", show: true }, { key: "name", show: true },
      { key: "country", show: true }, { key: "region", show: true }, { key: "variety", show: true },
      { key: "process", show: true }, { key: "altitude", show: true }, { key: "cupNotes", show: true },
      { key: "roastPath", show: true }, { key: "roastDate", show: false }, { key: "batchNumber", show: false },
      { key: "lotRef", show: false }, { key: "footer", show: true },
    ],
    compact: ["name", "notes", "origin", "trace"],
  },
  CUPPING_RESULTS: {
    key: "CUPPING_RESULTS",
    en: "Cupping results",
    ar: "نتائج التذوق",
    defaults: [
      { key: "logo", show: true }, { key: "name", show: true }, { key: "score", show: true },
      { key: "attr_acidity", show: true }, { key: "attr_body", show: true },
      { key: "attr_sweetness", show: true }, { key: "attr_aftertaste", show: true },
      { key: "attr_fragranceAroma", show: false }, { key: "attr_flavor", show: false },
      { key: "attr_balance", show: false }, { key: "attr_overall", show: false },
      { key: "attr_uniformity", show: false }, { key: "attr_cleanCup", show: false },
      { key: "sharedNotes", show: true }, { key: "scorerNotes", show: false }, { key: "session", show: true },
      // Every Cupping Results frame of 1646:6432 prints «BATCH · ROASTED» from the session's cup.
      { key: "batchNumber", show: true }, { key: "roastDate", show: true }, { key: "footer", show: true },
      { key: "scorerNames", show: false },
    ],
    compact: ["name", "score", "notes", "trace"],
  },
};

export type FieldConfig = { key: FieldKey; show: boolean }[];

export const TRACE_FIELDS: FieldKey[] = ["roastDate", "batchNumber", "lotRef"];

/**
 * A field configuration that contains every field of the template exactly once: unknown keys and
 * duplicates dropped, missing fields appended with their default visibility.
 */
export function normalizeFields(template: TemplateKey, raw: unknown): FieldConfig {
  const def = TEMPLATES[template];
  const allowed = new Map(def.defaults.map((d) => [d.key, d.show]));
  const out: FieldConfig = [];
  const seen = new Set<FieldKey>();
  if (Array.isArray(raw)) {
    for (const r of raw) {
      const key = (r as { key?: unknown })?.key as FieldKey;
      if (!allowed.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, show: (r as { show?: unknown }).show === true });
    }
  }
  for (const d of def.defaults) if (!seen.has(d.key)) out.push({ ...d });
  return out;
}

export const defaultFields = (template: TemplateKey): FieldConfig => TEMPLATES[template].defaults.map((d) => ({ ...d }));

export const isShown = (cfg: FieldConfig, key: FieldKey) => cfg.some((f) => f.key === key && f.show);

/** Size class of a label, from its printed size. */
export type SizeClass = "compact" | "standard" | "large";
export function sizeClass(widthMm: number, heightMm: number): SizeClass {
  if (isCompactLabel(widthMm, heightMm)) return "compact";
  if (widthMm >= 150 && heightMm >= 150) return "large";
  return "standard";
}

/**
 * Type scale (pt) per size class. Standard is the S1 artwork (design G20-G21-PRINT §3): name 10 pt
 * EN / 9 pt AR, values 8 pt, field labels 6.5 pt EN / 7 pt AR, footer 6 pt Latin / 7 pt Arabic.
 * Minimums: 6 pt Latin, 7 pt Arabic.
 */
export const TYPE_SCALE: Record<SizeClass, { nameEn: number; nameAr: number; value: number; valueAr: number; labelEn: number; labelAr: number; footerEn: number; footerAr: number; score: number; logoMm: number; padMm: number }> = {
  compact: { nameEn: 8, nameAr: 8, value: 6.5, valueAr: 7, labelEn: 6, labelAr: 7, footerEn: 6, footerAr: 7, score: 12, logoMm: 0, padMm: 2 },
  standard: { nameEn: 10, nameAr: 9, value: 8, valueAr: 8, labelEn: 6.5, labelAr: 7, footerEn: 6, footerAr: 7, score: 16, logoMm: 8, padMm: 3 },
  large: { nameEn: 18, nameAr: 17, value: 12, valueAr: 12, labelEn: 9.5, labelAr: 10, footerEn: 8, footerAr: 9, score: 30, logoMm: 14, padMm: 8 },
};

/**
 * Notes line limit (design §P2-2): 2 on 50 × 30 (fixed); on standard labels 3 per language column
 * when bilingual and 2 at full width when single-language; 6 on a full A4 page. A template or the
 * dialog may set 1–6 instead (null = by size).
 */
export function defaultNotesLines(cls: SizeClass, lang: PrintLang): number {
  if (cls === "compact") return 2;
  if (cls === "large") return 6;
  return lang === "BI" ? 3 : 2;
}
export function notesMaxLines(cls: SizeClass, configured: number | null | undefined, lang: PrintLang = "EN"): number {
  if (cls === "compact") return 2;
  const v = Number.isInteger(configured) ? (configured as number) : defaultNotesLines(cls, lang);
  return Math.min(6, Math.max(1, v));
}

/** Bilingual compact labels omit notes for fit (design P2-1); the dialog says so. */
export const compactOmitsNotes = (lang: PrintLang) => lang === "BI";
