// «طلب فاتورة ضريبية» (BATCH 22 WP-C) — the pure rules of the request workflow: the queue's age in Riyadh business days
// (Friday and Saturday off), the legal limit of a tax invoice, the queue colour, the return reasons, and which fields of a
// requested draft the accountant may correct (council ruling Q-F3). No database: the routes and the screens share it.

/** Return reasons (Q-F3): a code plus a free text of at least 10 characters, shown to Sales and kept in the history. */
export const RETURN_REASONS = ["PRICE", "QTY", "CUSTOMER_DATA", "DUPLICATE", "OTHER"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
export const RETURN_REASON_LABEL: Record<ReturnReason, [string, string]> = {
  PRICE: ["السعر أو الخصم", "Price or discount"],
  QTY: ["الكمية أو البنود", "Quantity or lines"],
  CUSTOMER_DATA: ["بيانات العميل", "Customer data"],
  DUPLICATE: ["طلب مكرر", "Duplicate request"],
  OTHER: ["سبب آخر", "Other"],
};
export const RETURN_REASON_MIN = 10;
export const isReturnReason = (v: unknown): v is ReturnReason => typeof v === "string" && (RETURN_REASONS as readonly string[]).includes(v);

const DAY_MS = 86_400_000;
const RIYADH_MS = 3 * 3600_000;

/** The Riyadh calendar day of an instant ("YYYY-MM-DD"). */
export function riyadhDayText(at: Date): string {
  return new Date(at.getTime() + RIYADH_MS).toISOString().slice(0, 10);
}

const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);
/** Friday (5) and Saturday (6) are the KSA weekend. */
export const isWeekend = (day: string) => { const w = new Date(utc(day)).getUTCDay(); return w === 5 || w === 6; };

/**
 * The business days a request has waited: the working days after the day it was requested, up to and including
 * `today` (both Riyadh days). Requested today → 0; requested Thursday, read Sunday → 1.
 */
export function businessDaysBetween(fromDay: string, today: string): number {
  let n = 0;
  for (let t = utc(fromDay) + DAY_MS; t <= utc(today); t += DAY_MS) {
    const w = new Date(t).getUTCDay();
    if (w !== 5 && w !== 6) n++;
  }
  return n;
}

/**
 * «آخر موعد نظامي»: a tax invoice for a supply is issued no later than the 15th day of the month after the month of
 * the supply (KSA VAT Implementing Regulations, Art. 53). The supply day is the draft's supply date, else the day the
 * request was made.
 */
export function legalDeadline(supplyDay: string): string {
  const d = new Date(utc(supplyDay));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 15)).toISOString().slice(0, 10);
}

export const daysUntil = (today: string, day: string) => Math.round((utc(day) - utc(today)) / DAY_MS);

export type QueueTone = "ok" | "amber" | "red";
/** Amber over one business day; red over two, or within five calendar days of (or past) the legal limit. */
export function queueTone(ageBusinessDays: number, today: string, deadline: string): QueueTone {
  if (ageBusinessDays > 2 || daysUntil(today, deadline) <= 5) return "red";
  if (ageBusinessDays > 1) return "amber";
  return "ok";
}

export function queueAging(requestedAt: Date, supplyDay: string | null, now: Date) {
  const today = riyadhDayText(now);
  const requestedDay = riyadhDayText(requestedAt);
  const age = businessDaysBetween(requestedDay, today);
  const deadline = legalDeadline(supplyDay ?? requestedDay);
  return { requestedDay, ageBusinessDays: age, deadline, daysToDeadline: daysUntil(today, deadline), pastDeadline: today > deadline, tone: queueTone(age, today, deadline) };
}

// ── Q-F3: what the accountant may correct on a requested draft ──────────────────────────────────────────────────────

/** The commercial terms of a line (quote, discount and credit control approved them): only Sales changes them. */
export const COMMERCIAL_LINE_FIELDS = ["quantity", "unit", "unitPrice", "discountPercent", "productSkuId", "orderItemId", "deliveryId", "originalLineId", "kind", "fixedAssetId"] as const;
/** The compliance particulars of a line the accountant may correct before issue. */
export const COMPLIANCE_LINE_FIELDS = ["description", "descriptionEn", "taxCategory", "taxRatePercent", "exemptionReasonCode", "exemptionReason"] as const;

type Comparable = Record<string, unknown>;
const norm = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  const t = typeof v === "object" && v !== null && "toString" in v ? String(v) : String(v);
  // Decimals compare by value ("1" = "1.000", "15" = "15.00").
  return /^-?\d+(\.\d+)?$/.test(t) ? String(Number(t)) : t;
};

/**
 * The commercial differences between the stored lines and a correction: a different line count (lines added or
 * removed) or a changed commercial field. Empty = the correction is compliance-only.
 */
export function commercialChanges(stored: Comparable[], next: Comparable[]): string[] {
  const out: string[] = [];
  if (stored.length !== next.length) out.push(`lines: ${stored.length} → ${next.length}`);
  const n = Math.min(stored.length, next.length);
  for (let i = 0; i < n; i++) {
    for (const f of COMMERCIAL_LINE_FIELDS) {
      const a = norm(stored[i][f] ?? (f === "kind" ? "ITEM" : null)), b = norm(next[i][f] ?? (f === "kind" ? "ITEM" : null));
      if (a !== b) out.push(`line ${i + 1} ${f}`);
    }
  }
  return out;
}

/** The field diff of an accountant's correction (for the request history): header fields and the line fields. */
export function correctionDiff(before: { header: Comparable; lines: Comparable[] }, after: { header: Comparable; lines: Comparable[] }) {
  const header: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(before.header), ...Object.keys(after.header)])) {
    const a = before.header[k], b = after.header[k];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) header[k] = { from: a ?? null, to: b ?? null };
  }
  const lines: { line: number; field: string; from: unknown; to: unknown }[] = [];
  after.lines.forEach((l, i) => {
    for (const f of COMPLIANCE_LINE_FIELDS) {
      if (norm(before.lines[i]?.[f]) !== norm(l[f])) lines.push({ line: i + 1, field: f, from: before.lines[i]?.[f] ?? null, to: l[f] ?? null });
    }
  });
  return Object.keys(header).length || lines.length ? { header, lines } : null;
}
