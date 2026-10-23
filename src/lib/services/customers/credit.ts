// Credit warnings, grace days and the manual sales hold («إيقاف البيع») — the pure rules.
//
// Owner design (feat/credit-hold):
//   * WARNINGS are automatic and derived on read, never stored: «متجاوز حد الائتمان» when the
//     customer's outstanding balance is above its credit limit, «متأخر السداد N يوم» when any open
//     debt is past its due date. Both come from the existing statement / aging logic
//     (aggregates.ts statementOfAccount: due = the first delivery of an order made from the
//     quotation, else its acceptance, + the customer's payment terms) over ALL the customer's
//     deals — a warning is about the customer, not about the viewer's share of it.
//   * A GRACE («مهلة سماح») is a number of days recorded on the customer; while it runs the
//     warnings are replaced by «مهلة سماح حتى <date>». No hold. When it ends and the customer is
//     still over / overdue, the warnings come back by themselves.
//   * A HOLD is placed by a person, never by the system. While it is in force no new quotation or
//     order is created for the customer. It ends by hand, at its end date (autoLiftAtEnd), or when
//     the customer is back within its limit with nothing overdue (autoLiftOnPayment; always so
//     for «حتى السداد»). The automatic endings are decided here, on read and at creation (the
//     schedule's MISSED pattern) — there is no job.
//
// No database and no HTTP: every rule is asserted directly (tests/sales/unit/credit-hold.test.ts).
// credit-db.ts reads the rows and writes the results.

import { Decimal, ZERO, roundMoney } from "../commissions/engine";

export const DAY_MS = 86_400_000;
const RIYADH_OFFSET = 3 * 3_600_000;

/** The duration the hold dialog proposes when the customer has no «مدة الإيقاف الافتراضية». */
export const FALLBACK_HOLD_DAYS = 14;
export const MAX_GRACE_DAYS = 90;
export const MAX_HOLD_DAYS = 365;
export const GRACE_CHIPS = [3, 7, 14] as const;
export const HOLD_CHIPS = [7, 14, 30] as const;

export const HOLD_BASES = ["OVER_LIMIT", "OVERDUE", "BOTH", "OTHER"] as const;
export type HoldBasis = (typeof HOLD_BASES)[number];
export type LiftKind = "MANUAL" | "EXPIRED" | "PAID";

/** What the figures say about the customer, before any grace or hold. */
export type CreditFlags = {
  /** A credit limit is set and the outstanding balance is above it. */
  overLimit: boolean;
  /** outstanding − limit when over, else 0 (shown only to viewers who see every deal). */
  amountOver: Decimal;
  /** The oldest open debt's whole Riyadh days past its due date; 0 when nothing is overdue. */
  overdueDays: number;
  /** Σ unpaid of the documents past their due date. */
  overdueAmount: Decimal;
  outstanding: Decimal;
  limit: Decimal | null;
  /** Within the limit (or none) and nothing overdue — the condition a hold lifts on payment. */
  clear: boolean;
};

/**
 * The flags of one customer from its credit limit and the statement's open documents
 * (statementOfAccount(...).open and totals.outstanding).
 */
export function creditFlags(
  limit: Decimal | null,
  outstanding: Decimal,
  open: { unpaid: Decimal; daysOverdue: number }[],
): CreditFlags {
  const overLimit = limit != null && outstanding.greaterThan(limit);
  let overdueDays = 0;
  let overdueAmount = ZERO;
  for (const o of open) {
    if (o.daysOverdue > 0 && o.unpaid.greaterThan(0)) {
      overdueDays = Math.max(overdueDays, o.daysOverdue);
      overdueAmount = overdueAmount.plus(o.unpaid);
    }
  }
  return {
    overLimit,
    amountOver: overLimit && limit != null ? roundMoney(outstanding.minus(limit)) : ZERO,
    overdueDays,
    overdueAmount: roundMoney(overdueAmount),
    outstanding: roundMoney(outstanding),
    limit: limit == null ? null : roundMoney(limit),
    clear: !overLimit && overdueDays === 0,
  };
}

/** The basis a new hold records and the reason the dialog proposes for it. */
export function holdBasis(flags: Pick<CreditFlags, "overLimit" | "overdueDays">): HoldBasis {
  if (flags.overLimit && flags.overdueDays > 0) return "BOTH";
  if (flags.overLimit) return "OVER_LIMIT";
  if (flags.overdueDays > 0) return "OVERDUE";
  return "OTHER";
}
export const BASIS_REASON_AR: Record<HoldBasis, string> = {
  OVER_LIMIT: "تجاوز حد الائتمان",
  OVERDUE: "تأخر السداد",
  BOTH: "تجاوز حد الائتمان وتأخر السداد",
  OTHER: "",
};
export const BASIS_REASON_EN: Record<HoldBasis, string> = {
  OVER_LIMIT: "Credit limit exceeded",
  OVERDUE: "Overdue payment",
  BOTH: "Credit limit exceeded and overdue payment",
  OTHER: "",
};

