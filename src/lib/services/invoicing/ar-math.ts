// Sales invoicing A2 — the AR sub-ledger arithmetic. Pure: open items, FIFO application, aging buckets and the
// customer statement's running balance, over rows the caller has read. Money is Decimal throughout.
//
// The AR picture of one customer:
//   debit items  — ISSUED invoices and debit notes; open = total − Σ APPLIED applications (receipts + credits);
//   credit items — APPROVED receipts not (fully) applied (customer credit / advance) and ISSUED credit notes not
//                  (fully) applied (their credit); unapplied = amount − Σ APPLIED applications from it;
//   balance      = Σ open debit items − Σ unapplied credits  (= Σ invoices + debit notes − credit notes − receipts).
// The general ledger agrees by construction (POSTING-CONTRACT §4): AR holds invoices − credit notes − applied
// receipts, CUSTOMER_ADVANCES the unapplied receipts.
import { Decimal, ZERO } from "@/lib/accounting/money";

export type DebitItem = { id: string; kind: "INVOICE" | "DEBIT_NOTE"; number: string; issueDate: string; dueDate: string | null; total: Decimal; applied: Decimal };
export type CreditItem = { id: string; kind: "RECEIPT" | "CREDIT_NOTE"; ref: string; date: string; amount: Decimal; applied: Decimal };

export const openOf = (d: { total: Decimal; applied: Decimal }) => d.total.minus(d.applied);
export const unappliedOf = (c: { amount: Decimal; applied: Decimal }) => c.amount.minus(c.applied);

const DAY = 86_400_000;
export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY);
}

/** Days past due on `asOf` (0 or negative = not yet due). No due date: due on issue. */
export function daysOverdue(item: Pick<DebitItem, "issueDate" | "dueDate">, asOf: string): number {
  return daysBetween(item.dueDate ?? item.issueDate, asOf);
}

export const AGING_BUCKETS = [
  { key: "current", ar: "غير مستحق بعد", en: "Current", min: -Infinity, max: 0 },
  { key: "d1_30", ar: "1–30 يومًا", en: "1–30 days", min: 1, max: 30 },
  { key: "d31_60", ar: "31–60 يومًا", en: "31–60 days", min: 31, max: 60 },
  { key: "d61_90", ar: "61–90 يومًا", en: "61–90 days", min: 61, max: 90 },
  { key: "d90p", ar: "أكثر من 90 يومًا", en: "Over 90 days", min: 91, max: Infinity },
] as const;
export type BucketKey = (typeof AGING_BUCKETS)[number]["key"];

export function bucketOf(days: number): BucketKey {
  return AGING_BUCKETS.find((b) => days >= b.min && days <= b.max)!.key;
}

export type Aging = Record<BucketKey, Decimal> & { totalOpen: Decimal; unappliedCredit: Decimal; balance: Decimal; overdue: Decimal; oldestOverdueDays: number };

export function agingOf(debits: DebitItem[], credits: CreditItem[], asOf: string): Aging {
  const a = { current: ZERO, d1_30: ZERO, d31_60: ZERO, d61_90: ZERO, d90p: ZERO } as Record<BucketKey, Decimal>;
  let totalOpen = ZERO, overdue = ZERO, oldest = 0;
  for (const d of debits) {
    const open = openOf(d);
    if (open.lessThanOrEqualTo(0)) continue;
    const days = daysOverdue(d, asOf);
    const k = bucketOf(days);
    a[k] = a[k].plus(open);
    totalOpen = totalOpen.plus(open);
    if (days > 0) { overdue = overdue.plus(open); oldest = Math.max(oldest, days); }
  }
  const unappliedCredit = credits.reduce((s, c) => s.plus(Decimal.max(unappliedOf(c), ZERO)), ZERO);
  return { ...a, totalOpen, unappliedCredit, balance: totalOpen.minus(unappliedCredit), overdue, oldestOverdueDays: oldest };
}

/**
 * Apply `amount` to open debit items, oldest due first (then oldest issue, then number). Returns the parts
 * (each ≤ the item's open amount) and what is left unapplied. Never applies more than `amount`.
 */
export function allocateFifo(amount: Decimal, debits: DebitItem[]): { parts: { id: string; amount: Decimal }[]; left: Decimal } {
  const order = [...debits]
    .filter((d) => openOf(d).greaterThan(0))
    .sort((x, y) => (x.dueDate ?? x.issueDate).localeCompare(y.dueDate ?? y.issueDate) || x.issueDate.localeCompare(y.issueDate) || x.number.localeCompare(y.number));
  let left = amount;
  const parts: { id: string; amount: Decimal }[] = [];
  for (const d of order) {
    if (left.lessThanOrEqualTo(0)) break;
    const take = Decimal.min(left, openOf(d));
    parts.push({ id: d.id, amount: take });
    left = left.minus(take);
  }
  return { parts, left };
}

/** Check a manual application request against the open figures: the reason it is refused, or null. */
export function applicationRefusal(amount: Decimal, source: { amount: Decimal; applied: Decimal }, target: { total: Decimal; applied: Decimal }): { code: string; ar: string; en: string } | null {
  if (amount.lessThanOrEqualTo(0) || !amount.equals(amount.toDecimalPlaces(2))) return { code: "AMOUNT", ar: "المبلغ رقم موجب بمنزلتين عشريتين.", en: "The amount is positive, with at most 2 decimals." };
  if (amount.greaterThan(unappliedOf(source))) return { code: "OVER_SOURCE", ar: "المبلغ أكبر من غير المخصص في السند.", en: "The amount is more than the receipt or credit has left." };
  if (amount.greaterThan(openOf(target))) return { code: "OVER_INVOICE", ar: "المبلغ أكبر من المتبقي على الفاتورة.", en: "The amount is more than the invoice still owes." };
  return null;
}

export type StatementMove = { date: string; at: string; kind: "INVOICE" | "DEBIT_NOTE" | "CREDIT_NOTE" | "RECEIPT" | "RECEIPT_REVERSED"; ref: string; id: string; debit: Decimal; credit: Decimal; memo?: string | null };

/** The statement of account: the balance before `from`, the moves in [from, to] with a running balance, the closing. */
export function statementOf(moves: StatementMove[], from: string | null, to: string | null) {
  const sorted = [...moves].sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at) || a.ref.localeCompare(b.ref));
  let opening = ZERO;
  const rows: (StatementMove & { balance: Decimal })[] = [];
  let bal = ZERO;
  for (const m of sorted) {
    if (from && m.date < from) { opening = opening.plus(m.debit).minus(m.credit); continue; }
    if (to && m.date > to) continue;
    if (rows.length === 0) bal = opening;
    bal = bal.plus(m.debit).minus(m.credit);
    rows.push({ ...m, balance: bal });
  }
  const totalDebit = rows.reduce((s, r) => s.plus(r.debit), ZERO);
  const totalCredit = rows.reduce((s, r) => s.plus(r.credit), ZERO);
  return { opening, rows, totalDebit, totalCredit, closing: opening.plus(totalDebit).minus(totalCredit) };
}
