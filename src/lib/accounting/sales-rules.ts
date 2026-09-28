// Pure sales-document rules (no database): shared by the service, the tests and the editor.
import { Prisma } from "@/generated/prisma/client";
import { round2 } from "./money";

/** Line arithmetic, half-up to the halala at each step: gross amount, discount, net, VAT on the net. */
export function computeSalesLine(quantity: Prisma.Decimal, unitPrice: Prisma.Decimal, discountPercent: Prisma.Decimal, ratePercent: Prisma.Decimal) {
  const before = round2(quantity.mul(unitPrice));
  const discount = round2(before.mul(discountPercent).div(100));
  const net = before.sub(discount);
  const vat = round2(net.mul(ratePercent).div(100));
  return { net, vat, gross: net.add(vat) };
}

/** VAT contained in a VAT-inclusive amount (advance received), half-up to the halala. */
export function vatInside(gross: Prisma.Decimal, ratePercent: Prisma.Decimal) {
  if (ratePercent.isZero()) return new Prisma.Decimal(0);
  return round2(gross.mul(ratePercent).div(ratePercent.add(100)));
}
