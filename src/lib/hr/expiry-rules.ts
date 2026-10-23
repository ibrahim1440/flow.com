// «تنبيهات انتهاء الوثائق» — the pure rules of the daily document-expiry check (feat/hr-expiry-email).
// No database, no clock: the service (./services/document-expiry.ts) passes "today" (the HR policy's
// calendar day, Asia/Riyadh by default) and the stored thresholds; the unit tests assert every rule here.
//
// What is checked (every expiry date HR keeps — prisma/schema.prisma):
//   * DOCUMENT  HrDocument.expiresOn of a document not removed (deletedAt NULL): any category —
//               CONTRACT, IDENTITY (iqama / passport / ID copy), CERTIFICATE (work permit, driving
//               licence, professional certificate …), MEDICAL (health certificate), OTHER. The title
//               names it. Seen by holders of hr › documents_view.
//   * IDENTITY  HrEmployeePrivate.idExpiry — the identity on the private data, named by its idType
//               (NATIONAL_ID «الهوية الوطنية», IQAMA «الإقامة», PASSPORT «جواز السفر»). Seen by holders of
//               hr › private_view.
//   * CONTRACT  HrContract.endDate of an ACTIVE (fixed-term) contract. Seen by holders of
//               hr › contracts_manage. HR only: the employee is not told about their own contract end
//               (a renewal is HR's decision to communicate).
// A person whose service ended (SEPARATED) is not checked.
//
// When (owner design): at each threshold (default 60, 30, 14, 7 and 1 days before), then «منتهية» on
// the expiry date and every 7 days after while it stays expired. A run notifies the CURRENT step only
// — the tightest threshold already reached — so a missed day, a late upload or a first run never
// floods the bell with the earlier steps. The step is part of the dedupe key with the expiry date
// itself: re-running the same day adds nothing, and a renewed date starts again.

export const DEFAULT_EXPIRY_DAYS = [60, 30, 14, 7, 1] as const;
export const MAX_EXPIRY_STEPS = 10;
export const MAX_EXPIRY_DAY = 365;
/** Expired items are reminded every this many days. */
export const EXPIRED_REMINDER_EVERY = 7;

export type ExpirySource = "DOCUMENT" | "IDENTITY" | "CONTRACT";

/**
 * A threshold list as stored: whole days 1..365, no duplicates, largest first, 1..10 entries. Throws a
 * plain Error (the caller maps it) on anything else — never silently "fixes" the owner's input beyond
 * order and duplicates.
 */
export function normalizeThresholds(input: unknown): number[] {
  const list = typeof input === "string" ? input.split(/[\s,،؛;]+/).filter(Boolean) : input;
  if (!Array.isArray(list)) throw new Error("expiryAlertDays must be a list of days.");
  const out = new Set<number>();
  for (const v of list) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_EXPIRY_DAY) throw new Error(`expiryAlertDays: each entry must be a whole number of days from 1 to ${MAX_EXPIRY_DAY}.`);
    out.add(n);
  }
  if (out.size === 0 || out.size > MAX_EXPIRY_STEPS) throw new Error(`expiryAlertDays must have 1 to ${MAX_EXPIRY_STEPS} entries.`);
  return [...out].sort((a, b) => b - a);
}

/** The stored value, or the defaults when it is unusable (a read never fails over a setting). */
export function thresholdsOrDefault(stored: unknown): number[] {
  try {
    return normalizeThresholds(stored);
  } catch {
    return [...DEFAULT_EXPIRY_DAYS];
  }
}

const DAY_MS = 86_400_000;
/** Whole calendar days from `today` to `expiry` (both calendar days at UTC midnight). Negative: past. */
export function daysUntil(expiry: Date, today: Date): number {
  return Math.round((Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate()) - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / DAY_MS);
}

export type ExpiryStep =
  | { kind: "before"; threshold: number; key: string }
  | { kind: "expired"; week: number; key: string };

