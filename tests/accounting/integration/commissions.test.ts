// Commission ledger → general ledger. Movements are inserted the way the commission engine
// writes them (one CommissionLedgerEntry row each); the database trigger turns each into one
// AccountingEvent, and the processor posts it. Expected journals are written out by hand.
// Run: npm run test:accounting:db
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, makeUser, rejects } from "./support";
import { applyChartTemplate, updateSettings, setMapping } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear, lockFiscalPeriod } from "../../../src/lib/accounting/fiscal-period-service";
import { draftPolicy, approvePolicy, approveCommissionPlanVersion } from "../../../src/lib/accounting/policy-service";
import { processEvent, processPendingEvents } from "../../../src/lib/accounting/event-processor";
import { commissionReconciliation, trialBalance } from "../../../src/lib/accounting/reports";
import { requestJournalReversal } from "../../../src/lib/accounting/journal-service";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const TODAY = todayAccountingDate();
const YEAR = Number(TODAY.toISOString().slice(0, 4));

async function world() {
  const prep = await makeUser("Accountant");
  const appr = await makeUser("Controller");
  const salesAdmin = await makeUser("Sales admin");
  const rep = await prisma.employee.create({ data: { name: "Rep One", pin: "x", role: "custom" } });
  const rep2 = await prisma.employee.create({ data: { name: "Rep Two", pin: "x", role: "custom" } });
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: accountingDate(`${YEAR}-01-01`), setupComplete: true }, prep);
  const plan = await prisma.commissionPlan.create({ data: { code: "STD", name: "Standard" } });
  const pv = await prisma.commissionPlanVersion.create({ data: { planId: plan.id, version: 1, baseRatePercent: new Prisma.Decimal("2.000000"), effectiveFrom: new Date(`${YEAR}-01-01T00:00:00Z`), createdById: salesAdmin } });
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  return { prep, appr, salesAdmin, rep: rep.id, rep2: rep2.id, pv: pv.id, acc };
}

const periodStart = new Date(`${YEAR}-01-01T00:00:00Z`);
async function movement(employeeId: string, type: "ACCRUAL" | "REVERSAL" | "ADJUSTMENT" | "PAYOUT", amount: string, planVersionId: string | null, createdAt?: Date) {
  return prisma.commissionLedgerEntry.create({ data: { type, employeeId, periodStart, amount: new Prisma.Decimal(amount), planVersionId, ...(createdAt ? { createdAt } : {}) } });
}

async function linesOf(journalEntryId: string) {
  const ls = await prisma.journalEntryLine.findMany({ where: { journalEntryId }, include: { account: true }, orderBy: { lineNo: "asc" } });
  return ls.map((l) => `${l.account.code} Dr${l.debit.toFixed(2)} Cr${l.credit.toFixed(2)}${l.partyId ? " P" : ""}`);
}

async function approveEverything(w: Awaited<ReturnType<typeof world>>) {
  const d = await draftPolicy("commissions.recognition", {}, w.prep);
  await approvePolicy(d.id, w.appr);
  await approveCommissionPlanVersion(w.pv, w.appr);
}

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

describe("outbox", () => {
  test("every commission movement produces exactly one event in the same transaction, whichever path wrote it", async () => {
    const w = await world();
    const m1 = await movement(w.rep, "ACCRUAL", "300.00", w.pv);
    await movement(w.rep, "ADJUSTMENT", "-20.00", null);
    await rejects(prisma.$transaction(async (tx) => {
      await tx.commissionLedgerEntry.create({ data: { type: "ACCRUAL", employeeId: w.rep, periodStart, amount: new Prisma.Decimal("1"), planVersionId: w.pv } });
      throw new Error("rolled back on purpose");
    }), /rolled back on purpose/);
    const evs = await prisma.accountingEvent.findMany({ orderBy: { occurredAt: "asc" } });
    assert.equal(evs.length, 2, "the rolled-back movement left no event");
    assert.deepEqual(evs.map((e) => e.eventType), ["commission.accrual", "commission.adjustment"]);
    assert.equal(evs[0].sourceDocumentId, m1.id);
    assert.equal(evs[0].partyKey, `EMPLOYEE:${w.rep}`);
    await rejects(prisma.$executeRaw`DELETE FROM "AccountingEvent" WHERE "id" = ${evs[0].id}`, /cannot be deleted/);
    await rejects(prisma.$executeRaw`UPDATE "AccountingEvent" SET "payload" = '{}'::jsonb WHERE "id" = ${evs[0].id}`, /cannot be rewritten/);
  });
});

