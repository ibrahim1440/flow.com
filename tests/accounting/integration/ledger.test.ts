// General ledger: set-up, manual journal workflow, database guards, reversal, periods,
// concurrency and reports. Expected figures are written out by hand in each test, never read
// back from the code under test. Run: npm run test:accounting:db
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, reset, makeUser, rejects } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear, lockFiscalPeriod, unlockFiscalPeriod, closeFiscalPeriod } from "../../../src/lib/accounting/fiscal-period-service";
import {
  createManualJournalEntry, submitJournalEntry, approveJournalEntry, postJournalEntry, rejectJournalEntry,
  requestJournalReversal, deleteDraftJournalEntry, updateDraftJournalEntry,
} from "../../../src/lib/accounting/journal-service";
import { trialBalance, incomeStatement, balanceSheet, generalLedger } from "../../../src/lib/accounting/reports";
import { COA_TEMPLATE, TEMPLATE_MAPPINGS } from "../../../src/lib/accounting/coa-template";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const YEAR = Number(todayAccountingDate().toISOString().slice(0, 4));
const D = (md: string) => accountingDate(`${YEAR}-${md}`);

async function ledger() {
  const prep = await makeUser("Preparer");
  const appr = await makeUser("Approver");
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: D("01-01"), setupComplete: true }, prep);
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  return { prep, appr, acc };
}

async function postManual(c: Awaited<ReturnType<typeof ledger>>, date: string, lines: [string, string, string][], description = "Test") {
  const e = await createManualJournalEntry({ entryDate: D(date), description, lines: lines.map(([code, debit, credit]) => ({ accountId: c.acc[code], debit, credit })) }, c.prep);
  await submitJournalEntry(e.id, c.prep);
  await approveJournalEntry(e.id, c.appr);
  return postJournalEntry(e.id, c.appr);
}

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

describe("set-up", () => {
  test("template loads once, into an empty chart, with control accounts closed to manual posting", async () => {
    const prep = await makeUser("Preparer");
    await applyChartTemplate(prep);
    assert.equal(await prisma.account.count(), COA_TEMPLATE.length);
    const ap = await prisma.account.findUniqueOrThrow({ where: { code: "2140" } });
    assert.equal(ap.controlKind, "COMMISSION_PAYABLE");
    assert.equal(ap.allowManualPosting, false);
    const header = await prisma.account.findUniqueOrThrow({ where: { code: "11" } });
    assert.equal(header.allowPosting, false);
    assert.equal(await prisma.accountMapping.count(), Object.keys(TEMPLATE_MAPPINGS).length);
    await rejects(applyChartTemplate(prep), /already has/);
  });

  test("a fiscal year is twelve months with no overlap; a second overlapping year is refused by the database", async () => {
    const prep = await makeUser("Preparer");
    const ps = await createFiscalYear(YEAR, 1, prep);
    assert.equal(ps.length, 12);
    assert.equal(ps[1].startDate.toISOString().slice(0, 10), `${YEAR}-02-01`);
    assert.equal(ps[1].endDate.toISOString().slice(0, 10), `${YEAR}-02-${YEAR % 4 === 0 ? "29" : "28"}`);
    await rejects(prisma.fiscalPeriod.create({ data: { year: YEAR + 50, periodNo: 1, startDate: D("06-15"), endDate: D("07-15") } }), /FiscalPeriod_no_overlap|exclusion|conflicting/i);
  });

  test("nothing posts before set-up is complete", async () => {
    const prep = await makeUser("Preparer");
    await applyChartTemplate(prep);
    await createFiscalYear(YEAR, 1, prep);
    const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
    await rejects(createManualJournalEntry({ entryDate: D("03-01"), lines: [{ accountId: acc["6200"], debit: "10", credit: "0" }, { accountId: acc["1120"], debit: "0", credit: "10" }] }, prep), /setup is not complete/i);
  });
});

