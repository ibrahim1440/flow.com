// Cash-flow statement: transactions that move balance-sheet accounts WITHOUT moving cash must not
// appear as operating, investing or financing flows. They are disclosed as non-cash transactions.
// Every expected figure below is worked out by hand from the entries, section by section; the
// tests do not rely on the sections adding up to the change in cash (which holds for any split).
// The classification used is the chart template's default — PROVISIONAL until the accountant
// approves it (DECISION_PACK §7). Run: npm run test:accounting:db
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
import { cashFlowStatement } from "../../../src/lib/accounting/cashflow";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const YEAR = Number(todayAccountingDate().toISOString().slice(0, 4));
const D = (md: string) => accountingDate(`${YEAR}-${md}`);
const dec = (s: string) => new Prisma.Decimal(s);
type Line = [code: string, debit: string, credit: string];

async function ledger() {
  const prep = await makeUser("Preparer");
  const appr = await makeUser("Approver");
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: D("01-01"), setupComplete: true }, prep);
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const post = async (md: string, description: string, lines: Line[], type: "MANUAL" | "OPENING" = "MANUAL") => {
    const e = await createManualJournalEntry({ type, entryDate: D(md), description, lines: lines.map(([code, debit, credit]) => ({ accountId: acc[code], debit, credit })) }, prep);
    await submitJournalEntry(e.id, prep);
    await approveJournalEntry(e.id, appr);
    await postJournalEntry(e.id, appr);
  };
  await post("01-01", "Opening balances", [["1120", "100000", "0"], ["3900", "0", "100000"]], "OPENING");
  return { prep, appr, acc, post };
}

const year = () => ({ from: D("01-01"), to: D("12-31") });
const sections = (cf: Awaited<ReturnType<typeof cashFlowStatement>>) =>
  ({ operating: cf.operating.total, investing: cf.investing.total, financing: cf.financing.total, netChange: cf.netChange });
const nonCash = (cf: Awaited<ReturnType<typeof cashFlowStatement>>) => cf.nonCash.map((n) => n.amount).sort();
const adj = (cf: Awaited<ReturnType<typeof cashFlowStatement>>, code: string) =>
  cf.operating.adjustments.filter((a) => a.code === code).reduce((s, a) => s.add(a.amount), dec("0")).toFixed(2);

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

