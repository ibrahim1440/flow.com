// Phase 2 — the purchase VAT categories as the invoice form shows them (codes seeded by migration
// 20261113090000_purchase_invoice_phase2; their meaning and the posting are in src/lib/accounting/ops/purchase-tax.ts).
// Pure: no imports, safe in the browser and in unit tests. The box definitions must be checked against current ZATCA
// guidance (zatca.gov.sa) before filing — the VAT return built from them is a working paper, not a filing.
export const PURCHASE_TAX_CODES = ["P-S15", "P-S15-NR", "P-Z0", "P-E0", "P-O", "P-IMP15", "P-RC15"] as const;
export type PurchaseTaxCode = (typeof PURCHASE_TAX_CODES)[number];

/** The words on the screen, the rate (%) and the VAT-return box (null = not on the return). */
export const PURCHASE_TAX_INFO: Record<PurchaseTaxCode, { ar: string; en: string; rate: number; box: number | null }> = {
  "P-S15": { ar: "أساسية 15% · قابلة للاسترداد", en: "Standard 15% · recoverable", rate: 15, box: 7 },
  "P-S15-NR": { ar: "أساسية 15% · غير قابلة للاسترداد", en: "Standard 15% · not recoverable", rate: 15, box: null },
  "P-Z0": { ar: "صفرية", en: "Zero-rated", rate: 0, box: 10 },
  "P-E0": { ar: "معفاة", en: "Exempt", rate: 0, box: 11 },
  "P-O": { ar: "خارج النطاق / مورد غير مسجل", en: "Out of scope / unregistered supplier", rate: 0, box: null },
  "P-IMP15": { ar: "استيراد عبر الجمارك", en: "Import through customs", rate: 15, box: 8 },
  "P-RC15": { ar: "احتساب عكسي", en: "Reverse charge", rate: 15, box: 9 },
};

export const isPurchaseTaxCode = (c: unknown): c is PurchaseTaxCode => typeof c === "string" && (PURCHASE_TAX_CODES as readonly string[]).includes(c);

/** The default code of a supplier: non-resident → reverse charge; no VAT number → out of scope; else standard. */
export function defaultPurchaseTaxCode(s: { vatNumber?: string | null; isNonResident?: boolean | null } | null | undefined): PurchaseTaxCode {
  if (s?.isNonResident) return "P-RC15";
  if (!s?.vatNumber) return "P-O";
  return "P-S15";
}

/**
 * The default of one line: the supplier's default, except that reverse charge is for services (an expense line) —
 * goods from a non-resident supplier are out of scope on its invoice (their VAT is paid at customs, P-IMP15).
 */
export type PurchaseLineKind = "STOCK" | "GRN" | "EXPENSE" | "IMPORT_VAT" | "LANDED_COST";
export function defaultLineTaxCode(lineKind: PurchaseLineKind, s: { vatNumber?: string | null; isNonResident?: boolean | null } | null | undefined): PurchaseTaxCode {
  if (lineKind === "IMPORT_VAT") return "P-IMP15";
  const d = defaultPurchaseTaxCode(s);
  return d === "P-RC15" && lineKind !== "EXPENSE" && lineKind !== "LANDED_COST" ? "P-O" : d;
}

/**
 * The codes a line may choose (import VAT is its own line kind; reverse charge is for a non-resident's services or
 * freight; a landed cost takes P-S15, P-S15-NR, P-O or — a non-resident carrier — P-RC15).
 */
export function lineTaxChoices(lineKind: PurchaseLineKind, s: { isNonResident?: boolean | null } | null | undefined): PurchaseTaxCode[] {
  if (lineKind === "IMPORT_VAT") return ["P-IMP15"];
  if (lineKind === "LANDED_COST") return s?.isNonResident ? ["P-S15", "P-S15-NR", "P-O", "P-RC15"] : ["P-S15", "P-S15-NR", "P-O"];
  const base: PurchaseTaxCode[] = ["P-S15", "P-S15-NR", "P-Z0", "P-E0", "P-O"];
  return lineKind === "EXPENSE" && s?.isNonResident ? [...base, "P-RC15"] : base;
}

/** CA2: import VAT is billed by customs or a clearing agent (Supplier.kind), never by a non-resident. */
export function mayBillImportVat(s: { kind?: string | null; isNonResident?: boolean | null } | null | undefined): boolean {
  return !!s && !s.isNonResident && (s.kind === "CUSTOMS" || s.kind === "CLEARING_AGENT");
}
