// «تحليل الاحتياج» and the qualification minimum (migration 20261204100000_pipeline_qualification).
//
// Needs analysis is a DETAIL of the Qualified Opportunity stage, not a stage of its own: four
// nullable facts on the deal (and the same four on the lead, so they can be gathered before the
// lead converts). Two of them — what kind of business this is and what it needs — plus the next
// step the customer agreed to are the minimum that makes an interested prospect a qualified
// opportunity; the monthly volume is welcome and never required.
//
// Pure: parsing, the missing-field rule and the labels are asserted without a database, and the
// module is safe to import from a client screen (no Prisma, no outbox).
import { parseFiniteDecimal, type Decimal } from "../commissions/engine";
import { SEGMENTS, type Segment } from "../customers/fields";

/** The business types are the customer segments — one list, so a converted deal and its customer agree. */
export const BUSINESS_TYPES = SEGMENTS;
export type BusinessType = Segment;

export const BUSINESS_TYPE_LABELS: Record<BusinessType, { en: string; ar: string }> = {
  WHOLESALE: { en: "Wholesale", ar: "جملة" },
  RETAIL: { en: "Retail", ar: "تجزئة" },
  CAFE: { en: "Café", ar: "مقهى" },
  DISTRIBUTOR: { en: "Distributor", ar: "موزّع" },
  OTHER: { en: "Other", ar: "أخرى" },
};

/** The qualification minimum, by the names the activity payload uses. Volume is not one of them. */
export const QUALIFICATION_MINIMUM = ["businessType", "needSummary", "nextStep"] as const;
export type QualificationField = (typeof QUALIFICATION_MINIMUM)[number];

export const QUALIFICATION_FIELD_LABELS: Record<QualificationField | "expectedMonthlyKg", { en: string; ar: string }> = {
  businessType: { en: "Business type", ar: "نوع النشاط" },
  needSummary: { en: "What they need", ar: "الاحتياج" },
  nextStep: { en: "Agreed next step", ar: "الخطوة التالية المتفق عليها" },
  expectedMonthlyKg: { en: "Expected monthly volume (kg)", ar: "الكمية الشهرية المتوقعة (كغ)" },
};

/** The four facts as they are stored (on Lead and Opportunity alike). */
export type NeedsFields = {
  businessType: BusinessType | null;
  needSummary: string | null;
  expectedMonthlyKg: Decimal | null;
  agreedNextStep: string | null;
};

const MAX_TEXT = 1000;
const MAX_KG = 1_000_000;

type Problem = { ok: false; error: string; errorAr: string };
const fail = (error: string, errorAr: string): Problem => ({ ok: false, error, errorAr });

function text(v: unknown, label: { en: string; ar: string }): { ok: true; value: string | null } | Problem {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== "string") return fail(`${label.en} must be text.`, `${label.ar}: قيمة غير صالحة.`);
  const t = v.trim();
  if (t.length > MAX_TEXT) return fail(`${label.en} is longer than ${MAX_TEXT} characters.`, `${label.ar}: النص أطول من ${MAX_TEXT} حرف.`);
  return { ok: true, value: t || null };
}

function businessType(v: unknown): { ok: true; value: BusinessType | null } | Problem {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  if (typeof v === "string" && (BUSINESS_TYPES as readonly string[]).includes(v)) return { ok: true, value: v as BusinessType };
  return fail(`The business type is one of: ${BUSINESS_TYPES.join(", ")}.`, "نوع النشاط غير صالح: جملة، تجزئة، مقهى، موزّع أو أخرى.");
}

/** Arabic-Indic digits and the Arabic decimal separator, read as the ASCII the decimal parser expects. */
const asciiNumber = (s: string) =>
  s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/[\s,٬]/g, "");

function kilos(v: unknown): { ok: true; value: Decimal | null } | Problem {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const d = typeof v === "number" || typeof v === "string" ? parseFiniteDecimal(typeof v === "string" ? asciiNumber(v) : v) : null;
  if (!d || d.isNegative() || d.greaterThan(MAX_KG) || d.decimalPlaces() > 3) {
    return fail(
      `The expected monthly volume is a number of kilograms from 0 to ${MAX_KG}, with at most three decimals.`,
      `الكمية الشهرية المتوقعة رقم بالكيلوغرام من 0 إلى ${MAX_KG}، بثلاث منازل عشرية على الأكثر.`,
    );
  }
  return { ok: true, value: d };
}

/**
 * A PATCH body for a deal's needs → the columns to write. A key absent from the body is left
 * unchanged; "" or null clears it. `agreedNextStep` is accepted under that name and as `nextStep`
 * (the activity payload's name), so one form can feed both endpoints.
 */
export function parseNeedsPatch(b: Record<string, unknown>): { ok: true; data: Partial<NeedsFields> } | Problem {
  const data: Partial<NeedsFields> = {};
  if ("businessType" in b) {
    const r = businessType(b.businessType);
    if (!r.ok) return r;
    data.businessType = r.value;
  }
  if ("needSummary" in b) {
    const r = text(b.needSummary, QUALIFICATION_FIELD_LABELS.needSummary);
    if (!r.ok) return r;
    data.needSummary = r.value;
  }
  if ("expectedMonthlyKg" in b) {
    const r = kilos(b.expectedMonthlyKg);
    if (!r.ok) return r;
    data.expectedMonthlyKg = r.value;
  }
  const stepKey = "agreedNextStep" in b ? "agreedNextStep" : "nextStep" in b ? "nextStep" : null;
  if (stepKey) {
    const r = text(b[stepKey], QUALIFICATION_FIELD_LABELS.nextStep);
    if (!r.ok) return r;
    data.agreedNextStep = r.value;
  }
  return { ok: true, data };
}

