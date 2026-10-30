// «صلاحية العقد» — the pure rules of a contract's validity (batch 24 WP-C, migration
// 20261206100000_customer_contract_validity). Client-safe: the customer page, the team overview, the
// daily notice run and the unit tests read the same answer from here.
//
// ── Dates ──
// validFrom / validUntil are calendar dates (Postgres DATE), read as midnight UTC of that day. "Today"
// is the Asia/Riyadh calendar day (UTC+3, no daylight saving). daysLeft = validUntil − today in whole
// days: 0 = ends today (still in force today), −1 = ended yesterday.
//
// ── States ──
//   none      no end date (or not a contract category): nothing to say.
//   upcoming  validFrom is after today: «يبدأ في …».
//   valid     in force, outside its notice window: «ساري».
//   expiring  0 ≤ daysLeft ≤ the notice days: «ينتهي بعد X يوم» (the same words as the header fact).
//   expired   daysLeft < 0: «منتهي».
//   renewed   expiring / expired, but the same customer holds a later file of the same category whose end date
//             is later: «جُدّد» — no alarm for a contract that was already replaced.

export const VALIDITY_CATEGORIES = ["CONTRACT", "PRICE_AGREEMENT"] as const;
export type ValidityCategory = (typeof VALIDITY_CATEGORIES)[number];
export const DEFAULT_RENEWAL_NOTICE_DAYS = 45;
/** Expired contracts stay on the lists for this many days after their end date. */
export const EXPIRED_VISIBLE_DAYS = 30;

const DAY = 86_400_000;

export function hasValidity(category: string): category is ValidityCategory {
  return (VALIDITY_CATEGORIES as readonly string[]).includes(category);
}

/** The Riyadh calendar day of `now`, as midnight UTC of that day. */
export function riyadhToday(now: Date = new Date()): Date {
  const r = new Date(now.getTime() + 3 * 3600_000);
  return new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate()));
}

/** "YYYY-MM-DD" of a DATE value (midnight UTC). */
export function dateText(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "17/11/2026" — how a date reads on screen and in a notification (the order the table's other dates use; never
 *  the ISO form, which an RTL line shows reversed). */
export function displayDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

/** A date-only value from the API or a form ("2027-01-31" or an ISO timestamp of that midnight); null when unreadable. */
export function toDateOnly(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Reject 2027-02-31 and the like (Date would roll it over).
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null;
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY);
}

export type ValidityState = "none" | "upcoming" | "valid" | "expiring" | "expired" | "renewed";
export type Validity = { state: ValidityState; daysLeft: number | null; noticeDays: number };

/**
 * One file's validity today. `renewed`: the caller found a later file of the same category for the same
 * customer (see `isRenewed`).
 */
export function contractValidity(
  f: { category: string; validFrom: Date | string | null; validUntil: Date | string | null; renewalNoticeDays: number | null },
  opts: { defaultNoticeDays?: number | null; now?: Date; renewed?: boolean } = {},
): Validity {
  const noticeDays = f.renewalNoticeDays ?? opts.defaultNoticeDays ?? DEFAULT_RENEWAL_NOTICE_DAYS;
  const until = toDateOnly(f.validUntil);
  const from = toDateOnly(f.validFrom);
  const today = riyadhToday(opts.now);
  if (!hasValidity(f.category)) return { state: "none", daysLeft: null, noticeDays };
  if (from && from.getTime() > today.getTime()) return { state: "upcoming", daysLeft: until ? daysBetween(today, until) : null, noticeDays };
  if (!until) return { state: from ? "valid" : "none", daysLeft: null, noticeDays };
  const daysLeft = daysBetween(today, until);
  if (daysLeft > noticeDays) return { state: "valid", daysLeft, noticeDays };
  if (opts.renewed) return { state: "renewed", daysLeft, noticeDays };
  return { state: daysLeft < 0 ? "expired" : "expiring", daysLeft, noticeDays };
}

