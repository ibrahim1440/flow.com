// Cash-flow classification rules, kept free of database imports so they can be unit-tested.
// The template defaults are PROVISIONAL (DECISION_PACK: cash-flow classification) until the
// accountant approves them; any account can be classified explicitly in the chart of accounts.
import type { CashFlowClass } from "@/generated/prisma/client";

export type Acc = { id: string; code: string; nameAr: string | null; nameEn: string; type: string; controlKind: string; cashFlowClass: CashFlowClass | null };

/** Template default for a chart-of-accounts code (the accountant may change it per account). */
export function defaultCashFlowClass(a: { code: string; type: string; control?: string | null }): CashFlowClass | null {
  if (a.type === "REVENUE" || a.type === "EXPENSE") return null;
  if (a.control === "CASH") return "CASH";
  if (a.code === "3200" || a.code === "3900") return "EXCLUDED";
  if (a.type === "EQUITY") return "FINANCING";
  // Fixed assets and their accumulated depreciation; payables for fixed assets.
  if (a.code.startsWith("12") || a.code === "2195") return "INVESTING";
  if (a.code === "2220") return "FINANCING";
  return "OPERATING";
}

/** The class used in the statement, and whether it came from the account or a fallback. */
export function effectiveClass(a: Acc): { cls: CashFlowClass | null; defaulted: boolean } {
  if (a.type === "REVENUE" || a.type === "EXPENSE") return { cls: null, defaulted: false };
  if (a.cashFlowClass) return { cls: a.cashFlowClass, defaulted: false };
  return { cls: defaultCashFlowClass({ code: a.code, type: a.type, control: a.controlKind }), defaulted: true };
}