/**
 * The step due for an item `daysLeft` days from expiry, or null when nothing is due yet:
 *   daysLeft > max threshold        → null;
 *   1 ≤ daysLeft ≤ max threshold    → the smallest threshold ≥ daysLeft («d30» while 30 … 15 days remain);
 *   daysLeft ≤ 0                    → expired, week ⌊-daysLeft / 7⌋ («x0» on the day, «x1» a week later …).
 * Pure; `thresholds` as normalizeThresholds returns them (any order accepted).
 */
export function stepFor(daysLeft: number, thresholds: readonly number[]): ExpiryStep | null {
  if (daysLeft <= 0) {
    const week = Math.floor(-daysLeft / EXPIRED_REMINDER_EVERY);
    return { kind: "expired", week, key: `x${week}` };
  }
  let best: number | null = null;
  for (const t of thresholds) if (t >= daysLeft && (best === null || t < best)) best = t;
  return best === null ? null : { kind: "before", threshold: best, key: `d${best}` };
}

/** The dedupe key of one item's step (the notify layer prefixes the event key and keys it per recipient). */
export function expiryDedupeKey(source: ExpirySource, id: string, expiresOn: string, step: ExpiryStep): string {
  return `${source}:${id}:${expiresOn}:${step.key}`;
}

const ID_TYPE_AR: Record<string, string> = { NATIONAL_ID: "الهوية الوطنية", IQAMA: "الإقامة", PASSPORT: "جواز السفر" };
const ID_TYPE_EN: Record<string, string> = { NATIONAL_ID: "National ID", IQAMA: "Iqama", PASSPORT: "Passport" };
const DOC_CATEGORY_AR: Record<string, string> = { CONTRACT: "عقد", IDENTITY: "هوية", CERTIFICATE: "شهادة", MEDICAL: "شهادة صحية", OTHER: "مستند" };
const DOC_CATEGORY_EN: Record<string, string> = { CONTRACT: "Contract", IDENTITY: "Identity", CERTIFICATE: "Certificate", MEDICAL: "Health certificate", OTHER: "Document" };

/** «الإقامة» / «عقد: C-HR-001-1» / the document's title — the label of an item in both languages. */
export function expiryLabel(item: { source: ExpirySource; title?: string | null; idType?: string | null; category?: string | null; contractNo?: string | null }): { ar: string; en: string } {
  if (item.source === "IDENTITY") {
    const t = item.idType ?? "";
    return { ar: ID_TYPE_AR[t] ?? "الهوية / الإقامة", en: ID_TYPE_EN[t] ?? "ID / iqama" };
  }
  if (item.source === "CONTRACT") return { ar: `عقد العمل ${item.contractNo ?? ""}`.trim(), en: `Employment contract ${item.contractNo ?? ""}`.trim() };
  const cat = item.category ?? "OTHER";
  const title = (item.title ?? "").trim();
  return { ar: title || DOC_CATEGORY_AR[cat] || "مستند", en: title || DOC_CATEGORY_EN[cat] || "Document" };
}

/** The HR duty that sees an item's source. */
export const SOURCE_SUB: Record<ExpirySource, "documents_view" | "private_view" | "contracts_manage"> = {
  DOCUMENT: "documents_view", IDENTITY: "private_view", CONTRACT: "contracts_manage",
};
/** The tab of the employee file that shows it. */
export const SOURCE_TAB: Record<ExpirySource, "documents" | "overview" | "contracts"> = {
  DOCUMENT: "documents", IDENTITY: "overview", CONTRACT: "contracts",
};

/** The badge of an item in a list: «منتهية» / «تنتهي خلال N يومًا» / null (not near). */
export function expiryBadge(daysLeft: number, horizon: number): { tone: "danger" | "warning"; ar: string; en: string } | null {
  if (daysLeft < 0) return { tone: "danger", ar: `منتهية منذ ${-daysLeft} يومًا`, en: `Expired ${-daysLeft} days ago` };
  if (daysLeft === 0) return { tone: "danger", ar: "تنتهي اليوم", en: "Expires today" };
  if (daysLeft <= horizon) return { tone: "warning", ar: `تنتهي خلال ${daysLeft} يومًا`, en: `Expires in ${daysLeft} days` };
  return null;
}