/** Was this file replaced: a later end date on another file of the same customer and category? */
export function isRenewed(
  f: { id: string; customerId?: string; category: string; validUntil: Date | string | null },
  all: { id: string; customerId?: string; category: string; validUntil: Date | string | null }[],
): boolean {
  const until = toDateOnly(f.validUntil);
  if (!until) return false;
  return all.some((o) => {
    if (o.id === f.id || o.category !== f.category) return false;
    if (f.customerId && o.customerId && o.customerId !== f.customerId) return false;
    const u = toDateOnly(o.validUntil);
    return !!u && u.getTime() > until.getTime();
  });
}

/** The validity pill's words and tone (the Direction 2.1 `.st` tones). Arabic first; English for EN mode. */
export function validityLabel(v: Validity, from?: Date | string | null): { ar: string; en: string; tone: "ok" | "wa" | "er" | "in" | "x" } | null {
  const n = v.daysLeft ?? 0;
  switch (v.state) {
    case "none": return null;
    case "upcoming": {
      const d = toDateOnly(from ?? null);
      return { ar: d ? `يبدأ ${displayDate(d)}` : "لم يبدأ", en: d ? `Starts ${displayDate(d)}` : "Not started", tone: "in" };
    }
    case "valid": return { ar: "ساري", en: "In force", tone: "ok" };
    case "expiring": return n === 0
      ? { ar: "ينتهي اليوم", en: "Ends today", tone: "wa" }
      : { ar: `ينتهي بعد ${n} يوم`, en: `Ends in ${n} day${n === 1 ? "" : "s"}`, tone: "wa" };
    case "expired": return { ar: "منتهي", en: "Expired", tone: "er" };
    case "renewed": return { ar: "جُدّد", en: "Renewed", tone: "x" };
  }
}

/** The header fact «العقد: ينتهي بعد X يوم» — only while a contract is inside its notice window. */
export function contractFactText(daysLeft: number): { ar: string; en: string } {
  if (daysLeft <= 0) return { ar: "ينتهي اليوم", en: "Ends today" };
  return { ar: `ينتهي بعد ${daysLeft} يوم`, en: `Ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` };
}

export type ValidityInput = { validFrom: Date | null; validUntil: Date | null; renewalNoticeDays: number | null };

/**
 * Check an edit of the dates. Absent keys keep the current value; null or "" clears it. Arabic first.
 * Only a CONTRACT or a PRICE_AGREEMENT takes dates (the database's CHECK says so too).
 */
export function parseValidityInput(
  body: Record<string, unknown>,
  current: ValidityInput & { category: string },
): { ok: true; value: ValidityInput } | { ok: false; error: string; errorEn: string; code: string } {
  const out: ValidityInput = { validFrom: current.validFrom, validUntil: current.validUntil, renewalNoticeDays: current.renewalNoticeDays };
  for (const key of ["validFrom", "validUntil"] as const) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === null || raw === "") { out[key] = null; continue; }
    const d = toDateOnly(raw);
    if (!d) return { ok: false, code: "BAD_DATE", error: "التاريخ غير صحيح.", errorEn: "That date is not valid." };
    if (d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100) return { ok: false, code: "BAD_DATE", error: "التاريخ غير صحيح.", errorEn: "That date is not valid." };
    out[key] = d;
  }
  if ("renewalNoticeDays" in body) {
    const raw = body.renewalNoticeDays;
    if (raw === null || raw === "") out.renewalNoticeDays = null;
    else {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 365) return { ok: false, code: "BAD_NOTICE_DAYS", error: "مدة التنبيه بين 1 و365 يومًا.", errorEn: "The notice period is 1 to 365 days." };
      out.renewalNoticeDays = n;
    }
  }
  const any = out.validFrom || out.validUntil || out.renewalNoticeDays !== null;
  if (any && !hasValidity(current.category)) {
    return { ok: false, code: "NO_VALIDITY_FOR_CATEGORY", error: "تاريخ البداية والنهاية للعقود واتفاقيات الأسعار فقط.", errorEn: "Start and end dates are for contracts and price agreements only." };
  }
  if (out.validFrom && out.validUntil && out.validUntil.getTime() < out.validFrom.getTime()) {
    return { ok: false, code: "END_BEFORE_START", error: "تاريخ الانتهاء قبل تاريخ البداية.", errorEn: "The end date is before the start date." };
  }
  return { ok: true, value: out };
}
