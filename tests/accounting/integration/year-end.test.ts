// Stage 5 year-end close against real PostgreSQL. SYNTHETIC figures for the previous year Y:
//   revenue 4100 412,300.00 (150,000 on branch CAFE-SYN) · returns 4900 8,200 · COGS 5100 198,400
//   salaries 6100 96,000 · rent 6200 36,000 · depreciation 6600 21,600 (19,600 by hand + 2,000 from
//   the asset runs of Nov and Dec) → net income 52,100.00.
// Closing entry (CLOSING, dated Y-12-31, into the LOCKED period 12):
//   Dr 4100 262,300 · Dr 4100 [CAFE-SYN] 150,000 / Cr 4900 8,200 · Cr 5100 198,400 · Cr 6100 96,000
//   · Cr 6200 36,000 · Cr 6600 21,600 · Cr 3200 52,100.
// Run: npm run test:accounting:db
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, makeUser, rejects } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear, lockFiscalPeriod, unlockFiscalPeriod, closeFiscalPeriod, closeBlockers } from "../../../src/lib/accounting/fiscal-period-service";
import { draftPolicy, approvePolicy } from "../../../src/lib/accounting/policy-service";
import { processEvent, processPendingEvents } from "../../../src/lib/accounting/event-processor";
import { createManualJournalEntry, submitJournalEntry, approveJournalEntry, postJournalEntry } from "../../../src/lib/accounting/journal-service";
import { incomeStatement, balanceSheet } from "../../../src/lib/accounting/reports";
import * as FA from "../../../src/lib/accounting/fixed-assets-service";
import * as YE from "../../../src/lib/accounting/year-end-service";
import { createEngineEntry } from "../../../src/lib/accounting/posting";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const THIS = Number(todayAccountingDate().toISOString().slice(0, 4));
const Y = THIS - 1;
const D = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const dec = (s: string) => new Prisma.Decimal(s);
beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

async function world() {
  const prep = await makeUser("Chief accountant");
  const appr = await makeUser("Finance controller");
  const appr2 = await makeUser("CFO");
  await applyChartTemplate(prep);
  await createFiscalYear(Y, 1, prep);
  await createFiscalYear(THIS, 1, prep);
  await updateSettings({ ledgerCutoverDate: accountingDate(D(Y, 1, 1)), setupComplete: true }, prep);
  const p = await draftPolicy("fixed_assets.depreciation", {}, prep); await approvePolicy(p.id, appr);
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const cafe = (await prisma.finBranch.create({ data: { code: "CAFE-SYN", nameEn: "Café (synthetic)" } })).id;
  const je = async (date: string, lines: [string, string, string, string?][]) => {
    const e = await createManualJournalEntry({ entryDate: accountingDate(date), description: "SYNTHETIC", lines: lines.map(([code, debit, credit, branchId]) => ({ accountId: acc[code], debit, credit, branchId })) }, prep);
    await submitJournalEntry(e.id, prep); await approveJournalEntry(e.id, appr);
    return postJournalEntry(e.id, appr);
  };
  await je(D(Y, 1, 5), [["1120", "100000", "0"], ["3100", "0", "100000"]]);
  await je(D(Y, 6, 30), [["1120", "412300", "0"], ["4100", "0", "262300"], ["4100", "0", "150000", cafe]]);
  await je(D(Y, 7, 31), [["4900", "8200", "0"], ["1120", "0", "8200"]]);
  await je(D(Y, 8, 31), [["5100", "198400", "0"], ["6100", "96000", "0"], ["6200", "36000", "0"], ["1120", "0", "330400"]]);
  await je(D(Y, 10, 31), [["6600", "19600", "0"], ["1290", "0", "19600"]]);
  // An asset in service from Y-11 (12,000 over 12 months: 1,000 a month; SYNTHETIC class policy).
  const cls = await FA.createClass({ code: "EQ-SYN", name: "Equipment (synthetic)", costAccountId: acc["1220"], accumAccountId: acc["1290"], expenseAccountId: acc["6600"] }, prep);
  const pol = await FA.draftClassPolicy(cls.id, { method: "STRAIGHT_LINE", usefulLifeMonths: 12, residualPercent: "0", startConvention: "IN_SERVICE_MONTH", disposalConvention: "NONE" }, prep);
  await FA.approveClassPolicy(pol.id, appr);
  const a = await FA.saveAsset({ name: "Display fridge (synthetic)", classId: cls.id, inServiceDate: D(Y, 11, 1), sources: [{ kind: "ACCOUNT", counterAccountId: acc["2195"], amount: "12000" }] }, prep);
  await FA.submitAsset(a.id, prep); await FA.capitaliseAsset(a.id, appr);
  const periods = await prisma.fiscalPeriod.findMany({ where: { year: Y }, orderBy: { periodNo: "asc" } });
  return { prep, appr, appr2, acc, cafe, periods, je };
}
type W = Awaited<ReturnType<typeof world>>;
async function gl(w: W, code: string, asOf: string, branchId?: string | null) {
  const r = await prisma.journalEntryLine.aggregate({ where: { accountId: w.acc[code], ...(branchId !== undefined ? { branchId } : {}), journalEntry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { lte: accountingDate(asOf) } } }, _sum: { debit: true, credit: true } });
  return dec(String(r._sum.debit ?? 0)).sub(dec(String(r._sum.credit ?? 0))).toFixed(2);
}
async function closingJournal(closeId: string, et = "gl.year.closed") {
  const ev = await prisma.accountingEvent.findUniqueOrThrow({ where: { idempotencyKey: `closing:${closeId}:${et}:1` } });
  assert.equal(ev.status, "TRANSLATED", `${ev.status} ${ev.errorMessage ?? ""}`);
  const e = await prisma.journalEntry.findUniqueOrThrow({ where: { id: ev.journalEntryId! }, include: { lines: { include: { account: true } }, fiscalPeriod: true } });
  return { e, ev, lines: e.lines.map((l) => `${l.account.code}${l.branchId ? "@B" : ""}:${l.debit.toFixed(2)}:${l.credit.toFixed(2)}`).sort() };
}
const codes = (b: { blockers: { code: string }[] }) => b.blockers.map((x) => x.code).sort();
async function readyToClose(w: W) {
  const runs = [];
  for (const m of [11, 12]) { const r = await FA.createRun(w.periods[m - 1].id, w.prep); await FA.approveRun(r.id, w.appr); runs.push(r); }
  for (const p of w.periods) await lockFiscalPeriod(p.id, w.appr);
  return runs;
}

