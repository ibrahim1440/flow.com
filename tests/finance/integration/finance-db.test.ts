// Database integration tests for the finance module, against the local erp_finance_test DB.
// Run: npm run test:finance:db   (starts nothing; needs `node .local-postgres/pg.mjs` running)
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, reset, makeUser, ALL_SCOPE_SUBS, APPROVER_SUBS } from "./support";
import { resolveScope, COMPANY, FinanceError } from "../../../src/lib/finance/server/context";
import { createAccount, createManualTransaction, reviewTransaction, commitImport, previewImport, createTransfer, voidTransaction, addMatch, listTransactions, getTransaction } from "../../../src/lib/finance/server/transactions";
import { createCategory, saveRuleDraft, submitRuleVersion, runAllocation, manualAllocate, createReservation, executeReservation, listCategories, requestCategoryTransfer, previewAllocation } from "../../../src/lib/finance/server/allocation";
import { decideApproval, approvalQueue } from "../../../src/lib/finance/server/approvals";
import { installRecommended, createBranch, setBranchAccess } from "../../../src/lib/finance/server/setup";
import { poolSummaries } from "../../../src/lib/finance/server/ledger";
import { createBudget, saveDraftLines, submitBudget, budgetReport, startRevision, saveForecastSnapshot } from "../../../src/lib/finance/server/budgets";
import { createObligation, supersedeObligation, listObligations, createForecastItem } from "../../../src/lib/finance/server/obligations";
import { overview, cashForecast, accrualReadiness } from "../../../src/lib/finance/server/dashboard";
import { saveReconciliation } from "../../../src/lib/finance/server/reconciliation";
import { monthOf, riyadhDateString, addDays, monthStart } from "../../../src/lib/finance/dates";
import { toMinor } from "../../../src/lib/finance/money";

const today = riyadhDateString();
const month = monthOf(today);
const d1 = monthStart(month);

type Ctx = Awaited<ReturnType<typeof setup>>;
async function setup() {
  const prep = await makeUser("Preparer", ALL_SCOPE_SUBS);
  const appr = await makeUser("Approver", APPROVER_SUBS);
  const prepScope = await resolveScope(prep);
  await installRecommended(prep, prepScope, COMPANY);
  const bank = await createAccount(prep, prepScope, { code: "BANK1", nameEn: "Main bank", openingBalanceDate: d1, accountLast4: "1234" });
  const bank2 = await createAccount(prep, prepScope, { code: "BANK2", nameEn: "Second bank", openingBalanceDate: d1 });
  const fin = Object.fromEntries((await prisma.finCategory.findMany()).map((c) => [c.code, c.id]));
  return { prep, appr, prepScope, apprScope: await resolveScope(appr), bank, bank2, fin };
}

async function receipt(c: Ctx, amount: string, opts: { cls?: string; account?: string; ref?: string; cat?: string; date?: string } = {}) {
  const { transaction } = await createManualTransaction(c.prep, c.prepScope, { cashAccountId: opts.account ?? c.bank.id, amount, txnDate: opts.date ?? today, bankReference: opts.ref });
  const r = await reviewTransaction(c.prep, c.prepScope, transaction.id, { classification: opts.cls ?? "CUSTOMER_RECEIPT", splits: [{ finCategoryId: c.fin[opts.cat ?? "RC-WHOLESALE"], amount }] });
  return r.transaction;
}
async function payment(c: Ctx, amount: string, cat = "PY-GREEN", cls = "SUPPLIER_PAYMENT") {
  const { transaction } = await createManualTransaction(c.prep, c.prepScope, { cashAccountId: c.bank.id, amount: `-${amount}`, txnDate: today });
  return (await reviewTransaction(c.prep, c.prepScope, transaction.id, { classification: cls, splits: [{ finCategoryId: c.fin[cat], amount: `-${amount}` }] })).transaction;
}
async function cat(c: Ctx, code: string, extra: Record<string, unknown> = {}) {
  return createCategory(c.prep, c.prepScope, { code, nameEn: code, ...extra });
}
async function activateRules(c: Ctx, steps: unknown[], extra: Record<string, unknown> = {}) {
  const { version } = await saveRuleDraft(c.prep, c.prepScope, { steps, ...extra });
  const req = await submitRuleVersion(c.prep, c.prepScope, version.id, "test");
  await decideApproval(c.appr, c.apprScope, req.id, { decision: "APPROVE" });
  return version;
}
const bal = async (c: Ctx, id: string) => (await listCategories(prisma, c.prepScope, month)).find((x) => x.id === id)!;
const pool = async (c: Ctx) => (await poolSummaries(prisma, c.prepScope)).find((p) => p.branchKey === COMPANY)!;

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

