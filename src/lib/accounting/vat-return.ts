// Accounting A5 — the KSA VAT return (quarterly: the owner's VAT certificate gives a QUARTERLY tax period), built from
// the tax documents and reconciled to the ledger and to ZATCA.
//
//   Sales     A2 tax invoices, debit and credit notes ISSUED in the quarter (by issue day): the document's own E-10
//             VAT breakdown per (category, rate) — exactly the figures signed for ZATCA. Credit / debit notes go to
//             the «adjustment» column of their box.
//   Purchases A3 supplier invoices POSTED with an invoice date in the quarter (VAT per line); an invoice cancelled in
//             the quarter is an adjustment of the quarter it is cancelled in.
//   Ledger    the movement of the VAT_OUTPUT / VAT_INPUT accounts in the quarter, split into what the documents posted
//             (sales / purchasing engine entries) and anything else (manual or settlement journals) — differences shown.
//   ZATCA     the issued documents by e-invoicing state (cleared / reported, pending, rejected, not e-invoiced) and
//             the VAT each carries (auditor finding 8: return ↔ GL ↔ ZATCA submissions).
//
// The box layout follows the ZATCA VAT return form as generally published (boxes 1–16). RULES AND BOX DEFINITIONS
// CHANGE: check them against current ZATCA guidance (zatca.gov.sa) before filing — this report is a working paper
// for the accountant, not a filing. Boxes the system does not capture yet (sales to citizens for private health /
// education, prior-period corrections, the credit carried forward) are shown as 0 with a note, never guessed. Since
// unified inventory phase 2 the purchase VAT categories capture imports through customs (box 8) and the reverse
// charge (box 9, also added to the output VAT) — src/lib/accounting/ops/purchase-tax.ts.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { Decimal, ZERO, fix2 } from "./money";
import { dayText } from "./dates";
import { periodRange } from "./statements";

const EXPORT_CODES = new Set(["VATEX-SA-32", "VATEX-SA-33", "VATEX-SA-34-1", "VATEX-SA-34-2", "VATEX-SA-34-3", "VATEX-SA-34-4", "VATEX-SA-34-5"]);
const ACCEPTED = new Set(["CLEARED", "CLEARED_WITH_WARNINGS", "REPORTED", "REPORTED_WITH_WARNINGS"]);

type Box = { box: number | null; key: string; ar: string; en: string; amount: Decimal; adjustment: Decimal; vat: Decimal; note?: { ar: string; en: string } };
type BreakdownRow = { category?: string; rate?: string; taxable?: string; tax?: string; exemptionReasonCode?: string | null };

const box = (n: number | null, key: string, ar: string, en: string, note?: Box["note"]): Box => ({ box: n, key, ar, en, amount: ZERO, adjustment: ZERO, vat: ZERO, note });
const NOT_CAPTURED = { ar: "لا يلتقطه النظام بعد — أدخله يدويًا في الإقرار إن وُجد.", en: "Not captured by the system yet — enter it on the return by hand if any." };

/** Pure: which box a sales tax-breakdown row belongs to. */
export function salesBoxOf(row: BreakdownRow): "standard" | "zero" | "exports" | "exempt" | "outOfScope" {
  if (row.category === "S") return "standard";
  if (row.category === "Z") return EXPORT_CODES.has(String(row.exemptionReasonCode ?? "")) ? "exports" : "zero";
  if (row.category === "E") return "exempt";
  return "outOfScope";
}