test("blockers, prepare, four-eyes, policy gate, closing entry into the locked period 12, statements before and after, next-year opening", async () => {
  const w = await world();
  const draft = await createManualJournalEntry({ entryDate: accountingDate(D(Y, 12, 15)), description: "SYNTHETIC unposted", lines: [{ accountId: w.acc["6200"], debit: "10", credit: "0" }, { accountId: w.acc["1120"], debit: "0", credit: "10" }] }, w.prep);
  assert.deepEqual(codes(await YE.yearEndBlockers(prisma, Y)), ["DEPRECIATION_MISSING", "PENDING_ENTRIES", "PERIODS_OPEN"]);
  assert.ok(codes(await YE.yearEndBlockers(prisma, THIS)).includes("NOT_ENDED"));
  assert.ok(codes(await YE.yearEndBlockers(prisma, THIS)).includes("NO_NEXT_YEAR"));
  await prisma.journalEntry.delete({ where: { id: draft.id } });
  await readyToClose(w);
  assert.deepEqual(codes(await YE.yearEndBlockers(prisma, Y)), []);

  const c = await YE.prepareYearEnd(Y, w.prep);
  assert.equal(c.netIncome.toFixed(2), "52100.00");
  assert.equal((c.snapshot as unknown[]).length, 7, "4100 twice (by branch), 4900, 5100, 6100, 6200, 6600");
  await rejects(YE.prepareYearEnd(Y, w.appr), /already draft/);
  // Period 12 cannot be closed while the year-end close is prepared but not posted.
  assert.ok((await closeBlockers(w.periods[11].id)).blockers.some((b) => b.code === "YEAR_END_PENDING"));
  await rejects(YE.approveYearEnd(c.id, w.prep), /someone else must approve/);
  await rejects(prisma.yearEndClose.update({ where: { id: c.id }, data: { status: "POSTED", approvedBy: w.prep } }), /approved by someone other than its preparer/);

  // No approved close policy yet: the close is approved but its journal waits (BLOCKED).
  const both = await Promise.allSettled([YE.approveYearEnd(c.id, w.appr), YE.approveYearEnd(c.id, w.appr2)]);
  assert.equal(both.filter((x) => x.status === "fulfilled").length, 1, "two approvers at once: one wins");
  const won = (both.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof YE.approveYearEnd>>>).value;
  assert.equal(won.ledger.status, "BLOCKED");
  assert.match(won.ledger.message ?? "", /closing.year_end/);
  const p = await draftPolicy("closing.year_end", {}, w.prep); await approvePolicy(p.id, w.appr);
  await processPendingEvents();
  const { e, ev, lines } = await closingJournal(c.id);
  assert.equal(e.type, "CLOSING");
  assert.equal(e.fiscalPeriod.periodNo, 12);
  assert.equal(e.fiscalPeriod.status, "LOCKED");
  assert.deepEqual(lines, ["3200:0.00:52100.00", "4100:262300.00:0.00", "4100@B:150000.00:0.00", "4900:0.00:8200.00", "5100:0.00:198400.00", "6100:0.00:96000.00", "6200:0.00:36000.00", "6600:0.00:21600.00"]);
  assert.equal((await processEvent(ev.id)).status, "TRANSLATED");
  assert.equal(await prisma.journalEntry.count({ where: { originEventId: ev.id } }), 1, "a retry never posts twice");

  // Statements: the income statement for Y is unchanged; the balance sheet shows the earnings in 3200.
  const is = await incomeStatement({ from: accountingDate(D(Y, 1, 1)), to: accountingDate(D(Y, 12, 31)) });
  assert.equal(is.netIncome, 5210000);
  const bs = await balanceSheet({ asOf: accountingDate(D(Y, 12, 31)) });
  assert.equal(bs.currentEarnings, 0);
  assert.ok(bs.balanced);
  assert.equal(await gl(w, "3200", D(Y, 12, 31)), "-52100.00");
  assert.equal(await gl(w, "4100", D(Y, 12, 31), w.cafe), "0.00", "branch revenue closed too");
  // Next year opens with every revenue and expense account at zero; balance sheet carried as it is.
  const open = await YE.openingBalancesAfter(Y);
  assert.equal(open.profitAndLossNotClosed, 0);
  assert.ok(open.balanced);
  assert.equal(open.lines.find((l) => l.code === "1120")?.net, "173700.00");
  assert.equal(open.lines.find((l) => l.code === "3200")?.net, "-52100.00");

  // Nothing else posts into the closed year; a CLOSING entry never posts into an open period.
  await rejects(createManualJournalEntry({ entryDate: accountingDate(D(Y, 6, 1)), description: "late", lines: [{ accountId: w.acc["6200"], debit: "1", credit: "0" }, { accountId: w.acc["1120"], debit: "0", credit: "1" }] }, w.prep), /LOCKED|locked/);
  await rejects(prisma.$transaction((tx) => createEngineEntry(tx, { entryDate: accountingDate(D(THIS, 1, 31)), description: "x", sourceModule: "test", sourceDocumentId: "x", originEventId: ev.id + "x", lines: [{ accountId: w.acc["4100"], debit: dec("1") }, { accountId: w.acc["3200"], credit: dec("1") }], mode: { provisional: false, policyKey: "closing.year_end", policyVersion: 1, reasons: [] }, entryType: "CLOSING" })), /closing entry posts only into a locked period/);

  // Close the periods: the close is then final.
  for (const per of w.periods) await closeFiscalPeriod(per.id, w.appr);
  await rejects(YE.requestYearReopen(c.id, w.prep, "SYNTHETIC: too late"), /CLOSED; the close is final/);
});

