// Pure supplier-bill rules (no database): shared by the service, the tests and — through its
// integer mirror in the editor — the screen.
import { Prisma } from "@/generated/prisma/client";
import { round2 } from "./money";

/** KSA VAT registration number: 15 digits, first and last digit 3. */
export function isKsaVatNumber(v: unknown): boolean {
  return typeof v === "string" && /^3\d{13}3$/.test(v.trim());
}

/** Line arithmetic, half-up to the halala at each step: net, then VAT on the net. */
export function computeLine(quantity: Prisma.Decimal, unitPrice: Prisma.Decimal, ratePercent: Prisma.Decimal) {
  const net = round2(quantity.mul(unitPrice));
  const vat = round2(net.mul(ratePercent).div(100));
  return { net, vat, gross: net.add(vat) };
}

