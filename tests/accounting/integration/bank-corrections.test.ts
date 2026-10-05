// Posted bank lines are immutable; the only change is an approved reversal-and-replacement.
// Against real PostgreSQL: the database guard (every accounting-relevant field, splits, matches,
// transfer links, void), the four-eyes correction workflow, supplier allocations, concurrency
// (two approvals; an edit racing the posting), retries, and locked periods.
// Run: npm run test:accounting:db
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, makeUser, rejects } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear, lockFiscalPeriod } from "../../../src/lib/accounting/fiscal-period-service";
import { draftPolicy, approvePolicy } from "../../../src/lib/accounting/policy-service";
import { processEvent, processPendingEvents } from "../../../src/lib/accounting/event-processor";
import { createBill, submitBill, approveBill, postBill } from "../../../src/lib/accounting/payables-service";
import { apAging, setCashAccountGl, setCategoryGl } from "../../../src/lib/accounting/stage2-service";
import { requestBankCorrection, approveBankCorrection, rejectBankCorrection } from "../../../src/lib/accounting/bank-correction-service";
import { recomputeObligationStatus } from "../../../src/lib/finance/server/obligations";
import { postedBankLines } from "../../../src/lib/accounting/bank-posted";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const YEAR = Number(todayAccountingDate().toISOString().slice(0, 4));
const D = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const TODAY = todayAccountingDate().toISOString().slice(0, 10);
const dec = (s: string) => new Prisma.Decimal(s);

async function world() {
  const prep = await makeUser("Finance clerk");
  const appr = await makeUser("Controller");
  const appr2 = await makeUser("Second controller");
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: accountingDate(D(1, 1)), setupComplete: true }, prep);
  await updateSettings({ bankPostingFrom: accountingDate(D(2, 1)) }, prep);
  for (const key of ["payables.recognition", "bank.posting"]) { const p = await draftPolicy(key, {}, prep); await approvePolicy(p.id, appr); }
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const vat15 = await prisma.taxCategory.create({ data: { code: "VAT15", nameEn: "Standard 15%", nameAr: "قياسية 15%", rate: dec("15.00"), isDefault: true } });
  const supplier = await prisma.supplier.create({ data: { name: "محمصة الوادي للتوريد", vatNumber: "310245678900003", paymentTermsDays: 30 } });
  const bank = await prisma.cashAccount.create({ data: { code: "BANK1", nameEn: "Main bank", type: "BANK", openingBalance: dec("0"), openingBalanceDate: accountingDate(D(1, 1)) } });
  const cash = await prisma.cashAccount.create({ data: { code: "CASH1", nameEn: "Till", type: "CASH", openingBalance: dec("0"), openingBalanceDate: accountingDate(D(1, 1)) } });
  await setCashAccountGl(bank.id, acc["1120"], prep);
  await setCashAccountGl(cash.id, acc["1110"], prep);
  const cat = async (code: string, gl: string | null) => {
    const c = await prisma.finCategory.create({ data: { code, nameEn: code, kind: "PAYMENT" } });
    if (gl) await setCategoryGl(c.id, acc[gl], prep);
    return c.id;
  };
  const cats = { SUP: await cat("SUPPLIERS", "2110"), RENT: await cat("RENT", "6200"), UTIL: await cat("UTILITIES", "6300"), OTHER: await cat("UNMAPPED", null) };
  return { prep, appr, appr2, acc, vat15: vat15.id, supplier: supplier.id, bank: bank.id, cash: cash.id, cats };
}
type W = Awaited<ReturnType<typeof world>>;