test("figures changed after preparing refuse the approval; reopening (four-eyes) restores the P&L; closing again posts once more", async () => {
  const w = await world();
  const p = await draftPolicy("closing.year_end", {}, w.prep); await approvePolicy(p.id, w.appr);
  await readyToClose(w);
  const c = await YE.prepareYearEnd(Y, w.prep);
  await unlockFiscalPeriod(w.periods[11].id, w.appr, "SYNTHETIC: late accrual");
  await w.je(D(Y, 12, 31), [["6200", "3000", "0"], ["2130", "0", "3000"]]);
  await lockFiscalPeriod(w.periods[11].id, w.appr);
  await rejects(YE.approveYearEnd(c.id, w.appr), /figures changed since the close was prepared/);
  await YE.cancelYearEnd(c.id, w.prep);
  const c2 = await YE.prepareYearEnd(Y, w.prep);
  assert.equal(c2.netIncome.toFixed(2), "49100.00");
  const r = await YE.approveYearEnd(c2.id, w.appr);
  assert.equal(r.ledger.status, "TRANSLATED");
  assert.equal(await gl(w, "3200", D(Y, 12, 31)), "-49100.00");
  assert.equal(await gl(w, "6200", D(Y, 12, 31)), "0.00");

  await YE.requestYearReopen(c2.id, w.prep, "SYNTHETIC: audit adjustment expected");
  assert.ok((await closeBlockers(w.periods[11].id)).blockers.some((b) => b.code === "YEAR_END_PENDING"));
  await rejects(YE.decideYearReopen(c2.id, w.prep, true), /someone else must decide/);
  const ro = await YE.decideYearReopen(c2.id, w.appr, true);
  assert.equal(ro.ledger?.status, "TRANSLATED");
  const { e } = await closingJournal(c2.id, "gl.year.reopened");
  assert.equal(e.type, "CLOSING", "the reversal is also a closing entry, so the income statement stays right");
  assert.equal(await gl(w, "3200", D(Y, 12, 31)), "0.00");
  assert.equal(await gl(w, "6200", D(Y, 12, 31)), "39000.00");
  const is = await incomeStatement({ from: accountingDate(D(Y, 1, 1)), to: accountingDate(D(Y, 12, 31)) });
  assert.equal(is.netIncome, 4910000);
  const bs = await balanceSheet({ asOf: accountingDate(D(Y, 12, 31)) });
  assert.equal(bs.currentEarnings, 4910000, "reopened: the year's result is current earnings again");

  const c3 = await YE.prepareYearEnd(Y, w.prep);
  await YE.approveYearEnd(c3.id, w.appr2);
  assert.equal(await gl(w, "3200", D(Y, 12, 31)), "-49100.00");
  assert.equal(await prisma.yearEndClose.count({ where: { year: Y, status: "POSTED" } }), 1);
});
