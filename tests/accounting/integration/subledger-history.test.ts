// Period-end receivables and payables must be reproducible: a report for an earlier date gives the
// same answer before and after later reversals, voids and credit-note reversals, and agrees with
// the general ledger at every cutoff. Documents are placed in March; the later corrections happen
// today (a void or reversal is dated the day it is made). Expected figures are worked by hand:
//
//   Receivables (customer, 30 days):  INV A 03-01 1,150 (due 03-31) · INV B 03-05 2,300 (due 04-04)
//     receipt R1 03-10 1,150 → A · credit note on B 03-15 575 · receipt R2 03-20 1,000 → B
//     open:  03-04 A 1,150 = 1,150 · 03-09 A 1,150 + B 2,300 = 3,450 · 03-12 B 2,300
//            03-17 B 1,725 · 03-31 B 725
//     later (today): R2 voided, the credit note reversed, then B reversed → today 0.00
//
//   Payables (supplier, 30 days): bill X 03-02 1,150 · bill Y 03-03 2,300 · payment 03-20 575 → X
//     open:  03-02 1,150 · 03-10 3,450 · 03-25 2,875 (X 575 + Y 2,300)
//     later (today): payment voided, Y reversed → today X 1,150
//
// Run: npm run test:accounting:db
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, makeUser } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear } from "../../../src/lib/accounting/fiscal-period-service";
import { draftPolicy, approvePolicy } from "../../../src/lib/accounting/policy-service";
import { processPendingEvents } from "../../../src/lib/accounting/event-processor";
import { setCashAccountGl, setCategoryGl, apAging, supplierStatement } from "../../../src/lib/accounting/stage2-service";
import { createSalesDoc, submitSalesDoc, approveSalesDoc, postSalesDoc, reverseSalesDoc, assignReceipt } from "../../../src/lib/accounting/receivables-service";
import { createBill, submitBill, approveBill, postBill, reverseBill } from "../../../src/lib/accounting/payables-service";
import { arAging, customerStatement } from "../../../src/lib/accounting/receivables-reports";
import { requestBankCorrection, approveBankCorrection } from "../../../src/lib/accounting/bank-correction-service";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const TODAY = todayAccountingDate();
const YEAR = TODAY.getUTCFullYear();
const D = (md: string) => accountingDate(`${YEAR}-${md}`);
const dec = (s: string) => new Prisma.Decimal(s);
const SKIP = TODAY.getUTCMonth() + 1 <= 3 ? "needs today to be after March" : false;

async function world() {
  const prep = await makeUser("Accountant");
  const appr = await makeUser("Controller");
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: D("01-01"), setupComplete: true }, prep);
  await updateSettings({ bankPostingFrom: D("02-01") }, prep);
  for (const key of ["receivables.recognition", "payables.recognition", "bank.posting"]) { const p = await draftPolicy(key, {}, prep); await approvePolicy(p.id, appr); }
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const vat = (await prisma.taxCategory.create({ data: { code: "VAT15", nameEn: "Standard 15%", nameAr: "قياسية 15%", rate: dec("15.00"), isDefault: true } })).id;
  const bank = await prisma.cashAccount.create({ data: { code: "BANK1", nameEn: "Main bank", type: "BANK", openingBalance: dec("0"), openingBalanceDate: D("01-01") } });
  await setCashAccountGl(bank.id, acc["1120"], prep);
  const salesCat = await prisma.finCategory.create({ data: { code: "SALES", nameEn: "Sales receipts", kind: "RECEIPT" } });
  const supCat = await prisma.finCategory.create({ data: { code: "SUPPLIERS", nameEn: "Suppliers", kind: "PAYMENT" } });
  await setCategoryGl(supCat.id, acc["2110"], prep);
  const bankLine = async (md: string, amount: string, cls: string, split: string, match?: { targetId: string; amount: string }) => {
    const t = await prisma.bankTransaction.create({ data: {
      cashAccountId: bank.id, branchKey: "COMPANY", txnDate: D(md), amount: dec(amount), status: "CONFIRMED", classification: cls as never, reviewStatus: "NEEDS_REVIEW",
      bankReference: `REF-${md}`, splits: { create: [{ finCategoryId: split, amount: dec(amount) }] },
      matches: match ? { create: [{ targetType: "OBLIGATION", targetId: match.targetId, amount: dec(match.amount) }] } : undefined } });
    await prisma.bankTransaction.update({ where: { id: t.id }, data: { reviewStatus: "REVIEWED" } });
    return t.id;
  };
  const voidLine = async (id: string) => {
    const c = await requestBankCorrection(id, { kind: "VOID", reason: "entered against the wrong account" }, prep);
    await approveBankCorrection(c.id, appr);
    await processPendingEvents();
  };
  /** Ledger balance of an account up to a date, debit − credit (computed here, not by the report). */
  const gl = async (code: string, asOf: Date) => {
    const r = await prisma.journalEntryLine.aggregate({ where: { accountId: acc[code], journalEntry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { lte: asOf } } }, _sum: { debit: true, credit: true } });
    return dec(String(r._sum.debit ?? 0)).sub(dec(String(r._sum.credit ?? 0))).toFixed(2);
  };
  return { prep, appr, acc, vat, bankLine, voidLine, gl, salesCat: salesCat.id, supCat: supCat.id };
}

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

