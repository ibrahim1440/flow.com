// ZATCA Phase 2 (A4) — the compliance-check samples (pure): which document types an EGS unit must prove (its TSCZ
// flags), and one sample of each with the taxpayer's real seller particulars, a test buyer and a throw-away chain.
import { randomUUID } from "node:crypto";
import type { SellerSnapshot } from "@/lib/services/invoicing/settings";
import type { UblDocument } from "./ubl";

export type CheckType = { family: "STANDARD" | "SIMPLIFIED"; kind: "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE" };
export function checkTypes(invoiceTypes: string): CheckType[] {
  const out: CheckType[] = [];
  for (const [i, family] of [[0, "STANDARD"], [1, "SIMPLIFIED"]] as const) {
    if (invoiceTypes[i] === "1") for (const kind of ["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"] as const) out.push({ family, kind });
  }
  return out;
}

/** A compliance sample of one type, with the real seller particulars and a test buyer. */
export function complianceSample(t: CheckType, seller: SellerSnapshot, chain: { icv: number; pih: string }, now = new Date()): UblDocument {
  const r = new Date(now.getTime() + 3 * 3_600_000).toISOString();
  const day = r.slice(0, 10), time = r.slice(11, 19);
  const std = t.family === "STANDARD";
  return {
    number: `CMPL-${t.family[0]}${t.kind[0]}-${chain.icv}`, uuid: randomUUID(), kind: t.kind, family: t.family, issueDate: day, issueTime: time, supplyDate: day,
    originalNumber: t.kind === "INVOICE" ? null : "CMPL-SI-1", reasonCode: t.kind === "INVOICE" ? null : "RETURN", reason: t.kind === "INVOICE" ? null : "Compliance check sample",
    seller: { name: seller.name ?? "", vatNumber: seller.vatNumber, crNumber: seller.crNumber, buildingNo: seller.buildingNo, street: seller.street, district: seller.district, city: seller.city, postalCode: seller.postalCode, additionalNo: seller.additionalNo, countryCode: "SA" },
    buyer: std
      ? { name: "Compliance Test Buyer", vatNumber: "399999999800003", buildingNo: "1234", street: "King Fahd Road", district: "Al Olaya", city: "Riyadh", postalCode: "12214", countryCode: "SA" }
      : { name: "Walk-in customer", vatNumber: null },
    lines: [{ description: "Specialty coffee 1 kg", quantity: "2", unit: "UNIT", unitPrice: "100.00", discountAmount: "0.00", taxCategory: "S", taxRatePercent: "15", lineNet: "200.00", lineTax: "30.00", lineTotal: "230.00" }],
    breakdown: [{ category: "S", rate: "15", taxable: "200.00", tax: "30.00" }],
    totals: { lineExtension: "200.00", taxable: "200.00", tax: "30.00", grand: "230.00" },
    icv: chain.icv, pih: chain.pih,
  };
}