describe("cash flow — non-cash transactions", () => {
  test("fixed asset bought on credit: no flow at purchase; partial and full payments are investing outflows", async () => {
    const l = await ledger();
    await l.post("02-01", "Roaster bought on credit", [["1210", "30000", "0"], ["2195", "0", "30000"]]);
    await l.post("03-01", "First instalment to the roaster supplier", [["2195", "10000", "0"], ["1120", "0", "10000"]]);
    await l.post("04-01", "Final instalment", [["2195", "20000", "0"], ["1120", "0", "20000"]]);

    const feb = await cashFlowStatement({ from: D("02-01"), to: D("02-28") });
    assert.deepEqual(sections(feb), { operating: "0.00", investing: "0.00", financing: "0.00", netChange: "0.00" }, "no cash moved in February");
    assert.deepEqual(nonCash(feb), ["30000.00"], "the credit purchase is disclosed as non-cash");
    assert.equal(feb.reconciled, true);

    const mar = await cashFlowStatement({ from: D("03-01"), to: D("03-31") });
    assert.deepEqual(sections(mar), { operating: "0.00", investing: "-10000.00", financing: "0.00", netChange: "-10000.00" }, "partial payment");
    assert.deepEqual(nonCash(mar), []);

    const all = await cashFlowStatement(year());
    assert.deepEqual(sections(all), { operating: "0.00", investing: "-30000.00", financing: "0.00", netChange: "-30000.00" });
    assert.deepEqual(nonCash(all), ["30000.00"]);
    assert.equal(all.reconciled, true);
  });

  test("asset financed directly by a loan: disclosed as non-cash; loan repayment is financing", async () => {
    const l = await ledger();
    await l.post("02-10", "Delivery van financed by the bank", [["1230", "80000", "0"], ["2220", "0", "80000"]]);
    await l.post("05-10", "Loan instalment", [["2220", "5000", "0"], ["1120", "0", "5000"]]);
    const cf = await cashFlowStatement(year());
    assert.deepEqual(sections(cf), { operating: "0.00", investing: "0.00", financing: "-5000.00", netChange: "-5000.00" });
    assert.deepEqual(nonCash(cf), ["80000.00"]);
    assert.equal(cf.reconciled, true);
  });

  test("depreciation and disposals: proceeds are investing; depreciation, loss and gain adjust profit", async () => {
    const l = await ledger();
    await l.post("01-15", "Grinder bought for cash", [["1210", "50000", "0"], ["1120", "0", "50000"]]);
    await l.post("06-30", "Depreciation H1", [["6600", "5000", "0"], ["1290", "0", "5000"]]);
    // cost 20,000, accumulated depreciation 5,000, sold for 12,000 → loss 3,000
    await l.post("09-01", "Old grinder sold at a loss", [["1120", "12000", "0"], ["1290", "5000", "0"], ["6960", "3000", "0"], ["1210", "0", "20000"]]);
    // cost 15,000, no depreciation, sold for 18,000 → gain 3,000
    await l.post("10-01", "Spare machine sold at a gain", [["1120", "18000", "0"], ["1210", "0", "15000"], ["4800", "0", "3000"]]);

    const cf = await cashFlowStatement(year());
    assert.equal(cf.netProfit, "-5000.00", "−5,000 depreciation − 3,000 loss + 3,000 gain");
    assert.deepEqual(sections(cf), { operating: "0.00", investing: "-20000.00", financing: "0.00", netChange: "-20000.00" },
      "investing = −50,000 purchase + 12,000 + 18,000 proceeds; no operating cash");
    assert.equal(adj(cf, "6600"), "5000.00", "depreciation added back");
    assert.equal(adj(cf, "6960"), "3000.00", "loss on disposal added back");
    assert.equal(adj(cf, "4800"), "-3000.00", "gain on disposal removed (it is part of the proceeds)");
    assert.deepEqual(nonCash(cf), []);
    assert.equal(cf.reconciled, true);
  });

  test("internal cash transfers are not cash flows", async () => {
    const l = await ledger();
    await l.post("03-05", "Float to the till", [["1110", "2000", "0"], ["1120", "0", "2000"]]);
    await l.post("03-20", "Till banked", [["1120", "1500", "0"], ["1110", "0", "1500"]]);
    await l.post("04-01", "Café sales", [["1110", "700", "0"], ["4200", "0", "700"]]);
    const cf = await cashFlowStatement(year());
    assert.deepEqual(sections(cf), { operating: "700.00", investing: "0.00", financing: "0.00", netChange: "700.00" });
    assert.equal(cf.cashOpening, "100000.00");
    assert.equal(cf.cashClosing, "100700.00");
    assert.deepEqual(nonCash(cf), []);
    assert.equal(cf.reconciled, true);
  });

  test("working capital and a mixed receipt are still reported correctly", async () => {
    const l = await ledger();
    await l.post("02-01", "Credit sale", [["1150", "1150", "0"], ["4100", "0", "1000"], ["2170", "0", "150"]]); // 1150 used as a synthetic receivable-like asset
    await l.post("02-20", "Customer paid", [["1120", "1150", "0"], ["1150", "0", "1150"]]);
    await l.post("03-01", "Loan drawn, arrangement fee withheld", [["1120", "9500", "0"], ["6900", "500", "0"], ["2220", "0", "10000"]]);
    const cf = await cashFlowStatement(year());
    // operating: sale collected 1,150 (incl. VAT still owed) → +1,150; financing: 9,500 received
    assert.deepEqual(sections(cf), { operating: "1150.00", investing: "0.00", financing: "9500.00", netChange: "10650.00" });
    assert.equal(cf.netProfit, "500.00", "1,000 sales − 500 fee");
    assert.equal(adj(cf, "6900"), "500.00", "the withheld fee is a non-cash financing item added back");
    assert.equal(cf.reconciled, true);
  });
});

