// «قوالب التأجيل» and «الموازنات» (20261122090000_budgets_deferrals) — the money math, PURE (no database; the screens use
// it for the preview, the services for the rows they write). One rule, defined once (council 04 · money & math):
//   amounts are split in integer HALALAS (bigint), each share rounded DOWN, and the remainder goes to the LAST month — so
//   the shares always add up to the amount exactly, never by a rounding line.
//
//   deferralSplit(total, months, startDay, rule)  the recognition schedule of a deferral:
//     START_MONTH    N equal months from the start date's month (the start month counts as a full month);
//     NEXT_MONTH     N equal months from the month after the start date;
//     DAILY_PRORATA  from the start DAY: the first month carries its days (days left ÷ days in the month) of one share,
//                    N − 1 full months follow, and the remainder falls in month N + 1 (a 1st-of-month start is START_MONTH).
//   spreadEvenly(total)                           a budget's annual amount over 12 months (the remainder in December).

import type { PostingLineInput } from "./posting-engine";

export const DEFERRAL_KINDS = ["PREPAID_EXPENSE", "DEFERRED_REVENUE"] as const;
export type DeferralKind = (typeof DEFERRAL_KINDS)[number];
export const START_RULES = ["START_MONTH", "NEXT_MONTH", "DAILY_PRORATA"] as const;
export type StartRule = (typeof START_RULES)[number];
export const MAX_DEFERRAL_MONTHS = 120;

// bigint without literals (the TypeScript target is below ES2020).
const B0 = BigInt(0), B11 = BigInt(11), B12 = BigInt(12), B100 = BigInt(100);

const MONEY_RE = /^-?\d{1,16}(\.\d{1,2})?$/;

/** "1234.5" → 123450n halalas; refuses more than 2 decimals or anything that is not a plain decimal. */
export function toHalalas(v: string | number): bigint {
  const t = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v ?? "").trim();
  if (!MONEY_RE.test(t)) throw new RangeError(`Not an amount with at most 2 decimals: "${v}".`);
  const neg = t.startsWith("-");
  const [i, f = ""] = (neg ? t.slice(1) : t).split(".");
  const h = BigInt(i) * B100 + BigInt((f + "00").slice(0, 2));
  return neg ? -h : h;
}

/** 123450n → "1234.50". */
export function fromHalalas(h: bigint): string {
  const neg = h < B0;
  const a = neg ? -h : h;
  return `${neg ? "-" : ""}${a / B100}.${String(a % B100).padStart(2, "0")}`;
}

/** The first day of the month `add` months after the month of `day` (UTC dates). */
export function monthStart(day: Date, add = 0): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + add, 1));
}
export const daysInMonth = (day: Date) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
export const monthEnd = (day: Date) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0));
/** "YYYY-MM" of a date. */
export const monthKey = (d: Date) => d.toISOString().slice(0, 7);

export type SplitLine = { seq: number; periodStart: Date; amount: string; days: number | null };

/**
 * The recognition lines of a deferral. `total` > 0 (2 decimals), 1 ≤ months ≤ 120, `startDay` a UTC date. Every line is
 * > 0; Σ = total exactly. Refuses an amount too small to give every month at least one halala.
 */
export function deferralSplit(total: string | number, months: number, startDay: Date, rule: StartRule): SplitLine[] {
  const t = toHalalas(total);
  if (t <= B0) throw new RangeError("The amount is greater than zero.");
  if (!Number.isInteger(months) || months < 1 || months > MAX_DEFERRAL_MONTHS) throw new RangeError(`Months are 1–${MAX_DEFERRAL_MONTHS}.`);
  if (!(startDay instanceof Date) || Number.isNaN(startDay.getTime())) throw new RangeError("The start date.");
  if (!(START_RULES as readonly string[]).includes(rule)) throw new RangeError("The start rule.");
  const n = BigInt(months);
  const share = t / n;
  if (share === B0) throw new RangeError("The amount is too small to spread over that many months (one halala each at least).");
  const out: SplitLine[] = [];
  const push = (periodStart: Date, h: bigint, days: number | null) => { if (h > B0) out.push({ seq: out.length + 1, periodStart, amount: fromHalalas(h), days }); };
  const day = startDay.getUTCDate();
  if (rule === "DAILY_PRORATA" && day !== 1) {
    const dim = daysInMonth(startDay);
    const left = dim - day + 1;
    const first = (share * BigInt(left)) / BigInt(dim);
    push(monthStart(startDay), first, left);
    let used = first;
    for (let i = 1; i < months; i++) { push(monthStart(startDay, i), share, null); used += share; }
    push(monthStart(startDay, months), t - used, null);
    return out;
  }
  const from = rule === "NEXT_MONTH" ? 1 : 0;
  let used = B0;
  for (let i = 0; i < months - 1; i++) { push(monthStart(startDay, from + i), share, null); used += share; }
  push(monthStart(startDay, from + months - 1), t - used, null);
  return out;
}

/** A budget's annual amount over the 12 months (rounded down per month, the remainder in December). Negative allowed. */
export function spreadEvenly(total: string | number): string[] {
  const t = toHalalas(total);
  const neg = t < B0;
  const a = neg ? -t : t;
  const share = a / B12;
  const out = Array.from({ length: 12 }, (_, i) => (i < 11 ? share : a - share * B11));
  return out.map((h) => fromHalalas(neg ? -h : h));
}

/** Σ of amounts (2 decimals) as a string, exactly. */
export function sumAmounts(values: (string | number | null | undefined)[]): string {
  return fromHalalas(values.reduce<bigint>((s, v) => (v === null || v === undefined || v === "" ? s : s + toHalalas(v)), B0));
}

/** Pure: the entry lines of a run — per schedule line, a debit and a credit of its amount (see the header). */
export function runEntryLines(items: { kind: string; amount: { toFixed(dp: number): string } | string; balanceAccountId: string; plAccountId: string; number: string; description: string; branchId: string | null; costCenterId: string | null }[]): PostingLineInput[] {
  const out: PostingLineInput[] = [];
  for (const it of items) {
    const amt = (typeof it.amount === "string" ? fromHalalas(toHalalas(it.amount)) : it.amount.toFixed(2));
    const dims = { branchId: it.branchId, costCenterId: it.costCenterId };
    const memo = `${it.number} · ${it.description}`.slice(0, 500);
    if (it.kind === "PREPAID_EXPENSE") {
      out.push({ accountId: it.plAccountId, debit: amt, description: `إثبات مصروف مدفوع مقدماً ${memo}`.slice(0, 500), dims });
      out.push({ accountId: it.balanceAccountId, credit: amt, description: `إطفاء مصروف مدفوع مقدماً ${memo}`.slice(0, 500), dims });
    } else {
      out.push({ accountId: it.balanceAccountId, debit: amt, description: `إطفاء إيراد مؤجل ${memo}`.slice(0, 500), dims });
      out.push({ accountId: it.plAccountId, credit: amt, description: `إثبات إيراد مؤجل ${memo}`.slice(0, 500), dims });
    }
  }
  return out;
}