// ── Grace ──────────────────────────────────────────────────────────────────────────────────

export type GraceRow = { id: string; days: number; untilAt: Date; reason: string | null; createdAt: Date; actor: { id: string; name: string } | null };

/** The grace in force at `now`: the newest one whose end is still ahead. */
export function activeGrace(graces: GraceRow[], now: Date): GraceRow | null {
  let best: GraceRow | null = null;
  for (const g of graces) {
    if (g.untilAt.getTime() <= now.getTime()) continue;
    if (!best || g.createdAt.getTime() > best.createdAt.getTime()) best = g;
  }
  return best;
}

/** How many graces the customer has had, and the last one — the dialog's repeat warning. */
export function graceHistory(graces: GraceRow[]): { count: number; last: { at: Date; days: number; untilAt: Date } | null } {
  const last = [...graces].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return { count: graces.length, last: last ? { at: last.createdAt, days: last.days, untilAt: last.untilAt } : null };
}

/** A grace of `days` from `now` ends exactly `days` × 24 h later. */
export function graceUntil(now: Date, days: number): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

// ── Hold ───────────────────────────────────────────────────────────────────────────────────

export type HoldRow = {
  id: string;
  reason: string;
  basis: string;
  startsAt: Date;
  endsAt: Date | null;
  autoLiftAtEnd: boolean;
  autoLiftOnPayment: boolean;
  createdAt: Date;
  createdBy: { id: string; name: string } | null;
};

/**
 * Is an unlifted hold still in force at `now`, and if not, how did it end?
 *   EXPIRED — autoLiftAtEnd and its end has passed (it ended AT its end date);
 *   PAID    — autoLiftOnPayment and the customer is clear (within the limit, nothing overdue).
 * A hold with neither option stays until somebody lifts it, whatever its end date says (the date
 * is then a review date).
 */
export function holdVerdict(
  hold: Pick<HoldRow, "endsAt" | "autoLiftAtEnd" | "autoLiftOnPayment">,
  flags: Pick<CreditFlags, "clear">,
  now: Date,
): { inForce: true } | { inForce: false; liftKind: Exclude<LiftKind, "MANUAL">; at: Date } {
  if (hold.autoLiftAtEnd && hold.endsAt && hold.endsAt.getTime() <= now.getTime()) {
    return { inForce: false, liftKind: "EXPIRED", at: hold.endsAt };
  }
  if (hold.autoLiftOnPayment && flags.clear) return { inForce: false, liftKind: "PAID", at: now };
  return { inForce: true };
}

export type HoldInput = {
  reason: string;
  /** Whole days, or null for «حتى السداد». */
  days: number | null;
  autoLiftAtEnd: boolean;
  autoLiftOnPayment: boolean;
};

type Problem = { ok: false; status: 400 | 409; code: string; error: string; errorEn: string };
const problem = (status: 400 | 409, code: string, error: string, errorEn: string): Problem => ({ ok: false, status, code, error, errorEn });
const clean = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "");
const arabicDigits = (s: string) =>
  s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
function wholeDays(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\d+$/.test(arabicDigits(v.trim()))) return Number(arabicDigits(v.trim()));
  return null;
}

/**
 * A hold request body → the hold to place, or why not.
 *   reason            1–500 characters (the dialog pre-fills it from the warning);
 *   untilPaid: true   «حتى السداد»: no end date, lifts on payment (forced);
 *   days              otherwise 1–365;
 *   autoLiftAtEnd     default true for a timed hold;
 *   autoLiftOnPayment default false for a timed hold.
 */
export function parseHoldInput(b: Record<string, unknown>): { ok: true; value: HoldInput } | Problem {
  const reason = clean(b.reason);
  if (reason.length < 1) return problem(400, "REASON_REQUIRED", "اكتب سبب الإيقاف.", "Give the reason for the hold.");
  if (reason.length > 500) return problem(400, "REASON_TOO_LONG", "سبب الإيقاف أطول من 500 حرف.", "The reason is longer than 500 characters.");
  if (b.untilPaid === true) {
    return { ok: true, value: { reason, days: null, autoLiftAtEnd: false, autoLiftOnPayment: true } };
  }
  const days = wholeDays(b.days);
  if (days == null || days < 1 || days > MAX_HOLD_DAYS) {
    return problem(400, "BAD_DAYS", `مدة الإيقاف أيام صحيحة من 1 إلى ${MAX_HOLD_DAYS}، أو «حتى السداد».`, `The hold lasts 1 to ${MAX_HOLD_DAYS} whole days, or until paid.`);
  }
  return {
    ok: true,
    value: {
      reason, days,
      autoLiftAtEnd: b.autoLiftAtEnd === undefined ? true : b.autoLiftAtEnd === true,
      autoLiftOnPayment: b.autoLiftOnPayment === true,
    },
  };
}

