// Cash-flow history must not change when a later correction is approved. A supplier payment's
// investing share is decided when the payment posts (the bill's fixed-asset lines); voiding the
// payment later — which switches its bank matches off — must leave the earlier month as reported,
// and the void must reverse exactly the original classification in the month it is dated.
// A void is dated on the day it is approved (today), so "later period" here is the current month;
// the payments are dated in January. Every expected figure is worked out by hand:
//   bill: fixed asset 1210 net 40,000 + VAT 6,000 = 46,000 (fully paid → investing −40,000, operating −6,000)
// Run: npm run test:accounting:db
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, makeUser } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear } from "../../../src/lib/accounting/fiscal-period-service";
import { createManualJournalEntry, submitJournalEntry, approveJournalEntry, postJournalEntry } from "../../../src/lib/accounting/journal-service";
import { draftPolicy, approvePolicy } from "../../../src/lib/accounting/policy-service";
import { processPendingEvents } from "../../../src/lib/accounting/event-processor";
import { createBill, submitBill, approveBill, postBill } from "../../../src/lib/accounting/payables-service";
import { setCashAccountGl, setCategoryGl } from "../../../src/lib/accounting/stage2-service";
import { requestBankCorrection, approveBankCorrection } from "../../../src/lib/accounting/bank-correction-service";
import { cashFlowStatement } from "../../../src/lib/accounting/cashflow";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const TODAY = todayAccountingDate();
const YEAR = TODAY.getUTCFullYear();
const MONTH = TODAY.getUTCMonth() + 1;
const D = (md: string) => accountingDate(`${YEAR}-${md}`);
const dec = (s: string) => new Prisma.Decimal(s);
const monthRange = (m: number) => ({ from: new Date(Date.UTC(YEAR, m - 1, 1)), to: new Date(Date.UTC(YEAR, m, 0)) });
const sections = (cf: Awaited<ReturnType<typeof cashFlowStatement>>) =>
  ({ operating: cf.operating.total, investing: cf.investing.total, financing: cf.financing.total, netChange: cf.netChange, reconciled: cf.reconciled });
const SKIP = MONTH === 1 ? "needs the current month to be later than January" : false;

async function world() {
  const prep = await makeUser("Preparer");
  const appr = await makeUser("Approver");
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: D("01-01"), setupComplete: true }, prep);
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const e = await createManualJournalEntry({ type: "OPENING", entryDate: D("01-01"), description: "Opening", lines: [{ accountId: acc["1120"], debit: "200000", credit: "0" }, { accountId: acc["3900"], debit: "0", credit: "200000" }] }, prep);
  await submitJournalEntry(e.id, prep); await approveJournalEntry(e.id, appr); await postJournalEntry(e.id, appr);
  for (const key of ["payables.recognition", "bank.posting"]) { const p = await draftPolicy(key, {}, prep); await approvePolicy(p.id, appr); }
  await updateSettings({ bankPostingFrom: D("01-01") }, prep);
  const vat = await prisma.taxCategory.create({ data: { code: "VAT15", nameEn: "Standard 15%", nameAr: "قياسية 15%", rate: dec("15.00"), isDefault: true } });
  const supplier = await prisma.supplier.create({ data: { name: "مورد المعدات", vatNumber: "310245678900003", paymentTermsDays: 30 } });
  const bank = await prisma.cashAccount.create({ data: { code: "BANK1", nameEn: "Main bank", type: "BANK", openingBalance: dec("0"), openingBalanceDate: D("01-01") } });
  await setCashAccountGl(bank.id, acc["1120"], prep);
  const cat = await prisma.finCategory.create({ data: { code: "SUPPLIERS", nameEn: "Suppliers", kind: "PAYMENT" } });
  await setCategoryGl(cat.id, acc["2110"], prep);
  const b = await createBill({ supplierId: supplier.id, supplierInvoiceNo: "EQ-1", billDate: `${YEAR}-01-05`, lines: [{ kind: "EXPENSE", accountId: acc["1210"], description: "محمصة 15 كغ", quantity: "1", unitPrice: "40000", taxCategoryId: vat.id }] }, prep);
  await submitBill(b.id, prep); await approveBill(b.id, appr); await postBill(b.id, appr);
  const ob = (await prisma.supplierBill.findUniqueOrThrow({ where: { id: b.id } })).obligationId!;
  const pay = async (md: string, amount: string) => {
    const t = await prisma.bankTransaction.create({ data: {
      cashAccountId: bank.id, branchKey: "COMPANY", txnDate: D(md), amount: dec(`-${amount}`), status: "CONFIRMED", classification: "SUPPLIER_PAYMENT", reviewStatus: "NEEDS_REVIEW",
      splits: { create: [{ finCategoryId: cat.id, amount: dec(`-${amount}`) }] }, matches: { create: [{ targetType: "OBLIGATION", targetId: ob, amount: dec(amount) }] } } });
    await prisma.bankTransaction.update({ where: { id: t.id }, data: { reviewStatus: "REVIEWED" } });
    await processPendingEvents();
    return t.id;
  };
  const voidLine = async (id: string) => {
    const c = await requestBankCorrection(id, { kind: "VOID", reason: "paid twice by mistake" }, prep);
    await approveBankCorrection(c.id, appr);
    await processPendingEvents();
  };
  const replaceLine = async (id: string, md: string, amount: string) => {
    const c = await requestBankCorrection(id, { kind: "REPLACE", reason: "the bank debited a different amount", replacement: {
      txnDate: `${YEAR}-${md}`, amount: `-${amount}`, classification: "SUPPLIER_PAYMENT", splits: [{ finCategoryId: cat.id, amount: `-${amount}` }], matches: [{ targetType: "OBLIGATION", targetId: ob, amount }] } }, prep);
    await approveBankCorrection(c.id, appr);
    await processPendingEvents();
  };
  return { pay, voidLine, replaceLine };
}

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