async function line(w: W, o: { account?: string; date: string; amount: string; cls: string; splits: { cat: string; amount: string }[]; matchOb?: { id: string; amount: string } }) {
  const t = await prisma.bankTransaction.create({ data: {
    cashAccountId: o.account ?? w.bank, branchKey: "COMPANY", txnDate: accountingDate(o.date), amount: dec(o.amount), status: "CONFIRMED",
    classification: o.cls as never, reviewStatus: "NEEDS_REVIEW", bankReference: `REF-${Math.random().toString(36).slice(2, 7)}`,
    splits: { create: o.splits.map((s) => ({ finCategoryId: s.cat, amount: dec(s.amount) })) },
    matches: o.matchOb ? { create: [{ targetType: "OBLIGATION", targetId: o.matchOb.id, amount: dec(o.matchOb.amount) }] } : undefined,
  } });
  await prisma.bankTransaction.update({ where: { id: t.id }, data: { reviewStatus: "REVIEWED" } });
  return t.id;
}
const eventOf = (key: string) => prisma.accountingEvent.findUnique({ where: { idempotencyKey: key } });
async function jl(key: string) {
  const ev = await eventOf(key);
  assert.equal(ev?.status, "TRANSLATED", `${key}: ${ev?.status} ${ev?.errorMessage ?? ""}`);
  const rows = await prisma.journalEntryLine.findMany({ where: { journalEntryId: ev!.journalEntryId! }, include: { account: { select: { code: true } } }, orderBy: { lineNo: "asc" } });
  return rows.map((r) => `${r.account.code}:${r.debit.toFixed(2)}:${r.credit.toFixed(2)}`);
}
async function ledgerBalance(code: string) {
  const r = await prisma.$queryRaw<{ s: string }[]>`SELECT COALESCE(SUM(l.debit - l.credit), 0)::text s FROM "JournalEntryLine" l JOIN "Account" a ON a.id = l."accountId" JOIN "JournalEntry" e ON e.id = l."journalEntryId" WHERE a.code = ${code} AND e.status IN ('POSTED','REVERSED')`;
  return Number(r[0].s).toFixed(2);
}

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

describe("posted bank lines — database guard", () => {
  test("every accounting-relevant field, split, match and the transfer link is frozen once posted; other fields are not", async () => {
    const w = await world();
    const t = await line(w, { date: D(3, 5), amount: "-15000.00", cls: "RENT", splits: [{ cat: w.cats.RENT, amount: "-15000.00" }] });
    await processPendingEvents();
    assert.equal((await postedBankLines(prisma, [t])).size, 1);
    const upd = (data: Prisma.BankTransactionUncheckedUpdateInput) => prisma.bankTransaction.update({ where: { id: t }, data });
    for (const data of [{ amount: dec("-14000") }, { txnDate: accountingDate(D(3, 6)) }, { cashAccountId: w.cash }, { classification: "SUPPLIER_PAYMENT" as never },
      { branchKey: "OTHER" }, { feeAmount: dec("1") }, { currency: "USD" }, { transferPeerId: t }]) {
      await rejects(upd(data), /posted to the ledger/);
    }
    await rejects(upd({ reviewStatus: "NEEDS_REVIEW" }), /cannot be sent back to review/);
    await rejects(upd({ status: "VOID", voidedAt: new Date(), voidedBy: w.appr }), /only through an approved correction/);
    const split = (await prisma.bankTransactionSplit.findFirstOrThrow({ where: { transactionId: t } })).id;
    await rejects(prisma.bankTransactionSplit.update({ where: { id: split }, data: { amount: dec("-1") } }), /budget splits cannot change/);
    await rejects(prisma.bankTransactionSplit.delete({ where: { id: split } }), /budget splits cannot change/);
    await rejects(prisma.bankTransactionSplit.create({ data: { transactionId: t, finCategoryId: w.cats.UTIL, amount: dec("0") } }), /budget splits cannot change/);
    await rejects(prisma.bankTransactionMatch.create({ data: { transactionId: t, targetType: "OBLIGATION", targetId: "x", amount: dec("1") } }), /matches to documents cannot change/);
    // Descriptive fields stay editable (no ledger effect).
    await upd({ description: "Rent — March (landlord ref 44)", bankReference: "TRF-9", reviewNote: "checked" });
    // Nothing changed in the ledger.
    assert.deepEqual(await jl(`bank:${t}:confirmed`), ["1120:0.00:15000.00", "6200:15000.00:0.00"]);
  });

  test("a line that has not posted (blocked) can still be fixed, and then posts the fixed data", async () => {
    const w = await world();
    const t = await line(w, { date: D(3, 7), amount: "-800.00", cls: "OTHER_OPERATING_PAYMENT", splits: [{ cat: w.cats.OTHER, amount: "-800.00" }] });
    await processPendingEvents();
    assert.equal((await eventOf(`bank:${t}:confirmed`))?.status, "BLOCKED");
    const split = (await prisma.bankTransactionSplit.findFirstOrThrow({ where: { transactionId: t } })).id;
    await prisma.bankTransactionSplit.update({ where: { id: split }, data: { finCategoryId: w.cats.UTIL } });
    await processEvent((await eventOf(`bank:${t}:confirmed`))!.id);
    assert.deepEqual(await jl(`bank:${t}:confirmed`), ["1120:0.00:800.00", "6300:800.00:0.00"]);
  });

  test("an edit racing the posting: the edit that commits first is what posts; after posting it is refused", async () => {
    const w = await world();
    const t = await line(w, { date: D(3, 8), amount: "-500.00", cls: "RENT", splits: [{ cat: w.cats.RENT, amount: "-500.00" }] });
    const ev = (await eventOf(`bank:${t}:confirmed`))!;
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(`UPDATE "BankTransaction" SET amount = -450 WHERE id = $1`, [t]);
      await c.query(`UPDATE "BankTransactionSplit" SET amount = -450 WHERE "transactionId" = $1`, [t]);
      const posting = processEvent(ev.id);                  // waits for the row lock held by the edit
      await new Promise((r) => setTimeout(r, 400));
      await c.query("COMMIT");
      assert.equal((await posting).status, "TRANSLATED");
    } finally { await c.end(); }
    assert.deepEqual(await jl(`bank:${t}:confirmed`), ["1120:0.00:450.00", "6200:450.00:0.00"], "the committed edit posted, not the stale amount");
    await rejects(prisma.bankTransaction.update({ where: { id: t }, data: { amount: dec("-400") } }), /posted to the ledger/);
  });
});