describe("posting gate", () => {
  test("without approvals nothing posts: the event is BLOCKED with the reasons", async () => {
    const w = await world();
    const m = await movement(w.rep, "ACCRUAL", "300.00", w.pv);
    const ev = await prisma.accountingEvent.findFirstOrThrow({ where: { sourceDocumentId: m.id } });
    const r = await processEvent(ev.id);
    assert.equal(r.status, "BLOCKED");
    assert.match(r.message!, /policy "commissions.recognition" has no approved version/);
    assert.match(r.message!, /STD v1 is not approved for accounting/);
    assert.equal(await prisma.journalEntry.count(), 0);
  });

  test("in the isolated test database, provisional posting is allowed and labelled", async () => {
    const w = await world();
    process.env.ACCOUNTING_PROVISIONAL_POSTING = "isolated-test";
    const m = await movement(w.rep, "ACCRUAL", "300.00", w.pv);
    const ev = await prisma.accountingEvent.findFirstOrThrow({ where: { sourceDocumentId: m.id } });
    const r = await processEvent(ev.id);
    assert.equal(r.status, "TRANSLATED");
    assert.equal(r.provisional, true);
    const je = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.journalEntryId! } });
    assert.equal(je.isProvisional, true);
    assert.equal(je.type, "AUTO");
    assert.equal(je.status, "POSTED");
    assert.equal(je.originEventId, ev.id);
    assert.deepEqual(await linesOf(je.id), ["6150 Dr300.00 Cr0.00", "2140 Dr0.00 Cr300.00 P"]);
    const tb = await trialBalance({ from: accountingDate(`${YEAR}-01-01`), to: TODAY, includeProvisional: false });
    assert.equal(tb.lines.length, 0, "provisional entries can be excluded from reports");
  });

  test("approvals are four-eyes: the preparer cannot approve the policy, the plan author cannot approve the plan", async () => {
    const w = await world();
    const d = await draftPolicy("commissions.recognition", {}, w.prep);
    await rejects(approvePolicy(d.id, w.prep), /someone else must approve/);
    await rejects(prisma.$executeRaw`UPDATE "AccountingPolicy" SET "status" = 'APPROVED', "approvedBy" = ${w.prep}, "approvedAt" = now() WHERE "id" = ${d.id}`, /other than its preparer/);
    await approvePolicy(d.id, w.appr);
    await rejects(prisma.$executeRaw`UPDATE "AccountingPolicy" SET "statement" = 'changed after approval, which must not be possible' WHERE "id" = ${d.id}`, /cannot be edited/);
    await rejects(approveCommissionPlanVersion(w.pv, w.salesAdmin), /someone else must approve/);
    await rejects(prisma.$executeRaw`UPDATE "CommissionPlanVersion" SET "accountingApproval" = 'APPROVED', "accountingApprovedBy" = ${w.salesAdmin}, "accountingApprovedAt" = now() WHERE "id" = ${w.pv}`, /other than its author/);
    await approveCommissionPlanVersion(w.pv, w.appr);
    await rejects(prisma.$executeRaw`UPDATE "CommissionPlanVersion" SET "accountingApproval" = 'PROVISIONAL' WHERE "id" = ${w.pv}`, /cannot be changed back/);
  });

  test("once approved, blocked events post for real (not provisional) on the next run", async () => {
    const w = await world();
    await movement(w.rep, "ACCRUAL", "300.00", w.pv);
    let run = await processPendingEvents();
    assert.equal(run.processed[0].status, "BLOCKED");
    await approveEverything(w);
    run = await processPendingEvents();
    assert.equal(run.processed[0].status, "TRANSLATED");
    assert.equal(run.processed[0].provisional, false);
    const je = await prisma.journalEntry.findFirstOrThrow();
    assert.equal(je.isProvisional, false);
    assert.equal(je.policyKey, "commissions.recognition");
    assert.equal(je.policyVersion, 1);
  });
});