/**
 * The activity request's optional `qualification: { businessType, needSummary, expectedMonthlyKg?, nextStep }`.
 *
 * Absent or null → null (nothing supplied; the lead's own stored values are what count). Present →
 * only the keys that carry a value: an empty field in the inline form means "not answered", and
 * must not wipe an answer the lead already holds.
 */
export function parseQualificationInput(v: unknown): { ok: true; data: Partial<NeedsFields> | null } | Problem {
  if (v === null || v === undefined) return { ok: true, data: null };
  if (typeof v !== "object" || Array.isArray(v)) {
    return fail("qualification must be an object: { businessType, needSummary, expectedMonthlyKg?, nextStep }.", "بيانات التأهيل غير صالحة.");
  }
  const parsed = parseNeedsPatch(v as Record<string, unknown>);
  if (!parsed.ok) return parsed;
  const data: Partial<NeedsFields> = {};
  for (const [k, val] of Object.entries(parsed.data) as [keyof NeedsFields, NeedsFields[keyof NeedsFields]][]) {
    if (val !== null && val !== undefined) (data as Record<string, unknown>)[k] = val;
  }
  return { ok: true, data };
}

/** `stored` overlaid with whatever `supplied` carries. Neither is modified. */
export function mergeNeeds(stored: Partial<NeedsFields>, supplied: Partial<NeedsFields> | null | undefined): NeedsFields {
  const s = supplied ?? {};
  return {
    businessType: s.businessType ?? stored.businessType ?? null,
    needSummary: s.needSummary ?? stored.needSummary ?? null,
    expectedMonthlyKg: s.expectedMonthlyKg ?? stored.expectedMonthlyKg ?? null,
    agreedNextStep: s.agreedNextStep ?? stored.agreedNextStep ?? null,
  };
}

/**
 * Which of the minimum is still unknown, in a fixed order (the order the inline form asks them).
 * Blank text counts as unknown; the volume is never reported missing.
 */
export function qualificationMissing(n: {
  businessType?: string | null; needSummary?: string | null; agreedNextStep?: string | null;
}): QualificationField[] {
  const missing: QualificationField[] = [];
  if (!n.businessType || !(BUSINESS_TYPES as readonly string[]).includes(n.businessType)) missing.push("businessType");
  if (!n.needSummary?.trim()) missing.push("needSummary");
  if (!n.agreedNextStep?.trim()) missing.push("nextStep");
  return missing;
}

// ── Lost reasons ────────────────────────────────────────────────────────────────────────

export const LOST_REASON_CODES = ["PRICE", "QUALITY", "COMPETITOR", "NO_NEED", "NO_RESPONSE", "OTHER"] as const;
export type LostReasonCode = (typeof LOST_REASON_CODES)[number];

export const LOST_REASON_LABELS: Record<LostReasonCode, { en: string; ar: string }> = {
  PRICE: { en: "Price", ar: "السعر" },
  QUALITY: { en: "Quality", ar: "الجودة" },
  COMPETITOR: { en: "Went to a competitor", ar: "ذهب إلى منافس" },
  NO_NEED: { en: "No longer needed", ar: "لا حاجة" },
  NO_RESPONSE: { en: "No response", ar: "لا استجابة" },
  OTHER: { en: "Other", ar: "سبب آخر" },
};

/**
 * The loss reason a LOST transition stores: the typed text, or — when only a code other than
 * OTHER was chosen — that code's Arabic label, so `lostReason` is never empty and every existing
 * reader of it keeps working. OTHER without text is not a reason. An unknown code is refused,
 * never dropped: dropping it would record a loss as uncoded when somebody did code it.
 */
export function resolveLostReason(input: { lostReason?: unknown; lostReasonCode?: unknown }):
  { ok: true; reason: string; code: LostReasonCode | null } | Problem {
  let code: LostReasonCode | null = null;
  if (input.lostReasonCode !== undefined && input.lostReasonCode !== null && input.lostReasonCode !== "") {
    if (typeof input.lostReasonCode !== "string" || !(LOST_REASON_CODES as readonly string[]).includes(input.lostReasonCode)) {
      return fail(`lostReasonCode must be one of: ${LOST_REASON_CODES.join(", ")}.`, "رمز سبب الخسارة غير صالح.");
    }
    code = input.lostReasonCode as LostReasonCode;
  }
  const typed = typeof input.lostReason === "string" ? input.lostReason.trim() : "";
  const reason = typed || (code && code !== "OTHER" ? LOST_REASON_LABELS[code].ar : "");
  if (!reason) {
    return fail("Marking a deal lost needs a reason.", "تسجيل الصفقة خاسرة يحتاج سببًا.");
  }
  return { ok: true, reason, code };
}