describe("posted bank lines — reversal-and-replacement correction", () => {
  test("replace: four-eyes; original voided and mirrored; replacement posts; audit trail; request immutable", async () => {
    const w = await world();
    const t = await line(w, { date: D(3, 5), amount: "-15000.00", cls: "RENT", splits: [{ cat: w.cats.RENT, amount: "-15000.00" }] });
    await processPendingEvents();
    await rejects(requestBankCorrection(t, { kind: "REPLACE", reason: "wrong amount" }, w.prep), /corrected line/);
    const c = await requestBankCorrection(t, { kind: "REPLACE", reason: "the bank charged 14,500 not 15,000", replacement: {
      txnDate: D(3, 5), amount: "-14500.00", classification: "RENT", splits: [{ finCategoryId: w.cats.RENT, amount: "-14000.00" }, { finCategoryId: w.cats.UTIL, amount: "-500.00" }] } }, w.prep);
    await rejects(requestBankCorrection(t, { kind: "VOID", reason: "second request" }, w.prep), /already waiting/);
    await rejects(approveBankCorrection(c.id, w.prep), /someone other than/);
    await rejects(prisma.bankCorrection.update({ where: { id: c.id }, data: { reason: "edited later" } }), /cannot be edited/);
    await rejects(prisma.bankCorrection.update({ where: { id: c.id }, data: { status: "APPROVED", approvedBy: w.prep, approvedAt: new Date() } }), /someone other than/);
    await rejects(prisma.bankCorrection.delete({ where: { id: c.id } }), /cannot be deleted/);

    const r = await approveBankCorrection(c.id, w.appr);
    assert.deepEqual(r.ledger.map((x) => x.status), ["TRANSLATED", "TRANSLATED"]);
    assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t } })).status, "VOID");
    const n = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: r.replacementId! } });
    assert.equal(n.replacesTransactionId, t);
    assert.deepEqual(await jl(`bank:${t}:voided`), ["1120:15000.00:0.00", "6200:0.00:15000.00"], "mirror of the original");
    assert.deepEqual((await jl(`bank:${n.id}:confirmed`)).sort(), ["1120:0.00:14500.00", "6200:14000.00:0.00", "6300:500.00:0.00"].sort());
    assert.equal(await ledgerBalance("1120"), "-14500.00");
    const audit = (await prisma.finAuditLog.findMany({ where: { OR: [{ entityId: c.id }, { entityId: t }] } })).map((a) => a.action).sort();
    assert.deepEqual(audit, ["bank.correction.applied", "bank.correction.requested", "bank.line.voided_by_correction"].sort());
    // Retries: the decision is final, and reprocessing adds nothing.
    await rejects(approveBankCorrection(c.id, w.appr2), /no longer pending/);
    const before = await prisma.journalEntry.count();
    await processPendingEvents();
    for (const k of [`bank:${t}:voided`, `bank:${n.id}:confirmed`]) await processEvent((await eventOf(k))!.id);
    assert.equal(await prisma.journalEntry.count(), before);
    await rejects(prisma.bankCorrection.update({ where: { id: c.id }, data: { status: "PENDING" } }), /cannot move/);
  });

  test("supplier allocation corrected: payment matched to a bill replaced by a smaller one; obligation and aging follow", async () => {
    const w = await world();
    const b = await createBill({ supplierId: w.supplier, supplierInvoiceNo: "INV-1", billDate: D(3, 1), lines: [{ kind: "EXPENSE", accountId: w.acc["6500"], description: "شحن", quantity: "1", unitPrice: "2000", taxCategoryId: w.vat15 }] }, w.prep);
    await submitBill(b.id, w.prep); await approveBill(b.id, w.appr); await postBill(b.id, w.appr);
    const ob = (await prisma.supplierBill.findUniqueOrThrow({ where: { id: b.id } })).obligationId!;
    const t = await line(w, { date: D(3, 10), amount: "-2300.00", cls: "SUPPLIER_PAYMENT", splits: [{ cat: w.cats.SUP, amount: "-2300.00" }], matchOb: { id: ob, amount: "2300.00" } });
    await prisma.$transaction((tx) => recomputeObligationStatus(tx, ob));   // as Finance's matching does
    await processPendingEvents();
    assert.equal((await prisma.finObligation.findUniqueOrThrow({ where: { id: ob } })).status, "PAID");
    const c = await requestBankCorrection(t, { kind: "REPLACE", reason: "only half was paid; the rest was a bank error", replacement: {
      txnDate: D(3, 10), amount: "-1150.00", classification: "SUPPLIER_PAYMENT", splits: [{ finCategoryId: w.cats.SUP, amount: "-1150.00" }], matches: [{ targetType: "OBLIGATION", targetId: ob, amount: "1150.00" }] } }, w.prep);
    const r = await approveBankCorrection(c.id, w.appr);
    assert.equal((await prisma.finObligation.findUniqueOrThrow({ where: { id: ob } })).status, "PARTIALLY_PAID");
    assert.equal((await prisma.bankTransactionMatch.findFirstOrThrow({ where: { transactionId: t } })).active, false, "the original match is released");
    assert.equal(await ledgerBalance("2110"), "-1150.00", "2,300 bill less 1,150 paid");
    const aging = await apAging(accountingDate(D(3, 31)));
    assert.equal(aging.reconciled, true, JSON.stringify({ sub: aging.subledger, ledger: aging.ledger, expl: aging.explanation }));
    assert.ok(r.replacementId);
  });

  test("two approvers at the same moment: exactly one applies", async () => {
    const w = await world();
    const t = await line(w, { date: D(3, 5), amount: "-900.00", cls: "RENT", splits: [{ cat: w.cats.RENT, amount: "-900.00" }] });
    await processPendingEvents();
    const c = await requestBankCorrection(t, { kind: "REPLACE", reason: "wrong category", replacement: { txnDate: D(3, 5), amount: "-900.00", classification: "OTHER_OPERATING_PAYMENT", splits: [{ finCategoryId: w.cats.UTIL, amount: "-900.00" }] } }, w.prep);
    const out = await Promise.allSettled([approveBankCorrection(c.id, w.appr), approveBankCorrection(c.id, w.appr2)]);
    assert.deepEqual(out.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
    assert.match(String((out.find((o) => o.status === "rejected") as PromiseRejectedResult).reason), /no longer pending|decided meanwhile/);
    assert.equal(await prisma.bankTransaction.count({ where: { replacesTransactionId: t } }), 1);
    assert.equal(await prisma.journalEntry.count({ where: { sourceModule: "bank", sourceDocumentId: t } }), 2, "original + one mirror");
    assert.equal(await ledgerBalance("6300"), "900.00");
    assert.equal(await ledgerBalance("6200"), "0.00");
  });

  test("periods: the original's period may be locked; the replacement and today's reversal need open periods", async () => {
    const w = await world();
    const t = await line(w, { date: D(3, 5), amount: "-700.00", cls: "RENT", splits: [{ cat: w.cats.RENT, amount: "-700.00" }] });
    await processPendingEvents();
    const periods = await prisma.fiscalPeriod.findMany({ where: { year: YEAR }, orderBy: { periodNo: "asc" } });
    await lockFiscalPeriod(periods[2].id, w.appr);                                         // March
    await rejects(requestBankCorrection(t, { kind: "REPLACE", reason: "wrong amount", replacement: { txnDate: D(3, 5), amount: "-650.00", classification: "RENT", splits: [{ finCategoryId: w.cats.RENT, amount: "-650.00" }] } }, w.prep), /locked/);
    const c = await requestBankCorrection(t, { kind: "REPLACE", reason: "wrong amount", replacement: { txnDate: TODAY, amount: "-650.00", classification: "RENT", splits: [{ finCategoryId: w.cats.RENT, amount: "-650.00" }] } }, w.prep);
    const current = periods.find((p) => p.startDate <= todayAccountingDate() && p.endDate >= todayAccountingDate())!;
    await lockFiscalPeriod(current.id, w.appr);
    await rejects(approveBankCorrection(c.id, w.appr), /locked/);
    assert.equal((await prisma.bankCorrection.findUniqueOrThrow({ where: { id: c.id } })).status, "PENDING", "nothing half-applied");
    assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t } })).status, "CONFIRMED");
    const rej = await rejectBankCorrection(c.id, w.appr, "resubmit after the period review");
    assert.equal(rej.status, "REJECTED");
  });

  test("transfers are voided on both legs; replacement of a transfer and corrections of unposted lines are refused", async () => {
    const w = await world();
    const out = await line(w, { date: D(3, 9), amount: "-5000.00", cls: "INTERNAL_TRANSFER", splits: [] });
    const inn = await line(w, { account: w.cash, date: D(3, 9), amount: "5000.00", cls: "INTERNAL_TRANSFER", splits: [] });
    // Link before posting (Finance pairs lines, then they post from the paying leg).
    await prisma.$executeRaw`UPDATE "BankTransaction" SET "transferPeerId" = ${inn} WHERE id = ${out}`;
    await prisma.$executeRaw`UPDATE "BankTransaction" SET "transferPeerId" = ${out} WHERE id = ${inn}`;
    await processPendingEvents();
    await rejects(prisma.bankTransaction.update({ where: { id: inn }, data: { transferPeerId: null } }), /posted to the ledger/);
    await rejects(requestBankCorrection(out, { kind: "REPLACE", reason: "wrong amount", replacement: { txnDate: D(3, 9), amount: "-4000.00", classification: "RENT", splits: [] } }, w.prep), /transfer is corrected by voiding/);
    const c = await requestBankCorrection(inn, { kind: "VOID", reason: "transfer never happened" }, w.prep);
    const r = await approveBankCorrection(c.id, w.appr);
    assert.deepEqual(new Set(r.voided), new Set([out, inn]));
    assert.equal(await ledgerBalance("1110"), "0.00");
    assert.equal(await ledgerBalance("1120"), "0.00");
    const unposted = await line(w, { date: D(3, 9), amount: "-10.00", cls: "OTHER_OPERATING_PAYMENT", splits: [{ cat: w.cats.OTHER, amount: "-10.00" }] });
    await processPendingEvents();
    await rejects(requestBankCorrection(unposted, { kind: "VOID", reason: "not posted yet" }, w.prep), /has not posted/);
  });
});
