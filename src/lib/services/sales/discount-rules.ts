// P0 security batch (owner decisions C1–C6, 11 Nov 2026; rep QA audit SEC-01 / SEC-02 / SEC-07): the ONE place the
// discount a document gives is measured, and the VAT treatments a line may carry. Pure — shared by the quotation service
// (quotes.ts), the direct sale / sample terms (direct-sale-terms.ts) and the invoice-draft edit (invoicing/draft-control.ts).
//
//   · The effective discount of a line is measured against its LIST value (the SKU's catalogue price × units):
//     1 − net ÷ list. A price typed below the list is a discount like a discount %.
//   · Only lines with an ACTIVE SKU priced above 0 enter the figure (C2). A line with no SKU, or an active SKU at price 0,
//     is a «custom line»: it needs a manager's approval before the document can be issued. An INACTIVE SKU is refused.
//   · The figure is the HIGHEST eligible line's (as the direct sale always measured it); above the threshold in force
//     (SystemConfig.quoteDiscountApprovalPercent) it needs a supervisor; above DISCOUNT_MAX (60 %) it is refused outright.
//   · VAT (C5 / C6): the standard rate (S at DEFAULT_VAT_RATE) unless an approved override; an override may only name a
//     legitimate ZATCA treatment with its reason code — Z (VATEX-SA-32/33/34-x/35), E (VATEX-SA-29/30), O (VATEX-SA-OOS).
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { DEFAULT_VAT_RATE } from "@/lib/services/invoicing/pricing";
import { aboveCeiling, aboveLimit, effectiveDiscountBp, percentToBp } from "./discount-measure";

type DV = string | number | Prisma.Decimal;
const D = (v: DV) => new Prisma.Decimal(v);

/**
 * 1 − net ÷ list value, in %, 2 dp, never below 0 (a price above the list is no discount). Pure.
 * HOTFIX quote-45: computed by the ONE fixed-point measure the editor uses too (discount-measure.ts).
 */
export function effectiveDiscount(listGross: Prisma.Decimal, lineNet: Prisma.Decimal): Prisma.Decimal {
  const bp = effectiveDiscountBp(listGross.toFixed(5), lineNet.toFixed(5));
  return bp == null ? D(0) : D(bp).dividedBy(100);
}

export type DiscountLine = {
  /** null: no SKU on the line (a custom line). */
  sku: { isActive: boolean; price: number | string | Prisma.Decimal } | null;
  quantity: DV;
  /** The line's amount after its own discount, before VAT. */
  lineNet: DV;
};

export type DiscountFigures = {
  /** The highest eligible line's effective discount (%, 2 dp); 0 with no eligible line. */
  maxEffective: Prisma.Decimal;
  /** Per line: its effective discount, or null for a custom line. */
  perLine: (Prisma.Decimal | null)[];
  customLines: number[];
  inactiveLines: number[];
  /** Lines whose effective discount is above the hard ceiling. */
  overCeiling: number[];
};

/** The discount a document gives, measured against the list (C2). Pure. */
export function discountFigures(lines: DiscountLine[]): DiscountFigures {
  const perLine: (Prisma.Decimal | null)[] = [];
  const customLines: number[] = [], inactiveLines: number[] = [], overCeiling: number[] = [];
  let max = D(0);
  lines.forEach((l, i) => {
    if (l.sku && !l.sku.isActive) { inactiveLines.push(i); perLine.push(null); return; }
    const price = l.sku ? D(String(l.sku.price)) : D(0);
    if (!l.sku || price.lessThanOrEqualTo(0)) { customLines.push(i); perLine.push(null); return; }
    const eff = effectiveDiscount(price.times(D(String(l.quantity))), D(String(l.lineNet)));
    perLine.push(eff);
    if (aboveCeiling(percentToBp(eff.toFixed(2)))) overCeiling.push(i);
    if (eff.greaterThan(max)) max = eff;
  });
  return { maxEffective: max, perLine, customLines, inactiveLines, overCeiling };
}

/** Does this document need a supervisor? (custom lines, or the figure above the threshold) Pure. */
export function needsApproval(f: DiscountFigures, threshold: DV): boolean {
  // HOTFIX quote-45: strictly above, in basis points — exactly the limit (45.00 at 45) does not need a supervisor.
  return f.customLines.length > 0 || aboveLimit(percentToBp(f.maxEffective.toFixed(2)), String(threshold));
}

// ── VAT treatments (C5 / C6) ──────────────────────────────────────────────────────────────────────

export type TaxTreatment = { taxCategory: "S" | "Z" | "E" | "O"; taxRatePercent: string; exemptionReasonCode: string | null };

const Z_CODES = /^VATEX-SA-(32|33|34-[1-5]|35)$/;
const E_CODES = /^VATEX-SA-(29|30)$/;

/** The standard treatment (S at the configured standard rate). Pure. */
export const isStandard = (t: { taxCategory?: string | null; taxRatePercent: DV }) =>
  (t.taxCategory ?? "S") === "S" && D(String(t.taxRatePercent)).equals(D(DEFAULT_VAT_RATE));

/** A legitimate ZATCA treatment with its reason code — the only targets an override may name. Pure. */
export function legitimateTreatment(t: TaxTreatment): boolean {
  const zero = D(String(t.taxRatePercent)).isZero();
  switch (t.taxCategory) {
    case "S": return D(String(t.taxRatePercent)).equals(D(DEFAULT_VAT_RATE)) && !t.exemptionReasonCode;
    case "Z": return zero && !!t.exemptionReasonCode && Z_CODES.test(t.exemptionReasonCode);
    case "E": return zero && !!t.exemptionReasonCode && E_CODES.test(t.exemptionReasonCode);
    case "O": return zero && t.exemptionReasonCode === "VATEX-SA-OOS";
    default: return false;
  }
}

// ── Fingerprints (C3 / C4) ────────────────────────────────────────────────────────────────────────

/** A stable JSON (sorted keys) — what a fingerprint is taken over. Pure. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/** sha256 (hex) of the canonical form. Pure. */
export const fingerprint = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

/** A decimal as a fingerprint reads it (so "15" and "15.00" are the same term). Pure. */
export const num = (v: DV | null | undefined) => (v === null || v === undefined ? null : D(String(v)).toString());