/** A grace request body → days and reason. */
export function parseGraceInput(b: Record<string, unknown>): { ok: true; value: { days: number; reason: string | null; confirmRepeat: boolean } } | Problem {
  const days = wholeDays(b.days);
  if (days == null || days < 1 || days > MAX_GRACE_DAYS) {
    return problem(400, "BAD_DAYS", `أيام السماح عدد صحيح من 1 إلى ${MAX_GRACE_DAYS}.`, `Grace is 1 to ${MAX_GRACE_DAYS} whole days.`);
  }
  const reason = clean(b.reason);
  if (reason.length > 500) return problem(400, "REASON_TOO_LONG", "السبب أطول من 500 حرف.", "The reason is longer than 500 characters.");
  return { ok: true, value: { days, reason: reason || null, confirmRepeat: b.confirmRepeat === true } };
}

/** A lift request body → the reason (required). */
export function parseLiftInput(b: Record<string, unknown>): { ok: true; value: { reason: string } } | Problem {
  const reason = clean(b.reason);
  if (reason.length < 1) return problem(400, "REASON_REQUIRED", "اكتب سبب رفع الإيقاف.", "Give the reason for lifting the hold.");
  if (reason.length > 500) return problem(400, "REASON_TOO_LONG", "السبب أطول من 500 حرف.", "The reason is longer than 500 characters.");
  return { ok: true, value: { reason } };
}

/** The end of a hold of `days` from `now` (null for «حتى السداد»). */
export function holdEnds(now: Date, days: number | null): Date | null {
  return days == null ? null : new Date(now.getTime() + days * DAY_MS);
}

// ── What the screens show ──────────────────────────────────────────────────────────────────

/**
 * The warning after the grace and the hold have had their say:
 *   hold   — in force → the red banner; quotations and orders refused;
 *   grace  — in force → «مهلة سماح حتى …» instead of the warnings;
 *   overLimit / overdueDays — the red badges otherwise.
 */
export function creditWarning(flags: CreditFlags, grace: GraceRow | null, hold: HoldRow | null): {
  overLimit: boolean; overdueDays: number; grace: GraceRow | null; hold: HoldRow | null; any: boolean;
} {
  const suppressed = !!grace;
  const overLimit = !suppressed && flags.overLimit;
  const overdueDays = suppressed ? 0 : flags.overdueDays;
  return { overLimit, overdueDays, grace, hold, any: !!hold || overLimit || overdueDays > 0 };
}

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** «30 أكتوبر 2026» / «30 Oct 2026», on the Riyadh calendar. */
export function riyadhDate(d: Date, lang: "ar" | "en"): string {
  const r = new Date(d.getTime() + RIYADH_OFFSET);
  return lang === "ar"
    ? `${r.getUTCDate()} ${AR_MONTHS[r.getUTCMonth()]} ${r.getUTCFullYear()}`
    : `${r.getUTCDate()} ${EN_MONTHS[r.getUTCMonth()]} ${r.getUTCFullYear()}`;
}

/**
 * The refusal of a new quotation or order while a hold is in force — 409 CUSTOMER_SALES_HOLD,
 * naming the reason, the end and whom to ask. Thrown as a domain refusal (handleDomainError).
 */
export function salesHoldRefusal(hold: Pick<HoldRow, "reason" | "endsAt" | "createdBy">): {
  _appCode: 409; code: "CUSTOMER_SALES_HOLD"; message: string; errorAr: string; errorEn: string;
} {
  const untilAr = hold.endsAt ? `حتى ${riyadhDate(hold.endsAt, "ar")}` : "حتى السداد";
  const untilEn = hold.endsAt ? `until ${riyadhDate(hold.endsAt, "en")}` : "until the balance is paid";
  const who = hold.createdBy?.name;
  const ar = `البيع لهذا العميل موقوف ${untilAr}. السبب: ${hold.reason}. لا يمكن إنشاء عرض سعر أو طلب جديد له؛ ${who ? `تواصل مع ${who} أو مع مدير المنشأة لرفع الإيقاف.` : "تواصل مع مدير المنشأة لرفع الإيقاف."} الطلبات القائمة والتسليمات مستمرة.`;
  const en = `Sales to this customer are on hold ${untilEn}. Reason: ${hold.reason}. No new quotation or order can be created; ${who ? `contact ${who} or the administrator to lift the hold.` : "contact the administrator to lift the hold."} Existing orders and deliveries continue.`;
  return { _appCode: 409, code: "CUSTOMER_SALES_HOLD", message: ar, errorAr: ar, errorEn: en };
}
