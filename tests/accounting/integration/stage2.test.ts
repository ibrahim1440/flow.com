// Stage 2 against real PostgreSQL: supplier bills (lifecycle, four-eyes, immutability, VAT,
// obligation, journal, reversal) and bank-to-ledger (payments against bills, expenses,
// transfers once, voids mirrored, blocked cases, reconciliation). Expected journals are
// written out by hand. Run: npm run test:accounting:db
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, makeUser, rejects } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear, lockFiscalPeriod } from "../../../src/lib/accounting/fiscal-period-service";
import { draftPolicy, approvePolicy } from "../../../src/lib/accounting/policy-service";
import { processEvent, processPendingEvents } from "../../../src/lib/accounting/event-processor";
import { createBill, submitBill, approveBill, rejectBill, postBill, reverseBill, updateDraftBill, computeLine, isKsaVatNumber, type BillInput } from "../../../src/lib/accounting/payables-service";
import { requestBankCorrection, approveBankCorrection } from "../../../src/lib/accounting/bank-correction-service";
import { apAging, supplierStatement, bankReconciliation, setCashAccountGl, setCategoryGl } from "../../../src/lib/accounting/stage2-service";
import { createManualJournalEntry, submitJournalEntry, approveJournalEntry, postJournalEntry } from "../../../src/lib/accounting/journal-service";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const YEAR = Number(todayAccountingDate().toISOString().slice(0, 4));
const D = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const dec = (s: string) => new Prisma.Decimal(s);

async function world(opts: { approvePolicies?: boolean } = {}) {
  const prep = await makeUser("AP clerk");
  const appr = await makeUser("Controller");
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: accountingDate(D(1, 1)), setupComplete: true }, prep);
  await updateSettings({ bankPostingFrom: accountingDate(D(2, 1)) }, prep);
  if (opts.approvePolicies !== false) {
    for (const key of ["payables.recognition", "bank.posting"]) { const p = await draftPolicy(key, {}, prep); await approvePolicy(p.id, appr); }
  }
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const vat15 = await prisma.taxCategory.create({ data: { code: "VAT15", nameEn: "Standard 15%", nameAr: "قياسية 15%", rate: dec("15.00"), isDefault: true } });
  const supplier = await prisma.supplier.create({ data: { name: "محمصة الوادي للتوريد", vatNumber: "310245678900003", paymentTermsDays: 30 } });
  const noVat = await prisma.supplier.create({ data: { name: "ورشة صيانة المكائن" } });
  const bank = await prisma.cashAccount.create({ data: { code: "BANK1", nameEn: "Main bank", type: "BANK", openingBalance: dec("0"), openingBalanceDate: accountingDate(D(1, 1)) } });
  const cash = await prisma.cashAccount.create({ data: { code: "CASH1", nameEn: "Till", type: "CASH", openingBalance: dec("0"), openingBalanceDate: accountingDate(D(1, 1)) } });
  await setCashAccountGl(bank.id, acc["1120"], prep);
  await setCashAccountGl(cash.id, acc["1110"], prep);
  const cat = async (code: string, kind: "PAYMENT" | "RECEIPT", gl: string | null) => {
    const c = await prisma.finCategory.create({ data: { code, nameEn: code, kind } });
    if (gl) await setCategoryGl(c.id, acc[gl], prep);
    return c.id;
  };
  const cats = { SUP: await cat("SUPPLIERS", "PAYMENT", "2110"), RENT: await cat("RENT", "PAYMENT", "6200"), OTHER: await cat("UNMAPPED", "PAYMENT", null), SALES: await cat("SALES", "RECEIPT", "4100") };
  return { prep, appr, acc, vat15: vat15.id, supplier: supplier.id, noVat: noVat.id, bank: bank.id, cash: cash.id, cats };
}
type W = Awaited<ReturnType<typeof world>>;