describe("manual journals", () => {
  test("draft → submit → approve (by another person) → post, and the trial balance shows it", async () => {
    const c = await ledger();
    const e = await createManualJournalEntry({ entryDate: D("03-05"), description: "March rent", lines: [
      { accountId: c.acc["6200"], debit: "12,500.00", credit: "0" },
      { accountId: c.acc["1120"], debit: "0", credit: "12500" },
    ] }, c.prep);
    assert.equal(e.status, "DRAFT");
    await rejects(approveJournalEntry(e.id, c.appr), /cannot move to APPROVED/);
    await submitJournalEntry(e.id, c.prep);
    await rejects(approveJournalEntry(e.id, c.prep), /someone else must approve/);
    await approveJournalEntry(e.id, c.appr);
    const posted = await postJournalEntry(e.id, c.appr);
    assert.equal(posted.status, "POSTED");

    const tb = await trialBalance({ from: D("03-01"), to: D("03-31") });
    assert.equal(tb.balanced, true);
    const rent = tb.lines.find((l) => l.code === "6200")!;
    const bank = tb.lines.find((l) => l.code === "1120")!;
    assert.equal(rent.periodDebit, 1_250_000);
    assert.equal(rent.closingDebit, 1_250_000);
    assert.equal(bank.closingCredit, 1_250_000);
    assert.equal(tb.totals.closingDebit, 1_250_000);
    assert.equal(tb.totals.closingCredit, 1_250_000);
    const audit = await prisma.finAuditLog.findMany({ where: { entityType: "accounting.journal", entityId: e.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(audit.map((a) => a.action), ["journal.create", "journal.submit", "journal.approve", "journal.post"]);
  });

  test("refusals: unbalanced, a third decimal, a parent account, a control account, one line", async () => {
    const c = await ledger();
    const two = (a: string, d: string, b: string, cr: string) => [{ accountId: c.acc[a], debit: d, credit: "0" }, { accountId: c.acc[b], debit: "0", credit: cr }];
    await rejects(createManualJournalEntry({ entryDate: D("03-05"), lines: two("6200", "100", "1120", "99.99") }, c.prep), /must equal credits/);
    await rejects(createManualJournalEntry({ entryDate: D("03-05"), lines: two("6200", "100.005", "1120", "100.005") }, c.prep), /at most two decimals/);
    await rejects(createManualJournalEntry({ entryDate: D("03-05"), lines: two("11", "100", "1120", "100") }, c.prep), /parent account|does not allow posting/);
    await rejects(createManualJournalEntry({ entryDate: D("03-05"), lines: two("6150", "100", "2140", "100") }, c.prep), /control account/);
    await rejects(createManualJournalEntry({ entryDate: D("03-05"), lines: [{ accountId: c.acc["6200"], debit: "1", credit: "0" }] }, c.prep), /at least two lines/);
    await rejects(createManualJournalEntry({ entryDate: D("03-05"), lines: [{ accountId: c.acc["6200"], debit: "1", credit: "1" }, { accountId: c.acc["1120"], debit: "0", credit: "0" }] }, c.prep), /exactly one of debit or credit/);
    assert.equal(await prisma.journalEntry.count(), 0);
  });

  test("rejection returns the entry to draft with the reason; it can be edited, resubmitted and posted", async () => {
    const c = await ledger();
    const e = await createManualJournalEntry({ entryDate: D("04-02"), lines: [{ accountId: c.acc["6300"], debit: "800", credit: "0" }, { accountId: c.acc["1110"], debit: "0", credit: "800" }] }, c.prep);
    await submitJournalEntry(e.id, c.prep);
    await rejects(rejectJournalEntry(e.id, c.appr, "no"), /reason/);
    const r = await rejectJournalEntry(e.id, c.appr, "Wrong cash account");
    assert.equal(r.status, "DRAFT");
    assert.equal(r.rejectionReason, "Wrong cash account");
    await updateDraftJournalEntry(e.id, { entryDate: D("04-02"), lines: [{ accountId: c.acc["6300"], debit: "800", credit: "0" }, { accountId: c.acc["1120"], debit: "0", credit: "800" }] }, c.prep);
    await submitJournalEntry(e.id, c.prep);
    await approveJournalEntry(e.id, c.appr);
    await postJournalEntry(e.id, c.appr);
    const lines = await prisma.journalEntryLine.findMany({ where: { journalEntryId: e.id }, include: { account: true } });
    assert.deepEqual(lines.map((l) => l.account.code).sort(), ["1120", "6300"]);
  });

  test("only drafts can be discarded", async () => {
    const c = await ledger();
    const posted = await postManual(c, "03-10", [["6400", "50", "0"], ["1120", "0", "50"]]);
    await rejects(deleteDraftJournalEntry(posted.id, c.prep), /Only a draft/);
    const d = await createManualJournalEntry({ entryDate: D("03-10"), lines: [{ accountId: c.acc["6400"], debit: "5", credit: "0" }, { accountId: c.acc["1120"], debit: "0", credit: "5" }] }, c.prep);
    await deleteDraftJournalEntry(d.id, c.prep);
    assert.equal(await prisma.journalEntry.count(), 1);
  });
});

describe("database guards (any writer, not just the service)", () => {
  test("a posted entry and its lines cannot be edited or deleted; a draft cannot be inserted as posted", async () => {
    const c = await ledger();
    const e = await postManual(c, "03-05", [["6200", "1000", "0"], ["1120", "0", "1000"]]);
    await rejects(prisma.$executeRaw`UPDATE "JournalEntry" SET "description" = 'edited' WHERE "id" = ${e.id}`, /cannot be changed/);
    await rejects(prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "id" = ${e.id}`, /Only a draft/);
    await rejects(prisma.$executeRaw`UPDATE "JournalEntryLine" SET "debit" = 999 WHERE "journalEntryId" = ${e.id} AND "debit" > 0`, /cannot be changed/);
    await rejects(prisma.$executeRaw`DELETE FROM "JournalEntryLine" WHERE "journalEntryId" = ${e.id}`, /cannot be changed/);
    await rejects(prisma.$executeRaw`UPDATE "JournalEntry" SET "status" = 'REVERSED' WHERE "id" = ${e.id}`, /posted reversal/);
    const period = await prisma.fiscalPeriod.findFirstOrThrow({ where: { periodNo: 3 } });
    await rejects(prisma.$executeRaw`INSERT INTO "JournalEntry" ("id","entryDate","fiscalPeriodId","type","status","updatedAt","createdBy") VALUES ('x1', ${D("03-06")}, ${period.id}, 'MANUAL', 'POSTED', now(), ${c.prep})`, /created as a draft/);
    await rejects(prisma.$executeRaw`INSERT INTO "JournalEntry" ("id","entryDate","fiscalPeriodId","type","status","updatedAt","createdBy") VALUES ('x2', ${D("03-06")}, ${period.id}, 'MANUAL', 'APPROVED', now(), ${c.prep})`, /second person/);
  });

  test("self-approval and an unbalanced posting are refused by the database", async () => {
    const c = await ledger();
    const e = await createManualJournalEntry({ entryDate: D("03-05"), lines: [{ accountId: c.acc["6200"], debit: "10", credit: "0" }, { accountId: c.acc["1120"], debit: "0", credit: "10" }] }, c.prep);
    await submitJournalEntry(e.id, c.prep);
    await rejects(prisma.$executeRaw`UPDATE "JournalEntry" SET "status" = 'APPROVED', "approvedBy" = ${c.prep}, "approvedAt" = now() WHERE "id" = ${e.id}`, /other than its preparer/);
    // Break the balance while it is a draft (allowed), then force it through to POSTED in one transaction.
    await prisma.$executeRaw`UPDATE "JournalEntry" SET "status" = 'DRAFT' WHERE "id" = ${e.id}`;
    await prisma.$executeRaw`UPDATE "JournalEntryLine" SET "debit" = 11 WHERE "journalEntryId" = ${e.id} AND "debit" > 0`;
    await rejects(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "JournalEntry" SET "status" = 'SUBMITTED', "submittedBy" = ${c.prep} WHERE "id" = ${e.id}`;
      await tx.$executeRaw`UPDATE "JournalEntry" SET "status" = 'APPROVED', "approvedBy" = ${c.appr}, "approvedAt" = now() WHERE "id" = ${e.id}`;
      await tx.$executeRaw`UPDATE "JournalEntry" SET "status" = 'POSTED', "postedBy" = ${c.appr}, "postedAt" = now() WHERE "id" = ${e.id}`;
    }), /not balanced/);
    assert.equal((await prisma.journalEntry.findUniqueOrThrow({ where: { id: e.id } })).status, "DRAFT");
  });

  test("an account with postings cannot change type or become a parent", async () => {
    const c = await ledger();
    await postManual(c, "03-05", [["6200", "10", "0"], ["1120", "0", "10"]]);
    await rejects(prisma.account.update({ where: { code: "6200" }, data: { type: "ASSET" } }), /type cannot change/);
    await rejects(prisma.account.create({ data: { code: "6201", nameEn: "Sub", type: "EXPENSE", parentId: c.acc["6200"] } }), /cannot become a parent/);
  });

  test("provisional entries are refused in a database without the disposable marker", async () => {
    const c = await ledger();
    const period = await prisma.fiscalPeriod.findFirstOrThrow({ where: { periodNo: 3 } });
    await prisma.$executeRawUnsafe(`COMMENT ON DATABASE erp_finance_integration IS 'not-disposable-during-test'`);
    try {
      await rejects(prisma.$executeRaw`INSERT INTO "JournalEntry" ("id","entryDate","fiscalPeriodId","type","status","updatedAt","createdBy","isProvisional") VALUES ('p1', ${D("03-06")}, ${period.id}, 'AUTO', 'DRAFT', now(), ${c.prep}, true)`, /isolated test database/);
    } finally {
      await prisma.$executeRawUnsafe(`COMMENT ON DATABASE erp_finance_integration IS 'hiqbah-finance-disposable'`);
    }
  });
});

describe("reversal", () => {
  test("a reversal is requested, approved by someone else, posted; the original becomes REVERSED and the accounts net to zero", async () => {
    const c = await ledger();
    const e = await postManual(c, "05-03", [["6700", "2300", "0"], ["1120", "0", "2300"]]);
    await rejects(requestJournalReversal(e.id, c.prep, "x"), /reason/);
    await rejects(requestJournalReversal(e.id, c.prep, "Invoice was cancelled", D("05-01")), /before the entry/);
    const rv = await requestJournalReversal(e.id, c.prep, "Invoice was cancelled", D("05-20"));
    assert.equal(rv.status, "SUBMITTED");
    await rejects(requestJournalReversal(e.id, c.prep, "Twice please"), /already has a reversal/);
    await rejects(approveJournalEntry(rv.id, c.prep), /someone else/);
    await approveJournalEntry(rv.id, c.appr);
    await postJournalEntry(rv.id, c.appr);
    assert.equal((await prisma.journalEntry.findUniqueOrThrow({ where: { id: e.id } })).status, "REVERSED");
    const tb = await trialBalance({ from: D("05-01"), to: D("05-31") });
    const m = tb.lines.find((l) => l.code === "6700")!;
    assert.equal(m.periodDebit, 230_000);
    assert.equal(m.periodCredit, 230_000);
    assert.equal(m.closingDebit + m.closingCredit, 0);
    const gl = await generalLedger({ accountId: c.acc["6700"], from: D("05-01"), to: D("05-31") });
    assert.deepEqual(gl!.lines.map((l) => l.balance), [230_000, 0]);
  });
});

describe("periods", () => {
  test("locked periods refuse entries and postings; unlock needs a reason; close needs earlier periods closed and nothing pending", async () => {
    const c = await ledger();
    const p = (n: number) => prisma.fiscalPeriod.findFirstOrThrow({ where: { periodNo: n } });
    const approved = await createManualJournalEntry({ entryDate: D("02-10"), lines: [{ accountId: c.acc["6200"], debit: "10", credit: "0" }, { accountId: c.acc["1120"], debit: "0", credit: "10" }] }, c.prep);
    await submitJournalEntry(approved.id, c.prep);
    await approveJournalEntry(approved.id, c.appr);
    await lockFiscalPeriod((await p(2)).id, c.appr);
    await rejects(postJournalEntry(approved.id, c.appr), /LOCKED/);
    await rejects(createManualJournalEntry({ entryDate: D("02-11"), lines: [{ accountId: c.acc["6200"], debit: "1", credit: "0" }, { accountId: c.acc["1120"], debit: "0", credit: "1" }] }, c.prep), /LOCKED/);
    await rejects(prisma.$executeRaw`UPDATE "JournalEntry" SET "status" = 'POSTED', "postedBy" = ${c.appr}, "postedAt" = now() WHERE "id" = ${approved.id}`, /LOCKED; nothing can post/);
    await rejects(closeFiscalPeriod((await p(2)).id, c.appr), /earlier periods are not closed|still draft/);
    await lockFiscalPeriod((await p(1)).id, c.appr);
    await closeFiscalPeriod((await p(1)).id, c.appr);
    await rejects(closeFiscalPeriod((await p(2)).id, c.appr), /still draft, submitted or approved/);
    await rejects(unlockFiscalPeriod((await p(2)).id, c.appr, ""), /reason/);
    await unlockFiscalPeriod((await p(2)).id, c.appr, "Post the approved rent entry");
    await postJournalEntry(approved.id, c.appr);
    await lockFiscalPeriod((await p(2)).id, c.appr);
    const closed = await closeFiscalPeriod((await p(2)).id, c.appr);
    assert.equal(closed.status, "CLOSED");
    await rejects(unlockFiscalPeriod(closed.id, c.appr, "Reopen it please"), /closed period cannot be reopened|Only a locked/);
    await rejects(prisma.$executeRaw`UPDATE "FiscalPeriod" SET "status" = 'OPEN' WHERE "id" = ${closed.id}`, /cannot move from CLOSED/);
  });
});

describe("concurrency", () => {
  test("two simultaneous approvals and two simultaneous posts produce one of each", async () => {
    const c = await ledger();
    const other = await makeUser("Second approver");
    const e = await createManualJournalEntry({ entryDate: D("06-01"), lines: [{ accountId: c.acc["6200"], debit: "700", credit: "0" }, { accountId: c.acc["1120"], debit: "0", credit: "700" }] }, c.prep);
    await submitJournalEntry(e.id, c.prep);
    const a = await Promise.allSettled([approveJournalEntry(e.id, c.appr), approveJournalEntry(e.id, other)]);
    assert.equal(a.filter((r) => r.status === "fulfilled").length, 1);
    const p = await Promise.allSettled([postJournalEntry(e.id, c.appr), postJournalEntry(e.id, other)]);
    assert.equal(p.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await prisma.finAuditLog.count({ where: { action: "journal.post", entityId: e.id } }), 1);
    const tb = await trialBalance({ from: D("06-01"), to: D("06-30") });
    assert.equal(tb.lines.find((l) => l.code === "6200")!.periodDebit, 70_000);
  });
});

describe("statements", () => {
  test("income statement and balance sheet agree with each other and with the trial balance", async () => {
    const c = await ledger();
    // Independently: capital 100,000; revenue 30,000; COGS 12,000; rent 5,000 → net income 13,000.
    await postManual(c, "01-02", [["1120", "100000", "0"], ["3100", "0", "100000"]]);
    await postManual(c, "01-15", [["1120", "30000", "0"], ["4100", "0", "30000"]]);
    // (Inventory is a control account, so the synthetic cost is paid from cash here.)
    await postManual(c, "01-15", [["5100", "12000", "0"], ["1110", "0", "12000"]]);
    await postManual(c, "01-31", [["6200", "5000", "0"], ["1120", "0", "5000"]]);
    const is = await incomeStatement({ from: D("01-01"), to: D("01-31") });
    assert.equal(is.totalRevenue, 3_000_000);
    assert.equal(is.totalExpenses, 1_700_000);
    assert.equal(is.netIncome, 1_300_000);
    const bs = await balanceSheet({ asOf: D("01-31") });
    // Assets: bank 100,000 + 30,000 − 5,000 = 125,000; cash −12,000 → 113,000.
    assert.equal(bs.totalAssets, 11_300_000);
    assert.equal(bs.totalLiabilities, 0);
    assert.equal(bs.currentEarnings, 1_300_000);
    assert.equal(bs.totalEquity, 11_300_000);
    assert.equal(bs.balanced, true);
    const tb = await trialBalance({ from: D("01-01"), to: D("01-31") });
    assert.equal(tb.balanced, true);
    assert.equal(tb.totals.periodDebit, 14_700_000);
  });
});
