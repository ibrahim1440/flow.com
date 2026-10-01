// VAT return for a period (stage 6), from posted sales documents and supplier bills, reconciled to
// the output and input VAT accounts. A report for review: nothing is filed from the system.
//
// Box structure follows the KSA VAT return as commonly published (sales: standard-rated, zero-rated,
// exports, exempt; purchases: standard-rated, imports at customs, reverse charge, zero-rated,
// exempt). The numbering and wording must be checked against the official form before relying on
// it. Not modelled: exports, imports, reverse charge, special cases, corrections of earlier periods
// and credit carried forward (shown as 0 and marked).
//
// Timing: a document counts in the period of its issue (sales) or bill date (purchases); a reversal
// counts negatively in the period of the reversal day, as its journal does; credit notes count
// negatively in their own period.
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { accountingDateOf, dateStr } from "../dates";
import { ZERO, dec } from "../money";

type Bucket = { net: Prisma.Decimal; vat: Prisma.Decimal; docs: number };
const zero = (): Bucket => ({ net: ZERO, vat: ZERO, docs: 0 });
const inRange = (d: Date, from: Date, to: Date) => d >= from && d <= to;

export async function vatReturn(from: Date, to: Date) {
  const cats = new Map((await prisma.taxCategory.findMany()).map((t) => [t.id, t.categoryType as string]));
  const sales: Record<string, Bucket> = { STANDARD: zero(), ZERO_RATED: zero(), EXEMPT: zero(), OUT_OF_SCOPE: zero(), UNCLASSIFIED: zero() };
  const purch: Record<string, Bucket> = { STANDARD: zero(), ZERO_RATED: zero(), EXEMPT: zero(), OUT_OF_SCOPE: zero(), UNCLASSIFIED: zero() };
  const add = (b: Record<string, Bucket>, cat: string, sign: number, net: Prisma.Decimal, vat: Prisma.Decimal) => { const x = b[cat] ?? b.UNCLASSIFIED; x.net = x.net.add(net.mul(sign)); x.vat = x.vat.add(vat.mul(sign)); x.docs++; };

  const sd = await prisma.salesInvoice.findMany({ where: { status: { in: ["POSTED", "REVERSED"] }, OR: [{ issueDate: { gte: from, lte: to } }, { reversedAt: { not: null } }] }, include: { lines: true } });
  for (const d of sd) {
    const sign = d.kind === "CREDIT_NOTE" ? -1 : 1;
    const effects: number[] = [];
    if (inRange(d.issueDate, from, to)) effects.push(sign);
    if (d.status === "REVERSED" && d.reversedAt && inRange(accountingDateOf(d.reversedAt), from, to)) effects.push(-sign);
    for (const s of effects) for (const l of d.lines) add(sales, l.taxCategoryId ? cats.get(l.taxCategoryId) ?? "UNCLASSIFIED" : "UNCLASSIFIED", s, dec(l.net), dec(l.vat));
  }
  const bills = await prisma.supplierBill.findMany({ where: { status: { in: ["POSTED", "REVERSED"] }, OR: [{ billDate: { gte: from, lte: to } }, { reversedAt: { not: null } }] }, include: { lines: true } });
  for (const b of bills) {
    const sign = b.kind === "CREDIT_NOTE" ? -1 : 1;
    const effects: number[] = [];
    if (inRange(b.billDate, from, to)) effects.push(sign);
    if (b.status === "REVERSED" && b.reversedAt && inRange(accountingDateOf(b.reversedAt), from, to)) effects.push(-sign);
    for (const s of effects) for (const l of b.lines) add(purch, l.taxCategoryId ? cats.get(l.taxCategoryId) ?? "UNCLASSIFIED" : "UNCLASSIFIED", s, dec(l.net), dec(l.vat));
  }
  const f = (b: Bucket) => ({ amount: b.net.toFixed(2), vat: b.vat.toFixed(2) });
  const nil = { amount: "0.00", vat: "0.00", notModelled: true };
  const salesTotal = [sales.STANDARD, sales.ZERO_RATED, sales.EXEMPT].reduce((a, b) => ({ net: a.net.add(b.net), vat: a.vat.add(b.vat), docs: 0 }), zero());
  const purchTotal = [purch.STANDARD, purch.ZERO_RATED, purch.EXEMPT].reduce((a, b) => ({ net: a.net.add(b.net), vat: a.vat.add(b.vat), docs: 0 }), zero());
  const netVat = salesTotal.vat.sub(purchTotal.vat);

  // Reconciliation to the ledger: VAT accounts by role, movement in the period.
  const maps = await prisma.accountMapping.findMany({ where: { role: { in: ["OUTPUT_VAT", "INPUT_VAT"] } }, include: { account: true } });
  const recon = [];
  for (const m of maps) {
    const lines = await prisma.journalEntryLine.findMany({ where: { accountId: m.accountId, journalEntry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { gte: from, lte: to } } }, include: { journalEntry: { select: { sourceModule: true, entryNo: true, type: true } } } });
    const bySource = new Map<string, { net: Prisma.Decimal; entries: Set<number> }>();
    let gl = ZERO;
    for (const l of lines) {
      const v = m.role === "OUTPUT_VAT" ? dec(l.credit).sub(dec(l.debit)) : dec(l.debit).sub(dec(l.credit));
      gl = gl.add(v);
      const src = l.journalEntry.sourceModule ?? "manual";
      const x = bySource.get(src) ?? { net: ZERO, entries: new Set<number>() }; x.net = x.net.add(v); x.entries.add(l.journalEntry.entryNo); bySource.set(src, x);
    }
    const docs = m.role === "OUTPUT_VAT" ? salesTotal.vat.add(sales.OUT_OF_SCOPE.vat).add(sales.UNCLASSIFIED.vat) : purchTotal.vat.add(purch.OUT_OF_SCOPE.vat).add(purch.UNCLASSIFIED.vat);
    const home = m.role === "OUTPUT_VAT" ? "receivables" : "payables";
    const outside = [...bySource.entries()].filter(([src]) => src !== home).reduce((a, [, x]) => a.add(x.net), ZERO);
    recon.push({
      role: m.role, code: m.account.code, name: m.account.nameAr ?? m.account.nameEn, fromDocuments: docs.toFixed(2), ledger: gl.toFixed(2), difference: gl.sub(docs).toFixed(2),
      // What journals from outside the documents do not explain (a gap between the documents and their own journals).
      unexplained: gl.sub(docs).sub(outside).toFixed(2),
      bySource: [...bySource.entries()].map(([source, x]) => ({ source, amount: x.net.toFixed(2), entries: [...x.entries].slice(0, 10), outsideDocuments: source !== home })),
    });
  }
  return {
    from: dateStr(from), to: dateStr(to),
    boxes: {
      "1": { ...f(sales.STANDARD), en: "Standard-rated sales", ar: "المبيعات الخاضعة للنسبة الأساسية" },
      "3": { ...f(sales.ZERO_RATED), en: "Zero-rated domestic sales", ar: "المبيعات المحلية الخاضعة للنسبة الصفرية" },
      "4": { ...nil, en: "Exports", ar: "الصادرات" },
      "5": { ...f(sales.EXEMPT), en: "Exempt sales", ar: "المبيعات المعفاة" },
      "6": { amount: salesTotal.net.toFixed(2), vat: salesTotal.vat.toFixed(2), en: "Total sales", ar: "إجمالي المبيعات", total: true },
      "7": { ...f(purch.STANDARD), en: "Standard-rated domestic purchases", ar: "المشتريات المحلية الخاضعة للنسبة الأساسية" },
      "8": { ...nil, en: "Imports subject to VAT paid at customs", ar: "الاستيراد (ضريبة مدفوعة في الجمارك)" },
      "9": { ...nil, en: "Imports subject to VAT under reverse charge", ar: "الاستيراد (الاحتساب العكسي)" },
      "10": { ...f(purch.ZERO_RATED), en: "Zero-rated purchases", ar: "المشتريات الخاضعة للنسبة الصفرية" },
      "11": { ...f(purch.EXEMPT), en: "Exempt purchases", ar: "المشتريات المعفاة" },
      "12": { amount: purchTotal.net.toFixed(2), vat: purchTotal.vat.toFixed(2), en: "Total purchases", ar: "إجمالي المشتريات", total: true },
      "13": { amount: "", vat: netVat.toFixed(2), en: "Net VAT for the period (sales VAT − purchase VAT)", ar: "صافي الضريبة للفترة (ضريبة المبيعات − ضريبة المشتريات)", total: true },
    },
    excluded: { salesOutOfScope: f(sales.OUT_OF_SCOPE), salesUnclassified: f(sales.UNCLASSIFIED), purchasesOutOfScope: f(purch.OUT_OF_SCOPE), purchasesUnclassified: f(purch.UNCLASSIFIED) },
    notModelled: ["exports", "imports at customs", "reverse charge", "corrections of earlier periods", "credit carried forward"],
    reconciliation: recon,
  };
}