const billInput = (w: W, over: Partial<BillInput> = {}): BillInput => ({
  supplierId: w.supplier, supplierInvoiceNo: "INV-88213", billDate: D(3, 3),
  lines: [
    { kind: "STOCK_RECEIPT", description: "بن إثيوبي جوجي 400 كغ", quantity: "400", unitPrice: "28.50", taxCategoryId: w.vat15 },
    { kind: "EXPENSE", accountId: w.acc["6500"], description: "شحن من الميناء", quantity: "1", unitPrice: "1000", taxCategoryId: w.vat15 },
  ],
  ...over,
});

async function postedBill(w: W, over: Partial<BillInput> = {}) {
  const b = await createBill(billInput(w, over), w.prep);
  await submitBill(b.id, w.prep);
  await approveBill(b.id, w.appr);
  return postBill(b.id, w.appr);
}

async function journalLines(journalEntryId: string) {
  const rows = await prisma.journalEntryLine.findMany({ where: { journalEntryId }, include: { account: { select: { code: true } } }, orderBy: { lineNo: "asc" } });
  return rows.map((r) => ({ code: r.account.code, dr: r.debit.toFixed(2), cr: r.credit.toFixed(2), party: r.partyId ? `${r.partyType}` : null }));
}

async function bankLine(w: W, o: { account?: string; date: string; amount: string; cls: string; splits?: { cat: string; amount: string }[]; matchOb?: { id: string; amount: string }; reviewed?: boolean; peer?: string }) {
  const t = await prisma.bankTransaction.create({
    data: {
      cashAccountId: o.account ?? w.bank, branchKey: "COMPANY", txnDate: accountingDate(o.date), amount: dec(o.amount), status: "CONFIRMED",
      classification: o.cls as never, reviewStatus: "NEEDS_REVIEW", bankReference: `REF-${Math.random().toString(36).slice(2, 7)}`,
      splits: o.splits ? { create: o.splits.map((s) => ({ finCategoryId: s.cat, amount: dec(s.amount) })) } : undefined,
      matches: o.matchOb ? { create: [{ targetType: "OBLIGATION", targetId: o.matchOb.id, amount: dec(o.matchOb.amount) }] } : undefined,
    },
  });
  if (o.reviewed !== false) await prisma.bankTransaction.update({ where: { id: t.id }, data: { reviewStatus: "REVIEWED" } });
  return t.id;
}
const eventOf = (key: string) => prisma.accountingEvent.findUnique({ where: { idempotencyKey: key } });