export async function vatReturn(year: number, quarter: number) {
  const q = periodRange("quarter", year, quarter);
  const from = q.from, toEnd = new Date(q.to.getTime() + 86_399_999);
  const riyadh = { start: new Date(from.getTime() - 3 * 3600_000), end: new Date(toEnd.getTime() - 3 * 3600_000) };

  // ── sales ──
  const docs = await prisma.salesInvoice.findMany({
    where: { status: "ISSUED", issueDate: { gte: from, lte: q.to } },
    select: { id: true, kind: true, number: true, family: true, taxBreakdown: true, taxTotal: true, taxableTotal: true, zatcaStatus: true, zatcaXmlRef: true },
  });
  const posted = new Set((docs.length ? await prisma.journalEntry.findMany({
    where: { sourceType: { in: ["SALES_INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"] }, sourceId: { in: docs.map((d) => d.id) }, status: { in: ["POSTED", "REVERSED"] } },
    select: { sourceId: true },
  }) : []).map((j) => j.sourceId as string));
  const zdocs = docs.length ? await prisma.zatcaDocument.findMany({ where: { invoiceId: { in: docs.map((d) => d.id) } }, select: { invoiceId: true, status: true } }).catch(() => []) : [];
  const zOf = new Map(zdocs.map((z) => [z.invoiceId, z.status]));
  const S = { standard: box(1, "standard", "المبيعات الخاضعة للنسبة الأساسية", "Standard-rated sales"),
    citizens: box(2, "citizens", "المبيعات للمواطنين (الخدمات الصحية الخاصة / التعليم الأهلي)", "Sales to citizens (private healthcare / education)", NOT_CAPTURED),
    zero: box(3, "zero", "المبيعات المحلية الخاضعة للنسبة الصفرية", "Zero-rated domestic sales"),
    exports: box(4, "exports", "الصادرات", "Exports"),
    exempt: box(5, "exempt", "المبيعات المعفاة", "Exempt sales") };
  let outOfScope = ZERO;
  const output = { docs: docs.length, vat: ZERO, postedVat: ZERO, unposted: { count: 0, vat: ZERO } };
  const zatca = { accepted: { count: 0, vat: ZERO }, pending: { count: 0, vat: ZERO }, rejected: { count: 0, vat: ZERO }, notEInvoiced: { count: 0, vat: ZERO } };
  for (const d of docs) {
    const sign = d.kind === "CREDIT_NOTE" ? -1 : 1;
    const rows = (Array.isArray(d.taxBreakdown) ? d.taxBreakdown : []) as BreakdownRow[];
    for (const r of rows) {
      const b = salesBoxOf(r);
      const taxable = new Decimal(r.taxable ?? 0), tax = new Decimal(r.tax ?? 0);
      if (b === "outOfScope") { outOfScope = outOfScope.plus(taxable.times(sign)); continue; }
      const target = S[b];
      if (d.kind === "INVOICE") target.amount = target.amount.plus(taxable);
      else target.adjustment = target.adjustment.plus(taxable.times(sign));
      target.vat = target.vat.plus(tax.times(sign));
    }
    const vat = new Decimal(d.taxTotal).times(sign);
    output.vat = output.vat.plus(vat);
    if (posted.has(d.id)) output.postedVat = output.postedVat.plus(vat);
    else { output.unposted.count++; output.unposted.vat = output.unposted.vat.plus(vat); }
    const zs = zOf.get(d.id) ?? d.zatcaStatus ?? null;
    const bucket = !zs ? zatca.notEInvoiced : ACCEPTED.has(zs) ? zatca.accepted : zs === "REJECTED" ? zatca.rejected : zatca.pending;
    bucket.count++; bucket.vat = bucket.vat.plus(vat);
  }

  // ── purchases ── (phase 2: each line's purchase VAT category — its snapshot once posted — decides its box:
  //    P-S15 → 7, P-IMP15 → 8 (on the customs value), P-RC15 → 9 (its self-assessed VAT also on the output side),
  //    P-Z0 → 10, P-E0 → 11; P-S15-NR is shown as not claimable; P-O is not on the return. A line from before the
  //    categories (none: the migration back-filled them) falls back to its rate. CHECK THE BOXES against zatca.gov.sa.)
  const bills = await prisma.supplierInvoice.findMany({
    // A bill counts once it was posted (approved); a CANCELLED one only if it had been (a purchase invoice cancelled
    // before approval — 20261113090000_purchase_invoice_phase2 — never claimed input VAT).
    // CA3: import VAT (box 8) belongs to the period of its customs declaration — a bill whose declaration falls in the
    // quarter is read too. (Verify the timing rule on zatca.gov.sa: the declaration date is the generally published one.)
    where: { postedAt: { not: null }, OR: [{ status: { in: ["POSTED", "CANCELLED"] }, invoiceDate: { gte: from, lte: q.to } }, { status: { in: ["POSTED", "CANCELLED"] }, customsDeclarationDate: { gte: from, lte: q.to } }, { status: "CANCELLED", cancelledAt: { gte: riyadh.start, lte: riyadh.end } }] },
    select: { id: true, status: true, invoiceDate: true, customsDeclarationDate: true, cancelledAt: true, journalEntryId: true, supplier: { select: { vatNumber: true } },
      lines: { select: { net: true, vat: true, vatRate: true, customsValue: true, selfAssessedVat: true, taxSnapshot: true, taxCategory: { select: { inputVatTreatment: true, vatReturnBox: true } } } } },
  });
  const P = { standard: box(7, "purchasesStandard", "المشتريات المحلية الخاضعة للنسبة الأساسية", "Standard-rated domestic purchases"),
    imports: box(8, "imports", "الواردات الخاضعة للضريبة المدفوعة في الجمارك", "Imports subject to VAT paid at customs"),
    reverse: box(9, "reverseCharge", "الواردات الخاضعة لآلية الاحتساب العكسي", "Imports subject to the reverse charge"),
    zero: box(10, "purchasesZero", "المشتريات الخاضعة للنسبة الصفرية", "Zero-rated purchases"),
    exempt: box(11, "purchasesExempt", "المشتريات المعفاة", "Exempt purchases") };
  // Not a box: purchases whose VAT is not recoverable (P-S15-NR) — shown for the accountant, never claimed.
  const notClaimable = { count: 0, amount: ZERO, vat: ZERO };
  const reverseOutput = { amount: ZERO, adjustment: ZERO, vat: ZERO, postedVat: ZERO };
  const input = { docs: 0, vat: ZERO, postedVat: ZERO, unposted: { count: 0, vat: ZERO }, noSupplierVat: { count: 0, vat: ZERO } };
  const inQ = (d: Date | null) => !!d && d >= riyadh.start && d <= riyadh.end;
  // The VAT the boxes carry in this quarter by the customs-declaration rule, less what the ledger (by invoice date)
  // carries: a timing difference the accountant sees, never a reconciliation failure.
  const importTiming = { count: 0, vat: ZERO };
  for (const b of bills) {
    const dated = b.invoiceDate >= from && b.invoiceDate <= q.to;
    const customsDated = !!b.customsDeclarationDate && b.customsDeclarationDate >= from && b.customsDeclarationDate <= q.to;
    const cancelledHere = b.status === "CANCELLED" && inQ(b.cancelledAt);
    // N5: a bill that carries only import VAT is posted at its customs declaration date, so its ledger side follows
    // that date too (no timing difference); a mixed bill's ledger side follows the invoice date.
    const importOnly = !!b.customsDeclarationDate && b.lines.length > 0 && b.lines.every((l) => ((l.taxSnapshot as { inputVatTreatment?: string } | null)?.inputVatTreatment ?? l.taxCategory?.inputVatTreatment) === "IMPORT");
    const glDated = importOnly ? customsDated : dated;
    let claimed = ZERO, rc = ZERO;
    for (const l of b.lines) {
      const snap = (l.taxSnapshot ?? null) as { inputVatTreatment?: string | null; vatReturnBox?: string | null } | null;
      const treatment = snap?.inputVatTreatment ?? l.taxCategory?.inputVatTreatment ?? (new Decimal(l.vatRate).gt(0) ? "RECOVERABLE" : "NONE");
      const boxNo = snap ? snap.vatReturnBox ?? null : l.taxCategory ? l.taxCategory.vatReturnBox : new Decimal(l.vatRate).gt(0) ? "7" : "10";
      // The ledger side (claimed — reconciled to VAT_INPUT) follows the invoice date; an import line's box follows
      // the customs declaration date (CA3).
      const glSigns: number[] = [...(glDated ? [1] : []), ...(cancelledHere ? [-1] : [])];
      const isImport = treatment === "IMPORT" && !!b.customsDeclarationDate;
      const signs: number[] = isImport ? [...(customsDated ? [1] : []), ...(cancelledHere ? [-1] : [])] : glSigns;
      if (isImport) {
        const v = new Decimal(l.vat);
        const glNet = glSigns.reduce((t, x) => t + x, 0), boxNet = signs.reduce((t, x) => t + x, 0);
        claimed = claimed.plus(v.times(glNet));
        if (glNet !== boxNet) { importTiming.count++; importTiming.vat = importTiming.vat.plus(v.times(boxNet - glNet)); }
      }
      for (const sign of signs) {
        if (treatment === "NON_RECOVERABLE") { notClaimable.amount = notClaimable.amount.plus(new Decimal(l.net).times(sign)); notClaimable.vat = notClaimable.vat.plus(new Decimal(l.vat).times(sign)); continue; }
        const target = boxNo === "7" ? P.standard : boxNo === "8" ? P.imports : boxNo === "9" ? P.reverse : boxNo === "10" ? P.zero : boxNo === "11" ? P.exempt : null;
        if (!target) continue; // out of scope
        const amount = treatment === "IMPORT" ? new Decimal(l.customsValue ?? 0) : new Decimal(l.net);
        const lineVatAmt = treatment === "REVERSE_CHARGE" ? new Decimal(l.selfAssessedVat ?? 0) : new Decimal(l.vat);
        if (sign > 0) target.amount = target.amount.plus(amount); else target.adjustment = target.adjustment.minus(amount);
        target.vat = target.vat.plus(lineVatAmt.times(sign));
        if (!isImport) claimed = claimed.plus(lineVatAmt.times(sign));
        if (treatment === "REVERSE_CHARGE") {
          rc = rc.plus(lineVatAmt.times(sign));
          if (sign > 0) reverseOutput.amount = reverseOutput.amount.plus(amount); else reverseOutput.adjustment = reverseOutput.adjustment.minus(amount);
          reverseOutput.vat = reverseOutput.vat.plus(lineVatAmt.times(sign));
        }
      }
      if (treatment === "NON_RECOVERABLE" && dated) notClaimable.count++;
    }
    if (claimed.isZero() && !glDated) continue;
    input.docs++;
    input.vat = input.vat.plus(claimed);
    // Council 07: input VAT is recoverable only on a valid tax invoice in the company's name — a supplier with no VAT
    // number on file is flagged for the accountant (the claim is at risk), never silently dropped.
    if (!b.supplier.vatNumber && claimed.gt(0)) { input.noSupplierVat.count++; input.noSupplierVat.vat = input.noSupplierVat.vat.plus(claimed); }
    if (b.journalEntryId) { input.postedVat = input.postedVat.plus(claimed); reverseOutput.postedVat = reverseOutput.postedVat.plus(rc); }
    else { input.unposted.count++; input.unposted.vat = input.unposted.vat.plus(claimed); }
  }

  // ── ledger ──
  const gl = await prisma.$queryRaw<{ role: string; engine: boolean; v: Prisma.Decimal }[]>`
    SELECT r."role", (j."sourceModule" IN ('sales', 'purchasing')) AS engine, coalesce(sum(l."debit" - l."credit"), 0) AS v
      FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId" JOIN "AccountRole" r ON r."accountId" = l."accountId" AND r."tenantId" = 'hiqbah'
     WHERE r."role" IN ('VAT_OUTPUT', 'VAT_INPUT') AND j."status" IN ('POSTED', 'REVERSED') AND j."type"::text <> 'CLOSING'
       AND j."entryDate" >= ${from} AND j."entryDate" <= ${toEnd}
     GROUP BY 1, 2`;
  const glv = (role: string, engine: boolean) => new Decimal(String(gl.find((g) => g.role === role && g.engine === engine)?.v ?? 0));
  const glOutputDocs = glv("VAT_OUTPUT", true).negated(), glOutputOther = glv("VAT_OUTPUT", false).negated();
  const glInputDocs = glv("VAT_INPUT", true), glInputOther = glv("VAT_INPUT", false);

  const salesBoxes = [S.standard, S.citizens, S.zero, S.exports, S.exempt];
  const total6 = box(6, "salesTotal", "إجمالي المبيعات", "Total sales");
  for (const b of salesBoxes) { total6.amount = total6.amount.plus(b.amount); total6.adjustment = total6.adjustment.plus(b.adjustment); total6.vat = total6.vat.plus(b.vat); }
  // The reverse charge: the VAT the company self-assessed on services from non-residents (box 9) is also OUTPUT VAT —
  // added to the sales side's VAT (its amount is not a sale, so the total sales amount is unchanged).
  // AN2: a WORKING-PAPER line, not a box of the return — it shows the box-9 VAT that the return adds to the output side.
  const rcOut = box(null, "reverseChargeOutput", "سطر ورقة عمل: ضريبة الاحتساب العكسي (مخرجات) — ليست خانة مستقلة", "Working-paper line: reverse-charge VAT (output) — not a separate box", { ar: "الضريبة المحتسبة ذاتيًا على خدمات وشحن من موردين غير مقيمين (الخانة 9) تُضاف إلى ضريبة المخرجات. تحقق من معالجة الاحتساب العكسي وغير القابلة للاسترداد وخارج النطاق في zatca.gov.sa قبل التقديم.", en: "VAT self-assessed on services and freight from non-resident suppliers (box 9) is added to the output VAT. Verify the reverse-charge, not-recoverable and out-of-scope treatments on zatca.gov.sa before filing." });
  rcOut.amount = reverseOutput.amount; rcOut.adjustment = reverseOutput.adjustment; rcOut.vat = reverseOutput.vat;
  total6.vat = total6.vat.plus(rcOut.vat);
  const purchaseBoxes = [P.standard, P.imports, P.reverse, P.zero, P.exempt];
  const total12 = box(12, "purchasesTotal", "إجمالي المشتريات", "Total purchases");
  for (const b of purchaseBoxes) { total12.amount = total12.amount.plus(b.amount); total12.adjustment = total12.adjustment.plus(b.adjustment); total12.vat = total12.vat.plus(b.vat); }
  const due13 = total6.vat.minus(total12.vat);
  const out = (b: Box) => ({ box: b.box, key: b.key, ar: b.ar, en: b.en, amount: fix2(b.amount), adjustment: fix2(b.adjustment), vat: fix2(b.vat), note: b.note ?? null });
  const bucket = (x: { count: number; vat: Decimal }) => ({ count: x.count, vat: fix2(x.vat) });
  return {
    year, quarter, from: dayText(from), to: dayText(q.to),
    dueDate: dayText(new Date(Date.UTC(year, quarter * 3 + 1, 0))),
    sales: [...salesBoxes, ...(rcOut.vat.isZero() && rcOut.amount.isZero() ? [] : [rcOut]), total6].map(out),
    purchases: [...purchaseBoxes, total12].map(out),
    summary: {
      totalVatDue: fix2(due13), // box 13
      corrections: "0.00", // box 14 — not captured
      creditCarriedForward: "0.00", // box 15 — not captured
      netVatDue: fix2(due13), // box 16
      outOfScopeSales: fix2(outOfScope),
    },
    reconciliation: {
      output: { documents: fix2(output.vat.plus(reverseOutput.vat)), postedDocuments: fix2(output.postedVat.plus(reverseOutput.postedVat)), unposted: bucket(output.unposted), glFromDocuments: fix2(glOutputDocs), glOther: fix2(glOutputOther), difference: fix2(output.postedVat.plus(reverseOutput.postedVat).minus(glOutputDocs)), matched: output.postedVat.plus(reverseOutput.postedVat).equals(glOutputDocs), reverseCharge: fix2(reverseOutput.vat) },
      input: { notClaimable: { count: notClaimable.count, amount: fix2(notClaimable.amount), vat: fix2(notClaimable.vat) }, importTiming: { count: importTiming.count, vat: fix2(importTiming.vat) }, documents: fix2(input.vat), postedDocuments: fix2(input.postedVat), unposted: bucket(input.unposted), noSupplierVatNumber: bucket(input.noSupplierVat), glFromDocuments: fix2(glInputDocs), glOther: fix2(glInputOther), difference: fix2(input.postedVat.minus(glInputDocs)), matched: input.postedVat.equals(glInputDocs) },
      zatca: { accepted: bucket(zatca.accepted), pending: bucket(zatca.pending), rejected: bucket(zatca.rejected), notEInvoiced: bucket(zatca.notEInvoiced), returnVsAccepted: fix2(output.vat.minus(zatca.accepted.vat)) },
    },
    counts: { salesDocuments: output.docs, purchaseInvoices: input.docs },
    disclaimer: {
      ar: "ورقة عمل للمحاسب لا إقرار: تحقّق من تعريفات الخانات وقواعدها في الإرشادات الحالية لهيئة الزكاة والضريبة والجمارك (zatca.gov.sa) قبل التقديم.",
      en: "A working paper for the accountant, not a filing: check the box definitions and rules against current ZATCA guidance (zatca.gov.sa) before filing.",
    },
  };
}

export type VatReturn = Awaited<ReturnType<typeof vatReturn>>;

/** The quarter (1–4) of a business day. */
export const quarterOf = (d: Date) => Math.floor(d.getUTCMonth() / 3) + 1;