describe("finance — database integration", () => {
  test("ACCEPTANCE 1 end-to-end: 10,000 via approved rules → 6,500/500/1,800/700/500", async () => {
    const c = await setup();
    const cats = await Promise.all(["G", "P", "S", "R", "M"].map((x) => cat(c, x)));
    await activateRules(c, cats.map((k, i) => ({ method: "PERCENT_OF_BASE", categoryId: k.id, percent: ["65", "5", "18", "7", "5"][i] })));
    const t = await receipt(c, "10000.00");
    const r = await runAllocation(c.prep, c.prepScope, t.id);
    const amounts = await Promise.all(cats.map(async (k) => (await bal(c, k.id)).balance));
    assert.deepEqual(amounts, [650000, 50000, 180000, 70000, 50000]);
    assert.equal(toMinor(r.run.leftUnallocated), 0);
  });

  test("ACCEPTANCE 2 — reimporting a statement and retrying an allocation duplicate nothing", async () => {
    const c = await setup();
    const csv = "Date,Amount,Reference,Description\n" + `${today},150.00,,Cafe sale\n${today},150.00,,Cafe sale\n${today},-75.50,TRX9,Beans\n`;
    const body = { cashAccountId: c.bank.id, csv, mapping: { date: "Date", amount: "Amount", reference: "Reference", description: "Description", dateFormat: "YYYY-MM-DD" } };
    const first = await commitImport(c.prep, c.prepScope, body);
    assert.equal(first.importedCount, 3, "two identical cafe sales are both legitimate");
    const preview = await previewImport(c.prep, c.prepScope, body);
    assert.equal(preview.summary.duplicate, 3);
    const second = await commitImport(c.prep, c.prepScope, body);
    assert.equal(second.importedCount, 0);
    assert.equal(await prisma.bankTransaction.count(), 3);

    const k = await cat(c, "G");
    await activateRules(c, [{ method: "PERCENT_OF_BASE", categoryId: k.id, percent: "50" }]);
    const t = await receipt(c, "1000.00");
    const a = await runAllocation(c.prep, c.prepScope, t.id);
    const b = await runAllocation(c.prep, c.prepScope, t.id);
    assert.equal(b.replayed, true);
    assert.equal(a.run.id, b.run.id);
    assert.equal((await bal(c, k.id)).balance, 50000);

    // Manual entry with the same idempotency key lands once.
    const m1 = await createManualTransaction(c.prep, c.prepScope, { cashAccountId: c.bank.id, amount: "5", txnDate: today, idempotencyKey: "k1" });
    const m2 = await createManualTransaction(c.prep, c.prepScope, { cashAccountId: c.bank.id, amount: "5", txnDate: today, idempotencyKey: "k1" });
    assert.equal(m1.transaction.id, m2.transaction.id);
  });

  test("ACCEPTANCE 3 — concurrent allocation requests cannot spend the same cash twice", async () => {
    const c = await setup();
    const k = await cat(c, "G");
    await activateRules(c, [{ method: "PERCENT_OF_BASE", categoryId: k.id, percent: "100" }]);
    const t = await receipt(c, "1000.00");
    const results = await Promise.all(Array.from({ length: 6 }, () => runAllocation(c.prep, c.prepScope, t.id)));
    assert.equal(new Set(results.map((r) => r.run.id)).size, 1);
    assert.equal(await prisma.allocationRun.count(), 1);
    assert.equal((await bal(c, k.id)).balance, 100000);

    // Manual allocations racing for the same receipt remainder.
    const t2 = await receipt(c, "600.00");
    const k2 = await cat(c, "H");
    const races = await Promise.allSettled(Array.from({ length: 4 }, () => manualAllocate(c.prep, c.prepScope, { categoryId: k2.id, amount: "400", sourceTxnId: t2.id, reason: "race" })));
    assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await bal(c, k2.id)).balance, 40000);
    const p = await pool(c);
    assert.equal(p.allocated + p.unallocated, p.eligibleCash);
    assert.ok(p.unallocated >= 0);
  });

  test("ACCEPTANCE 4 — a transfer between company accounts adds no revenue and no consolidated cash", async () => {
    const c = await setup();
    await receipt(c, "5000.00");
    const before = await overview(prisma, c.prepScope);
    await createTransfer(c.prep, c.prepScope, { fromAccountId: c.bank.id, toAccountId: c.bank2.id, amount: "2000", txnDate: today });
    const afterOv = await overview(prisma, c.prepScope);
    assert.equal(afterOv.monthly.receipts, before.monthly.receipts);
    assert.equal(afterOv.monthly.payments, before.monthly.payments);
    const sum = (o: typeof before) => o.accounts.reduce((s, a) => s + a.bookBalance, 0);
    assert.equal(sum(afterOv), sum(before));
    assert.equal(afterOv.accounts.find((a) => a.id === c.bank2.id)!.bookBalance, 200000);
  });

  test("ACCEPTANCE 5 — reaching a monthly funding target stops further funding", async () => {
    const c = await setup();
    const sal = await cat(c, "SAL", { fundingType: "MONTHLY_TARGET", targetAmount: "3000" });
    await activateRules(c, [{ method: "FILL_TARGET", categoryId: sal.id }]);
    for (const amt of ["2000.00", "2000.00"]) await runAllocation(c.prep, c.prepScope, (await receipt(c, amt)).id);
    assert.equal((await bal(c, sal.id)).balance, 300000);
    // Spend it all; the month is still funded, so a new receipt adds nothing.
    const pay = await payment(c, "3000.00", "PY-SALARY", "PAYROLL");
    const res = await createReservation(c.prep, c.prepScope, { categoryId: sal.id, amount: "3000", payee: "Staff", purpose: "Payroll" });
    await executeReservation(c.prep, c.prepScope, res.reservation.id, { txnId: pay.id });
    await runAllocation(c.prep, c.prepScope, (await receipt(c, "2000.00")).id);
    const s = await bal(c, sal.id);
    assert.equal(s.balance, 0);
    assert.equal(s.allocations, 300000);
  });

  test("ACCEPTANCE 6 — a replenishable reserve refills after spending; a monthly cap does not", async () => {
    const c = await setup();
    const reserve = await cat(c, "RES", { fundingType: "RESERVE_TARGET", targetAmount: "3000", replenish: true, priority: 1 });
    const cap = await cat(c, "CAP", { fundingType: "MONTHLY_TARGET", targetAmount: "1000", priority: 2 });
    await activateRules(c, [{ method: "FILL_TARGET", categoryId: reserve.id }, { method: "FILL_TARGET", categoryId: cap.id }]);
    await runAllocation(c.prep, c.prepScope, (await receipt(c, "4000.00")).id);
    const pay = await payment(c, "3000.00", "PY-UTIL", "UTILITIES_OPERATING");
    const r1 = await createReservation(c.prep, c.prepScope, { categoryId: reserve.id, amount: "3000", payee: "Utility", purpose: "Emergency" });
    await executeReservation(c.prep, c.prepScope, r1.reservation.id, { txnId: pay.id });
    const pay2 = await payment(c, "1000.00", "PY-UTIL", "UTILITIES_OPERATING");
    const r2 = await createReservation(c.prep, c.prepScope, { categoryId: cap.id, amount: "1000", payee: "Utility", purpose: "Monthly" });
    await executeReservation(c.prep, c.prepScope, r2.reservation.id, { txnId: pay2.id });
    await runAllocation(c.prep, c.prepScope, (await receipt(c, "5000.00")).id);
    assert.equal((await bal(c, reserve.id)).balance, 300000, "reserve refilled");
    assert.equal((await bal(c, cap.id)).balance, 0, "monthly cap not refilled");
  });

  test("ACCEPTANCE 7 — an expected but unreceived payment does not increase available cash", async () => {
    const c = await setup();
    await receipt(c, "1000.00");
    const before = await pool(c);
    await createForecastItem(c.prep, c.prepScope, { kind: "RECEIPT", description: "Expected wholesale", amount: "50000", expectedDate: addDays(today, 3) });
    const pending = await createManualTransaction(c.prep, c.prepScope, { cashAccountId: c.bank.id, amount: "7000", txnDate: today, status: "PENDING" });
    const afterP = await pool(c);
    assert.equal(afterP.eligibleCash, before.eligibleCash);
    assert.equal(afterP.unallocated, before.unallocated);
    assert.equal(afterP.pendingIn, 700000);
    const k = await cat(c, "G");
    await assert.rejects(manualAllocate(c.prep, c.prepScope, { categoryId: k.id, amount: "10", sourceTxnId: pending.transaction.id, reason: "x" }), /Pending receipts are not cash|confirmed/);
  });

  test("ACCEPTANCE 8 — reserve then execute: no double deduction", async () => {
    const c = await setup();
    const k = await cat(c, "G");
    const t = await receipt(c, "5000.00");
    await manualAllocate(c.prep, c.prepScope, { categoryId: k.id, amount: "5000", sourceTxnId: t.id, reason: "fund" });
    const res = await createReservation(c.prep, c.prepScope, { categoryId: k.id, amount: "2000", payee: "Supplier", purpose: "Beans", idempotencyKey: "r1" });
    let s = await bal(c, k.id);
    assert.deepEqual([s.balance, s.reserved, s.available], [500000, 200000, 300000]);
    const again = await createReservation(c.prep, c.prepScope, { categoryId: k.id, amount: "2000", payee: "Supplier", purpose: "Beans", idempotencyKey: "r1" });
    assert.equal(again.reservation.id, res.reservation.id);
    const before = await pool(c);
    const pay = await payment(c, "2000.00");
    await executeReservation(c.prep, c.prepScope, res.reservation.id, { txnId: pay.id });
    await executeReservation(c.prep, c.prepScope, res.reservation.id, { txnId: pay.id }); // replay
    s = await bal(c, k.id);
    assert.deepEqual([s.balance, s.reserved, s.available], [300000, 0, 300000]);
    const afterP = await pool(c);
    assert.equal(afterP.eligibleCash, before.eligibleCash - 200000);
    assert.equal(afterP.unallocated, before.unallocated, "unallocated cash unchanged by a funded payment");
  });

  test("ACCEPTANCE 9 — cancellations, refunds, partial receipts and gateway fees", async () => {
    const c = await setup();
    // Gateway settlement: gross 1,000, fee 25, net 975 deposited.
    const { transaction: s } = await createManualTransaction(c.prep, c.prepScope, { cashAccountId: c.bank.id, amount: "975", txnDate: today });
    await reviewTransaction(c.prep, c.prepScope, s.id, {
      classification: "GATEWAY_SETTLEMENT", grossAmount: "1000", feeAmount: "25",
      splits: [{ finCategoryId: c.fin["RC-ONLINE"], amount: "1000" }, { finCategoryId: c.fin["PY-FEES"], amount: "-25" }],
    });
    const acc = (await overview(prisma, c.prepScope)).accounts.find((a) => a.id === c.bank.id)!;
    assert.equal(acc.bookBalance, 97500, "cash moves by the net deposit only");
    const b = await createBudget(c.prep, c.prepScope, { month });
    const rep = await budgetReport(prisma, c.prepScope, b.id, today);
    assert.equal(rep.rows.find((r) => r.code === "RC-ONLINE")!.actualToDate, 100000, "gross receipt");
    assert.equal(rep.rows.find((r) => r.code === "PY-FEES")!.actualToDate, 2500, "fee as a payment");
    assert.equal(rep.netCashFlow.toDate, 97500, "no double counting");

    // Partial and combined receipts against orders.
    const cust = await prisma.customer.create({ data: { name: "Café Riyadh" } });
    const o1 = await prisma.order.create({ data: { orderNumber: 1, customerId: cust.id } });
    const o2 = await prisma.order.create({ data: { orderNumber: 2, customerId: cust.id } });
    const r1 = await receipt(c, "600.00");
    const r2 = await receipt(c, "1400.00");
    await addMatch(c.prep, c.prepScope, r1.id, { targetType: "ORDER", targetId: o1.id, amount: "600" });
    await addMatch(c.prep, c.prepScope, r2.id, { targetType: "ORDER", targetId: o1.id, amount: "400" });
    await addMatch(c.prep, c.prepScope, r2.id, { targetType: "ORDER", targetId: o2.id, amount: "1000" });
    await assert.rejects(addMatch(c.prep, c.prepScope, r2.id, { targetType: "ORDER", targetId: o2.id, amount: "1" }), FinanceError);
    assert.equal(await prisma.bankTransaction.count({ where: { amount: { gt: 0 } } }), 3, "matching created no new receipts");

    // Cancellation after part of the money was spent: reversal exposes the shortfall.
    const k = await cat(c, "G");
    await manualAllocate(c.prep, c.prepScope, { categoryId: k.id, amount: "1400", sourceTxnId: r2.id, reason: "fund" });
    const pay = await payment(c, "1000.00");
    const res = await createReservation(c.prep, c.prepScope, { categoryId: k.id, amount: "1000", payee: "S", purpose: "Beans" });
    await executeReservation(c.prep, c.prepScope, res.reservation.id, { txnId: pay.id });
    const v = await voidTransaction(c.prep, c.prepScope, r2.id, "Bounced transfer");
    assert.equal(v.reversal!.shortfalls.length, 1);
    assert.equal((await bal(c, k.id)).balance, -100000, "shortfall shown, not hidden");
    const p = await pool(c);
    assert.equal(p.allocated + p.unallocated, p.eligibleCash);
    // Refund to a customer is a payment, never negative revenue on the receipt line.
    const refund = await payment(c, "50.00", "RC-WHOLESALE", "CUSTOMER_REFUND").catch((e) => e);
    assert.ok(!(refund instanceof Error));
    // Append-only ledger: history cannot be edited.
    await assert.rejects(prisma.allocationEntry.deleteMany({}));
  });

  test("ACCEPTANCE 13 — forecasts and revisions never change the approved budget", async () => {
    const c = await setup();
    const b = await createBudget(c.prep, c.prepScope, { month });
    await saveDraftLines(c.prep, c.prepScope, b.id, { lines: [{ kind: "PAYMENT", finCategoryId: c.fin["PY-RENT"], plannedAmount: "10000", dueDate: `${month}-25` }] });
    const req = await submitBudget(c.prep, c.prepScope, b.id, {});
    await assert.rejects(decideApproval(c.prep, c.prepScope, req.id, { decision: "APPROVE" }), /cannot decide|duty/);
    await decideApproval(c.appr, c.apprScope, req.id, { decision: "APPROVE" });
    const rev1 = await prisma.budgetRevision.findFirstOrThrow({ where: { budgetId: b.id, revisionNo: 1 }, include: { lines: true } });
    await createForecastItem(c.prep, c.prepScope, { kind: "PAYMENT", description: "Extra", amount: "500", expectedDate: `${month}-28`, finCategoryId: c.fin["PY-RENT"] });
    await saveForecastSnapshot(c.prep, c.prepScope, b.id, today);
    await startRevision(c.prep, c.prepScope, b.id, "Rent increase");
    await saveDraftLines(c.prep, c.prepScope, b.id, { lines: [{ kind: "PAYMENT", finCategoryId: c.fin["PY-RENT"], plannedAmount: "12000", dueDate: `${month}-25` }] });
    const req2 = await submitBudget(c.prep, c.prepScope, b.id, {});
    await decideApproval(c.appr, c.apprScope, req2.id, { decision: "APPROVE" });
    const rev1After = await prisma.budgetRevision.findFirstOrThrow({ where: { budgetId: b.id, revisionNo: 1 }, include: { lines: true } });
    assert.equal(toMinor(rev1After.lines[0].plannedAmount), toMinor(rev1.lines[0].plannedAmount));
    const rep = await budgetReport(prisma, c.prepScope, b.id, `${month}-${String(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate())}`);
    const row = rep.rows.find((r) => r.code === "PY-RENT")!;
    assert.equal(row.originalApproved, 1_000_000);
    assert.equal(row.revisedApproved, 1_200_000);
    await assert.rejects(prisma.budgetLine.updateMany({ where: { revisionId: rev1.id }, data: { plannedAmount: "1" } }), "DB refuses edits to approved lines");
  });

  test("ACCEPTANCE 15 — PO → bill → payment counts the obligation once", async () => {
    const c = await setup();
    const [po] = await createObligation(c.prep, c.prepScope, { type: "PURCHASE_ORDER", description: "Green beans PO", amount: "8000", dueDate: addDays(today, 10), finCategoryId: c.fin["PY-GREEN"] });
    const total = async () => (await listObligations(prisma, c.prepScope)).rows.reduce((s, r) => s + r.remaining, 0);
    const payOut = async () => (await cashForecast(prisma, c.prepScope)).base.weeks.reduce((s, w) => s + w.payments, 0);
    assert.equal(await total(), 800000);
    assert.equal(await payOut(), 800000);
    const bill = await supersedeObligation(c.prep, c.prepScope, po.id, { amount: "8000" });
    assert.equal(await total(), 800000, "bill replaces the PO");
    assert.equal(await payOut(), 800000);
    await receipt(c, "9000.00");
    const pay = await payment(c, "8000.00");
    await addMatch(c.prep, c.prepScope, pay.id, { targetType: "OBLIGATION", targetId: bill.id, amount: "8000" });
    assert.equal(await total(), 0);
    assert.equal(await payOut(), 0);
    assert.equal((await prisma.finObligation.findUniqueOrThrow({ where: { id: bill.id } })).status, "PAID");
  });

  test("ACCEPTANCE 16 (service layer) — duties are enforced regardless of the UI", async () => {
    const c = await setup();
    const viewer = await makeUser("Viewer", ["all_branches"]);
    const vs = await resolveScope(viewer);
    await assert.rejects(createManualTransaction(viewer, vs, { cashAccountId: c.bank.id, amount: "1", txnDate: today }), /Insufficient permissions/);
    await assert.rejects(createBudget(viewer, vs, { month }), /Insufficient permissions/);
    const k = await cat(c, "G");
    await assert.rejects(manualAllocate(viewer, vs, { categoryId: k.id, amount: "1", sourceCashAccountId: c.bank.id, reason: "x" }), /Insufficient permissions/);
    // A preparer cannot approve their own transfer request.
    const t = await receipt(c, "100.00");
    await manualAllocate(c.prep, c.prepScope, { categoryId: k.id, amount: "100", sourceTxnId: t.id, reason: "x" });
    const k2 = await cat(c, "H");
    const req = await requestCategoryTransfer(c.prep, c.prepScope, { fromCategoryId: k.id, toCategoryId: k2.id, amount: "50", reason: "move" });
    await assert.rejects(decideApproval(c.prep, c.prepScope, req.id, { decision: "APPROVE" }), /duty|cannot decide/);
    const q = await approvalQueue(prisma, c.appr, c.apprScope);
    assert.ok(q.toDecide.some((r) => r.id === req.id), "request is in the approver's queue");
    await decideApproval(c.appr, c.apprScope, req.id, { decision: "APPROVE" });
    assert.equal((await bal(c, k2.id)).balance, 5000);
  });

  test("ACCEPTANCE 17 — branch isolation on reads and writes", async () => {
    const c = await setup();
    const a = await createBranch(c.prep, { code: "CAFE", nameEn: "Café" });
    const b = await createBranch(c.prep, { code: "ONLINE", nameEn: "Online" });
    const scope = await resolveScope(c.prep);
    const accA = await createAccount(c.prep, scope, { code: "CAFE-POS", nameEn: "Café POS", branchKey: a.id, openingBalanceDate: d1 });
    const accB = await createAccount(c.prep, scope, { code: "WEB", nameEn: "Web", branchKey: b.id, openingBalanceDate: d1 });
    await createManualTransaction(c.prep, scope, { cashAccountId: accB.id, amount: "999", txnDate: today });
    const cafe = await makeUser("Café manager", ["txn_enter", "budget_prepare"]);
    // Branch access is an administrator's change (D6): finance settings + may edit employees.
    await setBranchAccess({ ...c.prep, permissions: { ...c.prep.permissions, employees: { access: "edit" } } }, { employeeId: cafe.id, branchId: a.id });
    const cs = await resolveScope(cafe);
    assert.deepEqual(cs, { all: false, branchKeys: [a.id] });
    const { rows } = await listTransactions(prisma, cs, new URLSearchParams());
    assert.equal(rows.length, 0, "cannot read the online branch's lines");
    const bLine = await prisma.bankTransaction.findFirstOrThrow({ where: { cashAccountId: accB.id } });
    await assert.rejects(getTransaction(prisma, cs, bLine.id), /Not found/);
    await assert.rejects(createManualTransaction(cafe, cs, { cashAccountId: accB.id, amount: "1", txnDate: today }), /not found/i);
    await assert.rejects(createBudget(cafe, cs, { month }), /Not found/, "company budget needs company-wide access");
    await createManualTransaction(cafe, cs, { cashAccountId: accA.id, amount: "10", txnDate: today });
    assert.equal((await listTransactions(prisma, cs, new URLSearchParams())).rows.length, 1);
  });

  test("ACCEPTANCE 18 — allocated + unallocated = eligible cash; restricted and pending explained", async () => {
    const c = await setup();
    const restricted = await createAccount(c.prep, c.prepScope, { code: "GUAR", nameEn: "Guarantee", isRestricted: true, openingBalance: "20000", openingBalanceDate: d1 });
    const opening = await createAccount(c.prep, c.prepScope, { code: "CASH", nameEn: "Cash box", type: "CASH", openingBalance: "3000", openingBalanceDate: d1 });
    const k = await cat(c, "G");
    await receipt(c, "7000.00");
    await manualAllocate(c.prep, c.prepScope, { categoryId: k.id, amount: "2500", sourceCashAccountId: opening.id, reason: "opening" });
    await createManualTransaction(c.prep, c.prepScope, { cashAccountId: c.bank.id, amount: "400", txnDate: today, status: "PENDING" });
    await assert.rejects(manualAllocate(c.prep, c.prepScope, { categoryId: k.id, amount: "1", sourceCashAccountId: restricted.id, reason: "x" }), /Restricted/);
    const p = await pool(c);
    assert.equal(p.bookCash, 3_000_000);
    assert.equal(p.restrictedCash, 2_000_000);
    assert.equal(p.eligibleCash, 1_000_000);
    assert.equal(p.allocated, 250_000);
    assert.equal(p.unallocated, 750_000);
    assert.equal(p.allocated + p.unallocated, p.eligibleCash);
    assert.equal(p.pendingIn, 40_000);
  });

  test("ACCEPTANCE 19 — accounting net profit is never inferred from receipts minus payments", async () => {
    const c = await setup();
    await receipt(c, "5000.00");
    await payment(c, "1000.00");
    const a = await accrualReadiness(prisma);
    assert.equal(a.available, false);
    const ov = await overview(prisma, c.prepScope);
    assert.equal(JSON.stringify(ov).toLowerCase().includes("profit"), false, "overview exposes no profit figure");
    const b = await createBudget(c.prep, c.prepScope, { month });
    const rep = await budgetReport(prisma, c.prepScope, b.id, today);
    assert.equal(rep.budget.basis, "CASH");
    assert.match(rep.basisNote, /not profit/);
    assert.equal(Object.keys(rep).some((k) => /profit/i.test(k)), false);
    await assert.rejects(createBudget(c.prep, c.prepScope, { month: "2027-01", basis: "ACCRUAL" }), /accrual/i);
  });

  test("WORKFLOW — budget → approve → import → match & classify → allocate → reserve & pay → actuals & variance", async () => {
    const c = await setup();
    // 1. Budget, submitted and approved by someone else.
    const b = await createBudget(c.prep, c.prepScope, { month, title: "Month plan" });
    await saveDraftLines(c.prep, c.prepScope, b.id, { lines: [
      { kind: "RECEIPT", finCategoryId: c.fin["RC-WHOLESALE"], plannedAmount: "20000", phasing: "STRAIGHT_LINE" },
      { kind: "PAYMENT", finCategoryId: c.fin["PY-GREEN"], plannedAmount: "10000", dueDate: d1 },
    ] });
    const breq = await submitBudget(c.prep, c.prepScope, b.id, {});
    await decideApproval(c.appr, c.apprScope, breq.id, { decision: "APPROVE" });
    assert.equal((await prisma.finBudget.findUniqueOrThrow({ where: { id: b.id } })).status, "APPROVED");
    // 2. Allocation rules approved.
    const green = await cat(c, "GREEN-ENV", { priority: 1 });
    const vat = await cat(c, "VAT-ENV", { isTaxReserve: true });
    await activateRules(c, [{ method: "RECEIPT_TAX_COMPONENT", categoryId: vat.id }, { method: "PERCENT_OF_BASE", categoryId: green.id, percent: "60" }]);
    // 3. Import the statement.
    const mapping = { date: "Date", amount: "Amount", reference: "Reference", description: "Description", dateFormat: "YYYY-MM-DD" };
    await commitImport(c.prep, c.prepScope, { cashAccountId: c.bank.id, csv: `Date,Amount,Reference,Description\n${today},11500.00,WIRE-1,Café Riyadh wholesale\n`, mapping });
    const [inLine] = await prisma.bankTransaction.findMany({ where: { amount: { gt: 0 } } });
    assert.equal(inLine.reviewStatus, "NEEDS_REVIEW", "imports enter the review queue");
    // 4. Match to the order (with its VAT) and classify.
    const cust = await prisma.customer.create({ data: { name: "Café Riyadh" } });
    const order = await prisma.order.create({ data: { orderNumber: 77, customerId: cust.id } });
    await addMatch(c.prep, c.prepScope, inLine.id, { targetType: "ORDER", targetId: order.id, amount: "11500", taxAmount: "1500" });
    await reviewTransaction(c.prep, c.prepScope, inLine.id, { classification: "CUSTOMER_RECEIPT", splits: [{ finCategoryId: c.fin["RC-WHOLESALE"], amount: "11500" }] });
    // 5. Preview (incl. lower collections) then allocate.
    const version = await prisma.allocationRuleVersion.findFirstOrThrow({ where: { status: "ACTIVE" } });
    const pv = await previewAllocation(c.prep, c.prepScope, { versionId: version.id, txnId: inLine.id, lowerCollectionsPct: 70 });
    assert.equal(pv.scenario.base, 1_000_000);
    await runAllocation(c.prep, c.prepScope, inLine.id);
    assert.equal((await bal(c, vat.id)).balance, 150_000, "VAT from the matched invoice, not a flat %");
    assert.equal((await bal(c, green.id)).balance, 600_000);
    // 6. Reserve and execute the supplier payment (above available → override approval).
    const res = await createReservation(c.prep, c.prepScope, { categoryId: green.id, amount: "12000", payee: "Beans supplier", purpose: "Green coffee" });
    assert.equal(res.reservation.status, "PENDING_APPROVAL");
    const oq = await approvalQueue(prisma, c.appr, c.apprScope);
    const ov = oq.toDecide.find((r) => r.type === "SPEND_OVERRIDE")!;
    await decideApproval(c.appr, c.apprScope, ov.id, { decision: "APPROVE", note: "Harvest lot" });
    // The supplier is paid; the next statement brings the outgoing line.
    await commitImport(c.prep, c.prepScope, { cashAccountId: c.bank.id, csv: `Date,Amount,Reference,Description\n${today},-12000.00,OUT-7,Beans supplier\n`, mapping });
    const [outLine] = await prisma.bankTransaction.findMany({ where: { amount: { lt: 0 } } });
    await reviewTransaction(c.prep, c.prepScope, outLine.id, { classification: "SUPPLIER_PAYMENT", splits: [{ finCategoryId: c.fin["PY-GREEN"], amount: "-12000" }] });
    await executeReservation(c.prep, c.prepScope, res.reservation.id, { txnId: outLine.id });
    assert.equal((await bal(c, green.id)).balance, -600_000, "override spending shows as a negative category balance");
    // 7. Actuals and variance.
    await saveReconciliation(c.prep, c.prepScope, { cashAccountId: c.bank.id, statementDate: today, statementBalance: "-500" });
    const early = await budgetReport(prisma, c.prepScope, b.id, today);
    assert.equal(early.completeness.complete, false, "an unreconciled account keeps actuals provisional");
    await saveReconciliation(c.prep, c.prepScope, { cashAccountId: c.bank2.id, statementDate: today, statementBalance: "0" });
    const rep = await budgetReport(prisma, c.prepScope, b.id, today);
    const rec = rep.rows.find((r) => r.code === "RC-WHOLESALE")!;
    const pay = rep.rows.find((r) => r.code === "PY-GREEN")!;
    assert.equal(rec.actualToDate, 1_150_000);
    assert.equal(pay.actualToDate, 1_200_000);
    assert.equal(pay.toDate.variance, 200_000);
    assert.equal(pay.toDate.state, "OVERRUN");
    assert.equal(pay.toDate.percentBp, 2000);
    assert.equal(rep.completeness.complete, true, "every line reviewed and the account reconciled");
  });
});