describe("stage 2 — supplier bills", () => {
  beforeEach(reset);
  after(() => prisma.$disconnect());

  test("line arithmetic and VAT numbers", () => {
    assert.deepEqual(Object.values(computeLine(dec("400"), dec("28.50"), dec("15"))).map((d) => d.toFixed(2)), ["11400.00", "1710.00", "13110.00"]);
    assert.deepEqual(Object.values(computeLine(dec("3"), dec("0.335"), dec("15"))).map((d) => d.toFixed(2)), ["1.01", "0.15", "1.16"]);
    assert.equal(isKsaVatNumber("310245678900003"), true);
    assert.equal(isKsaVatNumber("310245678900004"), false);
    assert.equal(isKsaVatNumber("21024567890000"), false);
  });

  test("create → submit → four-eyes approve → post: obligation, journal and aging tie out", async () => {
    const w = await world();
    const b = await createBill(billInput(w), w.prep);
    assert.equal(b.totalNet.toFixed(2), "12400.00"); assert.equal(b.totalVat.toFixed(2), "1860.00"); assert.equal(b.totalGross.toFixed(2), "14260.00");
    assert.equal(b.dueDate.toISOString().slice(0, 10), D(4, 2), "due date from supplier terms (30 days)");
    await submitBill(b.id, w.prep);
    await rejects(approveBill(b.id, w.prep), /someone else must approve/);
    await approveBill(b.id, w.appr);
    const r = await postBill(b.id, w.appr);
    assert.equal(r.bill.status, "POSTED");
    assert.equal(r.ledger?.status, "TRANSLATED");
    const ob = await prisma.finObligation.findUniqueOrThrow({ where: { id: r.bill.obligationId! } });
    assert.equal(ob.type, "SUPPLIER_BILL"); assert.equal(ob.amount.toFixed(2), "14260.00"); assert.equal(ob.sourceId, b.id);
    assert.deepEqual(await journalLines(r.ledger!.journalEntryId!), [
      { code: "2120", dr: "11400.00", cr: "0.00", party: null },
      { code: "6500", dr: "1000.00", cr: "0.00", party: null },
      { code: "1160", dr: "1860.00", cr: "0.00", party: null },
      { code: "2110", dr: "0.00", cr: "14260.00", party: "SUPPLIER" },
    ]);
    const je = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.ledger!.journalEntryId! } });
    assert.equal(je.policyKey, "payables.recognition"); assert.equal(je.isProvisional, false);
    assert.equal(je.entryDate.toISOString().slice(0, 10), D(3, 3));
    const aging = await apAging(accountingDate(D(3, 31)));
    assert.equal(aging.subledger, "14260.00"); assert.equal(aging.ledger, "14260.00"); assert.equal(aging.reconciled, true);
    assert.equal(aging.totals.current, "14260.00");
    const late = await apAging(accountingDate(D(4, 20)));
    assert.equal(late.totals.d1_30, "14260.00", "18 days overdue");
  });

  test("database guards: posted bills and their lines are frozen; four-eyes and totals enforced in SQL", async () => {
    const w = await world();
    const r = await postedBill(w);
    await rejects(prisma.$executeRawUnsafe(`UPDATE "SupplierBill" SET "totalGross" = 1 WHERE id = '${r.bill.id}'`), /cannot be changed|reverse it/);
    await rejects(prisma.$executeRawUnsafe(`UPDATE "SupplierBillLine" SET "net" = 1, "gross" = 1 + "vat" WHERE "billId" = '${r.bill.id}'`), /cannot change/);
    await rejects(prisma.$executeRawUnsafe(`DELETE FROM "SupplierBill" WHERE id = '${r.bill.id}'`), /Only a draft/);
    const b2 = await createBill(billInput(w, { supplierInvoiceNo: "INV-2" }), w.prep);
    await submitBill(b2.id, w.prep);
    await rejects(prisma.$executeRawUnsafe(`UPDATE "SupplierBill" SET status = 'APPROVED', "approvedBy" = "createdBy" WHERE id = '${b2.id}'`), /someone other than/);
    await rejects(prisma.$executeRawUnsafe(`UPDATE "SupplierBill" SET status = 'POSTED' WHERE id = '${b2.id}'`), /cannot move/);
    const b3 = await createBill(billInput(w, { supplierInvoiceNo: "INV-3" }), w.prep);
    await prisma.$executeRawUnsafe(`UPDATE "SupplierBill" SET "totalGross" = 5, "totalNet" = 5, "totalVat" = 0 WHERE id = '${b3.id}'`);
    await rejects(submitBill(b3.id, w.prep), /totals do not equal/);
    await rejects(createBill(billInput(w), w.prep), /already exists/);
  });

  test("input VAT needs the supplier's VAT number; zero-rated bill from an unregistered supplier is fine", async () => {
    const w = await world();
    const b = await createBill(billInput(w, { supplierId: w.noVat, supplierInvoiceNo: "118" }), w.prep);
    await submitBill(b.id, w.prep);
    await rejects(approveBill(b.id, w.appr), /no valid VAT registration number/);
    await rejectBill(b.id, w.appr, "بلا رقم ضريبي");
    await updateDraftBill(b.id, billInput(w, { supplierId: w.noVat, supplierInvoiceNo: "118", lines: [{ kind: "EXPENSE", accountId: w.acc["6700"], quantity: "1", unitPrice: "900" }] }), w.prep);
    await submitBill(b.id, w.prep); await approveBill(b.id, w.appr);
    const r = await postBill(b.id, w.appr);
    assert.deepEqual((await journalLines(r.ledger!.journalEntryId!)).map((l) => `${l.code}:${l.dr}:${l.cr}`), ["6700:900.00:0.00", "2110:0.00:900.00"]);
  });

  test("a bill line cannot debit a control account or a revenue account", async () => {
    const w = await world();
    await rejects(createBill(billInput(w, { lines: [{ kind: "EXPENSE", accountId: w.acc["1160"], quantity: "1", unitPrice: "10" }] }), w.prep), /control account/);
    await rejects(createBill(billInput(w, { lines: [{ kind: "EXPENSE", accountId: w.acc["2110"], quantity: "1", unitPrice: "10" }] }), w.prep), /expense or asset/);
    await rejects(createBill(billInput(w, { lines: [{ kind: "EXPENSE", accountId: w.acc["4100"], quantity: "1", unitPrice: "10" }] }), w.prep), /expense or asset/);
  });

  test("posting refuses a locked period; the PO obligation is superseded", async () => {
    const w = await world();
    const po = await prisma.finObligation.create({ data: { branchKey: "COMPANY", type: "PURCHASE_ORDER", description: "PO-2026-0412", amount: dec("11500"), dueDate: accountingDate(D(4, 1)), sourceType: "MANUAL" } });
    const r = await postedBill(w, { purchaseObligationId: po.id });
    assert.equal((await prisma.finObligation.findUniqueOrThrow({ where: { id: po.id } })).status, "SUPERSEDED");
    assert.equal((await prisma.finObligation.findUniqueOrThrow({ where: { id: r.bill.obligationId! } })).supersedesId, po.id);
    const march = await prisma.fiscalPeriod.findFirstOrThrow({ where: { year: YEAR, periodNo: 3 } });
    await lockFiscalPeriod(march.id, w.appr);
    const b = await createBill(billInput(w, { supplierInvoiceNo: "INV-LOCKED" }), w.prep);
    await submitBill(b.id, w.prep); await approveBill(b.id, w.appr);
    await rejects(postBill(b.id, w.appr), /locked/);
  });

  test("reversal: refused while a payment is matched; otherwise mirror journal and cancelled obligation", async () => {
    const w = await world();
    const r = await postedBill(w);
    const t = await bankLine(w, { date: D(3, 10), amount: "-2000.00", cls: "SUPPLIER_PAYMENT", splits: [{ cat: w.cats.SUP, amount: "-2000.00" }], matchOb: { id: r.bill.obligationId!, amount: "2000.00" } });
    await rejects(reverseBill(r.bill.id, w.appr, "إرجاع البضاعة"), /Payments are matched/);
    await prisma.bankTransactionMatch.updateMany({ where: { transactionId: t }, data: { active: false } });
    const rv = await reverseBill(r.bill.id, w.appr, "إرجاع البضاعة كاملة");
    assert.equal(rv.bill.status, "REVERSED");
    assert.equal((await prisma.finObligation.findUniqueOrThrow({ where: { id: r.bill.obligationId! } })).status, "CANCELLED");
    assert.deepEqual((await journalLines(rv.ledger!.journalEntryId!)).map((l) => `${l.code}:${l.dr}:${l.cr}`), ["2120:0.00:11400.00", "6500:0.00:1000.00", "1160:0.00:1860.00", "2110:14260.00:0.00"]);
  });

  test("policy gate: unapproved payables policy → BLOCKED; provisional only on a marked disposable DB with the switch", async () => {
    const w = await world({ approvePolicies: false });
    const r = await postedBill(w);
    assert.equal(r.ledger?.status, "BLOCKED");
    process.env.ACCOUNTING_PROVISIONAL_POSTING = "isolated-test";
    const again = await processEvent((await eventOf(`payables:${r.bill.id}:ap.bill.posted`))!.id);
    assert.equal(again.status, "TRANSLATED"); assert.equal(again.provisional, true);
  });
});

