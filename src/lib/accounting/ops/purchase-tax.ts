// Unified inventory phase 2 — purchase VAT categories (accounting council: chief accountant + tax + architect;
// migration 20261113090000_purchase_invoice_phase2). The EXISTING TaxCategory model carries them (appliesTo PURCHASES,
// inputVatTreatment, vatReturnBox); this file is the one place that reads their meaning.
//
//   code      rate  treatment         posting (on approval)                                         VAT-return box
//   P-S15     15    RECOVERABLE       Dr item / expense net, Dr VAT_INPUT vat, Cr AP gross         7  standard-rated purchases
//   P-S15-NR  15    NON_RECOVERABLE   Dr item / expense net + vat (capitalised), Cr AP gross        —  shown as not claimable
//   P-Z0      0     NONE              no VAT line                                                  10 zero-rated purchases
//   P-E0      0     NONE              no VAT line                                                  11 exempt purchases
//   P-O       0     NONE              no VAT line                                                  —  not on the return
//   P-IMP15   15    IMPORT            Dr VAT_INPUT vat, Cr AP (the customs / broker party)          8  imports, VAT paid at customs
//   P-RC15    15    REVERSE_CHARGE    Dr expense net, Dr VAT_INPUT vat, Cr VAT_OUTPUT vat, Cr AP net 9  imports, reverse charge
//
// THE BOX DEFINITIONS AND RULES MUST BE CHECKED against current ZATCA guidance (zatca.gov.sa) before filing: the VAT
// return built from them is a working paper for the accountant, not a filing.
import type { Prisma, TaxCategory } from "@/generated/prisma/client";
import { PURCHASE_TAX_CODES, type PurchaseTaxCode } from "@/lib/purchases/tax-codes";
import { buildTaxCategorySnapshot, type TaxCategorySnapshot } from "../tax-snapshot";

type Db = Prisma.TransactionClient;

// The codes and the supplier's default live in a pure module the invoice form also reads.
export { PURCHASE_TAX_CODES, defaultPurchaseTaxCode, type PurchaseTaxCode } from "@/lib/purchases/tax-codes";
export type InputVatTreatment = "RECOVERABLE" | "NON_RECOVERABLE" | "NONE" | "IMPORT" | "REVERSE_CHARGE";

/** A legacy line given only a rate (the A3 API): 15 → P-S15, 0 → P-Z0 (the migration's back-fill rule). */
export function purchaseTaxCodeForRate(rate: number): PurchaseTaxCode | null {
  return rate === 15 ? "P-S15" : rate === 0 ? "P-Z0" : null;
}

/**
 * Is the line's VAT claimed as input VAT (a recoverable, import or reverse-charge line)? Deny by default: a line with
 * no known treatment (an unclassified legacy rate) claims nothing — the posting refuses it anyway.
 */
export function claimsInputVat(t: string | null | undefined): boolean {
  return t === "RECOVERABLE" || t === "IMPORT" || t === "REVERSE_CHARGE";
}

export type PurchaseTaxSnapshot = TaxCategorySnapshot & { appliesTo: string; inputVatTreatment: string | null; vatReturnBox: string | null };

/** The immutable snapshot written on a line when its invoice is posted (mirrors buildTaxCategorySnapshot). */
export function buildPurchaseTaxSnapshot(tc: TaxCategory): PurchaseTaxSnapshot {
  return { ...buildTaxCategorySnapshot(tc), appliesTo: tc.appliesTo, inputVatTreatment: tc.inputVatTreatment, vatReturnBox: tc.vatReturnBox };
}

/** The purchase tax categories by id and by code (active ones). */
export async function purchaseTaxCategories(db: Db | { taxCategory: Db["taxCategory"] }) {
  const rows = await db.taxCategory.findMany({ where: { code: { in: [...PURCHASE_TAX_CODES] } } });
  return { byId: new Map(rows.map((r) => [r.id, r])), byCode: new Map(rows.map((r) => [r.code, r])) };
}
