// The figures of a document a template prints, priced by the app's own helper — priceQuote
// (lib/services/sales/quotes.ts: each step rounded half-up to 2 dp, the grand total built from the
// stored components) — so an e-mailed quotation or invoice adds up exactly like the one on screen.
import { Decimal } from "@/lib/services/commissions/engine";
import { priceQuote } from "@/lib/services/sales/quotes";
import type { PricedDocument } from "./types";

export type DocLineInput = {
  description: string;
  skuCode?: string | null;
  quantity: string;
  unit: "KG" | "UNIT";
  /** Net unit price (before VAT). */
  unitPrice: string;
  discountPercent?: string;
  taxRatePercent: string;
};

const s2 = (d: Decimal) => d.toFixed(2);

export function priceDocument(lines: DocLineInput[]): PricedDocument {
  const p = priceQuote(lines.map((l, i) => ({
    description: l.description,
    quantity: new Decimal(l.quantity),
    unit: l.unit,
    unitPrice: new Decimal(l.unitPrice),
    discountPercent: new Decimal(l.discountPercent ?? "0"),
    taxRatePercent: new Decimal(l.taxRatePercent),
    position: i + 1,
  })));
  return {
    lines: lines.map((l, i) => ({
      description: l.description, skuCode: l.skuCode ?? null, quantity: l.quantity, unit: l.unit, unitPrice: new Decimal(l.unitPrice).toFixed(2),
      discountPercent: l.discountPercent ?? "0", taxRatePercent: l.taxRatePercent,
      gross: s2(p.lines[i].gross), discountAmount: s2(p.lines[i].discountAmount), lineSubtotal: s2(p.lines[i].lineSubtotal),
      lineTax: s2(p.lines[i].lineTax), lineTotal: s2(p.lines[i].lineTotal),
    })),
    subtotal: s2(p.subtotal),
    discountTotal: s2(p.discountTotal),
    taxable: s2(p.subtotal.minus(p.discountTotal)),
    taxTotal: s2(p.taxTotal),
    grandTotal: s2(p.grandTotal),
    effectiveDiscountPercent: p.effectiveDiscountPercent.toString(),
  };
}