describe("cash flow — supplier bill for a fixed asset", () => {
  test("bill on credit is non-cash; bank payments matched to it are investing (net) and operating (VAT)", async () => {
    const l = await ledger();
    for (const key of ["payables.recognition", "bank.posting"]) { const p = await draftPolicy(key, {}, l.prep); await approvePolicy(p.id, l.appr); }
    await updateSettings({ bankPostingFrom: D("02-01") }, l.prep);
    const vat = await prisma.taxCategory.create({ data: { code: "VAT15", nameEn: "Standard 15%", nameAr: "قياسية 15%", rate: dec("15.00"), isDefault: true } });
    const supplier = await prisma.supplier.create({ data: { name: "مورد المعدات", vatNumber: "310245678900003", paymentTermsDays: 30 } });
    const bank = await prisma.cashAccount.create({ data: { code: "BANK1", nameEn: "Main bank", type: "BANK", openingBalance: dec("0"), openingBalanceDate: D("01-01") } });
    await setCashAccountGl(bank.id, l.acc["1120"], l.prep);
    const cat = await prisma.finCategory.create({ data: { code: "SUPPLIERS", nameEn: "Suppliers", kind: "PAYMENT" } });
    await setCategoryGl(cat.id, l.acc["2110"], l.prep);

    const b = await createBill({ supplierId: supplier.id, supplierInvoiceNo: "EQ-1", billDate: `${YEAR}-02-05`, lines: [{ kind: "EXPENSE", accountId: l.acc["1210"], description: "محمصة 15 كغ", quantity: "1", unitPrice: "40000", taxCategoryId: vat.id }] }, l.prep);
    await submitBill(b.id, l.prep); await approveBill(b.id, l.appr);
    await postBill(b.id, l.appr);
    const ob = (await prisma.supplierBill.findUniqueOrThrow({ where: { id: b.id } })).obligationId!;
    const pay = async (md: string, amount: string) => {
      const t = await prisma.bankTransaction.create({ data: {
        cashAccountId: bank.id, branchKey: "COMPANY", txnDate: D(md), amount: dec(`-${amount}`), status: "CONFIRMED", classification: "SUPPLIER_PAYMENT", reviewStatus: "NEEDS_REVIEW",
        splits: { create: [{ finCategoryId: cat.id, amount: dec(`-${amount}`) }] }, matches: { create: [{ targetType: "OBLIGATION", targetId: ob, amount: dec(amount) }] } } });
      await prisma.bankTransaction.update({ where: { id: t.id }, data: { reviewStatus: "REVIEWED" } });
    };
    await pay("03-10", "23000");
    await pay("04-10", "23000");
    await processPendingEvents();

    const feb = await cashFlowStatement({ from: D("02-01"), to: D("02-28") });
    assert.deepEqual(sections(feb), { operating: "0.00", investing: "0.00", financing: "0.00", netChange: "0.00" });
    assert.deepEqual(nonCash(feb), ["40000.00"], "the asset acquired on credit (net of recoverable VAT)");

    const mar = await cashFlowStatement({ from: D("03-01"), to: D("03-31") });
    assert.deepEqual(sections(mar), { operating: "-3000.00", investing: "-20000.00", financing: "0.00", netChange: "-23000.00" }, "half of 40,000 net + half of 6,000 VAT");

    const all = await cashFlowStatement(year());
    assert.deepEqual(sections(all), { operating: "-6000.00", investing: "-40000.00", financing: "0.00", netChange: "-46000.00" });
    assert.equal(all.reconciled, true);
  });
});