describe("accounting effect", () => {
  test("accrual, adjustment, payout, then a return after payment: every movement once, and the payable reconciles per employee", async () => {
    const w = await world();
    await approveEverything(w);
    await movement(w.rep, "ACCRUAL", "500.00", w.pv);
    await movement(w.rep2, "ACCRUAL", "120.50", w.pv);
    await movement(w.rep, "ADJUSTMENT", "25.00", null);
    await movement(w.rep, "PAYOUT", "525.00", null);
    await movement(w.rep, "REVERSAL", "-200.00", w.pv); // the customer returned goods after the payout
    const run = await processPendingEvents();
    assert.deepEqual(run.processed.map((p) => p.status), ["TRANSLATED", "TRANSLATED", "TRANSLATED", "TRANSLATED", "TRANSLATED"]);
    const entries = await prisma.journalEntry.findMany({ orderBy: { entryNo: "asc" } });
    assert.deepEqual(await Promise.all(entries.map((e) => linesOf(e.id))), [
      ["6150 Dr500.00 Cr0.00", "2140 Dr0.00 Cr500.00 P"],
      ["6150 Dr120.50 Cr0.00", "2140 Dr0.00 Cr120.50 P"],
      ["6150 Dr25.00 Cr0.00", "2140 Dr0.00 Cr25.00 P"],
      ["2140 Dr525.00 Cr0.00 P", "2190 Dr0.00 Cr525.00"],
      ["2140 Dr200.00 Cr0.00 P", "6150 Dr0.00 Cr200.00"],
    ]);
    // Rep One: 500 + 25 − 525 − 200 = −200 (owes 200 back after the return). Rep Two: 120.50.
    const rec = await commissionReconciliation();
    const one = rec.rows.find((r) => r.employeeId === w.rep)!;
    const two = rec.rows.find((r) => r.employeeId === w.rep2)!;
    assert.equal(one.ledgerBalance, -20_000);
    assert.equal(one.subledgerPosted, -20_000);
    assert.equal(two.ledgerBalance, 12_050);
    assert.equal(rec.reconciled, true);
    assert.equal(rec.totals.ledgerBalance, -7_950);
    // Expense: 500 + 120.50 + 25 − 200 = 445.50.
    const tb = await trialBalance({ from: accountingDate(`${YEAR}-01-01`), to: TODAY });
    const exp = tb.lines.find((l) => l.code === "6150")!;
    assert.equal(exp.closingDebit, 44_550);
    assert.equal(tb.lines.find((l) => l.code === "2190")!.closingCredit, 52_500);
    assert.equal(tb.balanced, true);
  });

  test("replays and concurrent runs never post an event twice", async () => {
    const w = await world();
    await approveEverything(w);
    for (let i = 0; i < 6; i++) await movement(i % 2 ? w.rep : w.rep2, "ACCRUAL", `${10 + i}.00`, w.pv);
    await Promise.all([processPendingEvents(), processPendingEvents(), processPendingEvents()]);
    await processPendingEvents();
    assert.equal(await prisma.journalEntry.count(), 6);
    const ev = await prisma.accountingEvent.findFirstOrThrow();
    const again = await processEvent(ev.id);
    assert.equal(again.status, "TRANSLATED");
    assert.equal(await prisma.journalEntry.count(), 6);
    await rejects(prisma.$transaction(async (tx) => {
      const p = await tx.fiscalPeriod.findFirstOrThrow({ where: { startDate: { lte: TODAY }, endDate: { gte: TODAY } } });
      await tx.journalEntry.create({ data: { entryDate: TODAY, fiscalPeriodId: p.id, type: "AUTO", status: "DRAFT", originEventId: ev.id, createdBy: "t" } });
    }), /Unique constraint|already exists|originEventId/);
  });

  test("events for one person post in order: a blocked accrual holds the payout behind it", async () => {
    const w = await world();
    await approveEverything(w);
    const other = await prisma.commissionPlanVersion.create({ data: { planId: (await prisma.commissionPlan.findFirstOrThrow()).id, version: 2, baseRatePercent: new Prisma.Decimal("3"), effectiveFrom: new Date(`${YEAR}-06-01T00:00:00Z`), createdById: w.salesAdmin } });
    await movement(w.rep, "ACCRUAL", "100.00", other.id, new Date(Date.now() - 60_000)); // plan v2 not approved
    await movement(w.rep, "PAYOUT", "100.00", null);
    const run = await processPendingEvents();
    assert.deepEqual(run.processed.map((p) => p.status), ["BLOCKED", "BLOCKED"]);
    assert.match(run.processed[1].message!, /earlier event for the same party/);
    await approveCommissionPlanVersion(other.id, w.appr);
    const again = await processPendingEvents();
    assert.deepEqual(again.processed.map((p) => p.status), ["TRANSLATED", "TRANSLATED"]);
  });

  test("movements before the cutover are skipped (the opening balance carries them); an unmapped role or a locked period blocks", async () => {
    const w = await world();
    await approveEverything(w);
    await movement(w.rep, "ACCRUAL", "80.00", w.pv, new Date(`${YEAR - 1}-12-15T09:00:00Z`));
    let run = await processPendingEvents();
    assert.equal(run.processed[0].status, "SKIPPED");
    assert.match(run.processed[0].message!, /before the ledger cutover/);

    await prisma.accountMapping.delete({ where: { role: "COMMISSION_PAYMENT_CLEARING" } });
    await movement(w.rep2, "PAYOUT", "10.00", null);
    run = await processPendingEvents();
    assert.match(run.processed[0].message!, /No account is mapped for: COMMISSION_PAYMENT_CLEARING/);
    await setMapping("COMMISSION_PAYMENT_CLEARING", w.acc["2190"], w.prep);
    run = await processPendingEvents();
    assert.equal(run.processed[0].status, "TRANSLATED");

    const current = await prisma.fiscalPeriod.findFirstOrThrow({ where: { startDate: { lte: TODAY }, endDate: { gte: TODAY } } });
    await lockFiscalPeriod(current.id, w.appr);
    await movement(w.rep2, "ACCRUAL", "10.00", w.pv);
    run = await processPendingEvents();
    assert.equal(run.processed[0].status, "BLOCKED");
    assert.match(run.processed[0].message!, /is LOCKED/);
  });

  test("an automatic entry cannot be reversed by hand; the correction comes from the commission ledger", async () => {
    const w = await world();
    await approveEverything(w);
    await movement(w.rep, "ACCRUAL", "50.00", w.pv);
    await processPendingEvents();
    const je = await prisma.journalEntry.findFirstOrThrow();
    await rejects(requestJournalReversal(je.id, w.prep, "Wrong employee"), /correct it in that module/);
  });
});