describe("stage 2 — bank to ledger", () => {
  beforeEach(reset);

  test("supplier payment matched to a posted bill: Dr payables (supplier) / Cr bank; aging and statement settle", async () => {
    const w = await world();
    const r = await postedBill(w);
    const t = await bankLine(w, { date: D(3, 15), amount: "-14260.00", cls: "SUPPLIER_PAYMENT", splits: [{ cat: w.cats.SUP, amount: "-14260.00" }], matchOb: { id: r.bill.obligationId!, amount: "14260.00" } });
    await processPendingEvents();
    const ev = await eventOf(`bank:${t}:confirmed`);
    assert.equal(ev?.status, "TRANSLATED", ev?.errorMessage ?? "");
    assert.deepEqual(await journalLines(ev!.journalEntryId!), [{ code: "1120", dr: "0.00", cr: "14260.00", party: null }, { code: "2110", dr: "14260.00", cr: "0.00", party: "SUPPLIER" }]);
    const aging = await apAging(accountingDate(D(3, 31)));
    assert.equal(aging.subledger, "0.00"); assert.equal(aging.ledger, "0.00"); assert.equal(aging.reconciled, true);
    const st = await supplierStatement(w.supplier, accountingDate(D(3, 1)), accountingDate(D(3, 31)));
    assert.equal(st.closing, "0.00"); assert.equal(st.ledgerBalance, "0.00");
    assert.equal(await processEvent(ev!.id).then((x) => x.status), "TRANSLATED", "reprocessing is a no-op");
    assert.equal(await prisma.journalEntry.count({ where: { originEventId: ev!.id } }), 1);
  });

  test("payables split without a matching posted bill → BLOCKED with the unmatched amount", async () => {
    const w = await world();
    const t = await bankLine(w, { date: D(3, 15), amount: "-500.00", cls: "SUPPLIER_PAYMENT", splits: [{ cat: w.cats.SUP, amount: "-500.00" }] });
    await processPendingEvents();
    const ev = await eventOf(`bank:${t}:confirmed`);
    assert.equal(ev?.status, "BLOCKED"); assert.match(ev!.errorMessage!, /500\.00 SAR on the payables category is not matched/);
  });

  test("expense line posts to the category account; unmapped category, unmapped cash account and customer receipts are BLOCKED", async () => {
    const w = await world();
    const rent = await bankLine(w, { date: D(3, 5), amount: "-15000.00", cls: "RENT", splits: [{ cat: w.cats.RENT, amount: "-15000.00" }] });
    const unmapped = await bankLine(w, { date: D(3, 6), amount: "-50.00", cls: "OTHER_OPERATING_PAYMENT", splits: [{ cat: w.cats.OTHER, amount: "-50.00" }] });
    const receipt = await bankLine(w, { date: D(3, 7), amount: "1150.00", cls: "CUSTOMER_RECEIPT", splits: [{ cat: w.cats.SALES, amount: "1150.00" }] });
    await processPendingEvents();
    const e1 = await eventOf(`bank:${rent}:confirmed`);
    assert.deepEqual((await journalLines(e1!.journalEntryId!)).map((l) => `${l.code}:${l.dr}:${l.cr}`), ["1120:0.00:15000.00", "6200:15000.00:0.00"]);
    assert.match((await eventOf(`bank:${unmapped}:confirmed`))!.errorMessage!, /not mapped to a ledger account: UNMAPPED/);
    assert.match((await eventOf(`bank:${receipt}:confirmed`))!.errorMessage!, /stage 3/);
    const b2 = await prisma.cashAccount.create({ data: { code: "BANK2", nameEn: "Second bank", type: "BANK", openingBalance: dec("0"), openingBalanceDate: accountingDate(D(1, 1)) } });
    const t2 = await bankLine(w, { account: b2.id, date: D(3, 8), amount: "-15000.00", cls: "RENT", splits: [{ cat: w.cats.RENT, amount: "-15000.00" }] });
    await processPendingEvents();
    assert.match((await eventOf(`bank:${t2}:confirmed`))!.errorMessage!, /BANK2 is not mapped/);
  });

  test("transfer between company accounts posts once; lines before the bank start date are SKIPPED; void mirrors", async () => {
    const w = await world();
    const out = await bankLine(w, { date: D(3, 9), amount: "-5000.00", cls: "INTERNAL_TRANSFER", reviewed: false });
    const inn = await bankLine(w, { account: w.cash, date: D(3, 9), amount: "5000.00", cls: "INTERNAL_TRANSFER", reviewed: false });
    await prisma.bankTransaction.update({ where: { id: out }, data: { transferPeerId: inn } });
    await prisma.bankTransaction.update({ where: { id: inn }, data: { transferPeerId: out } });
    await prisma.bankTransaction.updateMany({ where: { id: { in: [out, inn] } }, data: { reviewStatus: "REVIEWED" } });
    const early = await bankLine(w, { date: D(1, 20), amount: "-100.00", cls: "RENT", splits: [{ cat: w.cats.RENT, amount: "-100.00" }] });
    await processPendingEvents();
    const eo = await eventOf(`bank:${out}:confirmed`);
    assert.deepEqual((await journalLines(eo!.journalEntryId!)).map((l) => `${l.code}:${l.dr}:${l.cr}`), ["1110:5000.00:0.00", "1120:0.00:5000.00"]);
    assert.equal((await eventOf(`bank:${inn}:confirmed`))?.status, "SKIPPED");
    assert.equal((await eventOf(`bank:${early}:confirmed`))?.status, "SKIPPED");
    // Reconciliation: the receiving leg is in the ledger through the paying leg's journal.
    const rec = await bankReconciliation(accountingDate(D(3, 10)));
    const till = rec.accounts.find((a) => a.cashAccount.code === "CASH1")!;
    assert.equal(till.book, "5000.00"); assert.equal(till.ledger, "5000.00"); assert.equal(till.difference, "0.00");
    assert.deepEqual(till.items.notPosted, [], "the transfer's receiving leg is not reported as unposted");
    // A posted line is voided only through an approved correction (both legs of a transfer).
    await rejects(prisma.bankTransaction.update({ where: { id: out }, data: { status: "VOID", voidedAt: new Date(), voidedBy: w.appr, voidReason: "duplicate" } }), /only through an approved correction/);
    const c = await requestBankCorrection(out, { kind: "VOID", reason: "duplicate transfer" }, w.prep);
    const applied = await approveBankCorrection(c.id, w.appr);
    assert.deepEqual(new Set(applied.voided), new Set([out, inn]));
    const ev = await eventOf(`bank:${out}:voided`);
    assert.equal(ev?.status, "TRANSLATED", ev?.errorMessage ?? "");
    assert.deepEqual((await journalLines(ev!.journalEntryId!)).map((l) => `${l.code}:${l.dr}:${l.cr}`), ["1110:0.00:5000.00", "1120:5000.00:0.00"]);
  });

  test("bank ↔ ledger reconciliation ties per cash account; manual journals may no longer touch a mapped cash GL", async () => {
    const w = await world();
    await bankLine(w, { date: D(3, 5), amount: "-15000.00", cls: "RENT", splits: [{ cat: w.cats.RENT, amount: "-15000.00" }] });
    const pending = await bankLine(w, { date: D(3, 6), amount: "-50.00", cls: "OTHER_OPERATING_PAYMENT", splits: [{ cat: w.cats.OTHER, amount: "-50.00" }] });
    await processPendingEvents();
    const rec = await bankReconciliation(accountingDate(D(3, 31)));
    const b1 = rec.accounts.find((a) => a.cashAccount.code === "BANK1")!;
    assert.equal(b1.book, "-15050.00"); assert.equal(b1.ledger, "-15000.00"); assert.equal(b1.difference, "-50.00");
    assert.deepEqual(b1.items.notPosted.map((x) => x.id), [pending], "the whole difference is itemised");
    await rejects(createManualJournalEntry({ entryDate: accountingDate(D(3, 20)), type: "MANUAL", lines: [{ accountId: w.acc["6900"], debit: "10", credit: "0" }, { accountId: w.acc["1120"], debit: "0", credit: "10" }] }, w.prep), /cash accounts are posted from bank lines only/);
    const before = await createManualJournalEntry({ entryDate: accountingDate(D(1, 25)), type: "MANUAL", lines: [{ accountId: w.acc["6900"], debit: "10", credit: "0" }, { accountId: w.acc["1120"], debit: "0", credit: "10" }] }, w.prep);
    await submitJournalEntry(before.id, w.prep); await approveJournalEntry(before.id, w.appr);
    assert.equal((await postJournalEntry(before.id, w.appr)).status, "POSTED", "before the bank start date manual cash journals still post");
  });
});