describe("cash flow — history is stable when a later correction is approved", { skip: SKIP }, () => {
  test("asset bill paid in January, payment voided in a later month", async () => {
    const w = await world();
    const t = await w.pay("01-20", "46000");
    const jan = { operating: "-6000.00", investing: "-40000.00", financing: "0.00", netChange: "-46000.00", reconciled: true };
    assert.deepEqual(sections(await cashFlowStatement(monthRange(1))), jan, "before the correction");
    await w.voidLine(t);
    assert.deepEqual(sections(await cashFlowStatement(monthRange(1))), jan, "January is unchanged by the later void");
    assert.deepEqual(sections(await cashFlowStatement(monthRange(MONTH))), { operating: "6000.00", investing: "40000.00", financing: "0.00", netChange: "46000.00", reconciled: true },
      "the void reverses the original classification in the month it is dated");
    assert.deepEqual(sections(await cashFlowStatement({ from: D("01-01"), to: D("12-31") })), { operating: "0.00", investing: "0.00", financing: "0.00", netChange: "0.00", reconciled: true });
  });

  test("two partial payments; the second is voided later", async () => {
    const w = await world();
    await w.pay("01-20", "23000");
    const t2 = await w.pay("01-25", "23000");
    const jan = { operating: "-6000.00", investing: "-40000.00", financing: "0.00", netChange: "-46000.00", reconciled: true };
    assert.deepEqual(sections(await cashFlowStatement(monthRange(1))), jan, "each half: −20,000 investing, −3,000 operating");
    await w.voidLine(t2);
    assert.deepEqual(sections(await cashFlowStatement(monthRange(1))), jan, "January unchanged");
    assert.deepEqual(sections(await cashFlowStatement(monthRange(MONTH))), { operating: "3000.00", investing: "20000.00", financing: "0.00", netChange: "23000.00", reconciled: true });
  });

  test("void and replace: the replacement is classified on its own; the void mirrors the original", async () => {
    const w = await world();
    const t = await w.pay("01-20", "46000");
    await w.replaceLine(t, "01-21", "23000");   // the bank actually debited half; the rest stays owed
    // January: original −40,000/−6,000 (its void is dated today) + replacement −20,000/−3,000.
    assert.deepEqual(sections(await cashFlowStatement(monthRange(1))), { operating: "-9000.00", investing: "-60000.00", financing: "0.00", netChange: "-69000.00", reconciled: true });
    assert.deepEqual(sections(await cashFlowStatement(monthRange(MONTH))), { operating: "6000.00", investing: "40000.00", financing: "0.00", netChange: "46000.00", reconciled: true });
    assert.deepEqual(sections(await cashFlowStatement({ from: D("01-01"), to: D("12-31") })), { operating: "-3000.00", investing: "-20000.00", financing: "0.00", netChange: "-23000.00", reconciled: true });
  });
});