describe("period-end subledgers are reproducible and agree with the ledger", { skip: SKIP }, () => {
  test("receivables: aging and statement for March unchanged by later voids and reversals", async () => {
    const w = await world();
    const customer = (await prisma.customer.create({ data: { name: "Al-Rawda Hotel", nameAr: "فندق الروضة", vatNumber: "300445566700003", paymentTermsDays: 30 } })).id;
    const doc = async (md: string, price: string, extra: Record<string, unknown> = {}) => {
      const d = await createSalesDoc({ customerId: customer, issueDate: `${YEAR}-${md}`, lines: [{ description: "بن محمص", quantity: "1", unitPrice: price, taxCategoryId: w.vat }], ...extra } as Parameters<typeof createSalesDoc>[0], w.prep);
      await submitSalesDoc(d.id, w.prep); await approveSalesDoc(d.id, w.appr); await postSalesDoc(d.id, w.appr);
      return d.id;
    };
    const A = await doc("03-01", "1000");
    const B = await doc("03-05", "2000");
    const r1 = await w.bankLine("03-10", "1150.00", "CUSTOMER_RECEIPT", w.salesCat);
    await assignReceipt(r1, { customerId: customer, allocations: [{ invoiceId: A, amount: "1150.00" }] }, w.prep);
    const CN = await doc("03-15", "500", { kind: "CREDIT_NOTE", creditType: "PRICE_ADJUSTMENT", originalInvoiceId: B, reason: "مرتجع جزئي" });
    const r2 = await w.bankLine("03-20", "1000.00", "CUSTOMER_RECEIPT", w.salesCat);
    await assignReceipt(r2, { customerId: customer, allocations: [{ invoiceId: B, amount: "1000.00" }] }, w.prep);
    await processPendingEvents();

    const cutoffs: [string, string][] = [["03-04", "1150.00"], ["03-09", "3450.00"], ["03-12", "2300.00"], ["03-17", "1725.00"], ["03-31", "725.00"]];
    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      for (const [md, expected] of cutoffs) {
        const a = await arAging(D(md));
        assert.equal(a.subledger, expected, `aging ${md}`);
        assert.equal(a.ledger, await w.gl("1130", D(md)), `aging ${md} vs the ledger`);
        assert.equal(a.reconciled, true, `aging ${md} reconciled`);
        out[md] = { rows: a.rows, totals: a.totals, credits: a.credits };
      }
      const st = await customerStatement(customer, D("03-01"), D("03-31"));
      assert.equal(st.opening, "0.00"); assert.equal(st.closing, "725.00"); assert.equal(st.reconciled, true, "statement vs party ledger");
      out.statement = st.lines.map((l) => [String(l.date).slice(0, 10), l.debit, l.credit, l.balance]);
      return out;
    };
    const before = await snapshot();
    assert.deepEqual((before.statement as string[][]).map((l) => [l[1], l[2]]), [["1150.00", "0.00"], ["2300.00", "0.00"], ["0.00", "1150.00"], ["0.00", "575.00"], ["0.00", "1000.00"]]);
    const todayBefore = await arAging(TODAY);
    assert.equal(todayBefore.subledger, "725.00");

    // Later: the second receipt is voided, the credit note reversed, and then invoice B reversed.
    await w.voidLine(r2);
    await reverseSalesDoc(CN, w.appr, "إشعار أُصدر بالخطأ");
    await reverseSalesDoc(B, w.appr, "الفاتورة أُلغيت بالكامل");
    await processPendingEvents();

    assert.deepEqual(await snapshot(), before, "every March cutoff and the March statement are unchanged");
    const now = await arAging(TODAY);
    assert.equal(now.subledger, "0.00"); assert.equal(now.ledger, await w.gl("1130", TODAY)); assert.equal(now.reconciled, true);
    const stNow = await customerStatement(customer, D("03-01"), TODAY);
    assert.equal(stNow.closing, "0.00"); assert.equal(stNow.reconciled, true);
  });

  test("payables: aging and statement for March unchanged by a later void and bill reversal", async () => {
    const w = await world();
    const supplier = (await prisma.supplier.create({ data: { name: "محمصة الوادي", vatNumber: "310245678900003", paymentTermsDays: 30 } })).id;
    const bill = async (md: string, inv: string, price: string) => {
      const b = await createBill({ supplierId: supplier, supplierInvoiceNo: inv, billDate: `${YEAR}-${md}`, lines: [{ kind: "EXPENSE", accountId: w.acc["6300"], description: "خدمات", quantity: "1", unitPrice: price, taxCategoryId: w.vat }] }, w.prep);
      await submitBill(b.id, w.prep); await approveBill(b.id, w.appr); await postBill(b.id, w.appr);
      return (await prisma.supplierBill.findUniqueOrThrow({ where: { id: b.id } }));
    };
    const X = await bill("03-02", "X-1", "1000");
    const Y = await bill("03-03", "Y-1", "2000");
    const p = await w.bankLine("03-20", "-575.00", "SUPPLIER_PAYMENT", w.supCat, { targetId: X.obligationId!, amount: "575.00" });
    await processPendingEvents();

    const cutoffs: [string, string][] = [["03-02", "1150.00"], ["03-10", "3450.00"], ["03-25", "2875.00"], ["03-31", "2875.00"]];
    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      for (const [md, expected] of cutoffs) {
        const a = await apAging(D(md));
        assert.equal(a.subledger, expected, `AP aging ${md}`);
        assert.equal(a.ledger, dec(await w.gl("2110", D(md))).neg().toFixed(2), `AP aging ${md} vs the ledger`);
        assert.equal(a.reconciled, true, `AP aging ${md} reconciled`);
        out[md] = { rows: a.rows, totals: a.totals };
      }
      const st = await supplierStatement(supplier, D("03-01"), D("03-31"));
      assert.equal(st.opening, "0.00"); assert.equal(st.closing, "2875.00"); assert.equal(st.ledgerBalance, "2875.00");
      out.statement = st.lines.map((l) => [String(l.date).slice(0, 10), l.debit, l.credit, l.balance]);
      return out;
    };
    const before = await snapshot();

    await w.voidLine(p);
    await reverseBill(Y.id, w.appr, "فاتورة مكررة من المورد");
    await processPendingEvents();

    assert.deepEqual(await snapshot(), before, "every March cutoff and the March statement are unchanged");
    const now = await apAging(TODAY);
    assert.equal(now.subledger, "1150.00", "X is owed in full again; Y is reversed");
    assert.equal(now.reconciled, true);
  });
});
