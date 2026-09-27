// Ledger money: Prisma.Decimal with two fraction digits (SAR halalas). Never a JS number in
// a calculation; numbers appear only at the API boundary as integer halalas for display.
import { Prisma } from "@/generated/prisma/client";
import { parseMoney } from "@/lib/finance/money";
import { AccountingError } from "./errors";

export const ZERO = new Prisma.Decimal(0);

export function dec(v: Prisma.Decimal | string | number | null | undefined): Prisma.Decimal {
  if (v === null || v === undefined) return ZERO;
  return new Prisma.Decimal(v);
}

/** Half-up to 2 places — the ledger's only rounding, applied where an amount is created. */
export function round2(v: Prisma.Decimal): Prisma.Decimal {
  return v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** User or API input → Decimal, exact to the halala, non-negative. */
export function parseAmount(raw: unknown, field = "amount"): Prisma.Decimal {
  const minor = parseMoney(raw);
  if (minor === null) throw new AccountingError(`${field} must be an amount with at most two decimals.`, 400);
  if (minor < 0) throw new AccountingError(`${field} must not be negative.`, 400);
  return new Prisma.Decimal(minor).div(100);
}

/** Decimal → integer halalas, for the UI's formatter. Exact for Decimal(18,2). */
export function toMinor(v: Prisma.Decimal | string | number | null | undefined): number {
  return dec(v).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}
