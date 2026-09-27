// Cash-flow statement (indirect method) against real PostgreSQL, with hand-worked expected
// figures. The classification used is the chart template's default, which is PROVISIONAL until
// the accountant approves it (DECISION_PACK: cash-flow classification); the identity checked here
// (operating + investing + financing = change in cash) holds for any classification.
// Run: npm run test:accounting:db
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, reset, makeUser, rejects } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear } from "../../../src/lib/accounting/fiscal-period-service";
import { createManualJournalEntry, submitJournalEntry, approveJournalEntry, postJournalEntry } from "../../../src/lib/accounting/journal-service";
import { updateAccount } from "../../../src/lib/accounting/account-service";
import { cashFlowStatement } from "../../../src/lib/accounting/cashflow";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const YEAR = Number(todayAccountingDate().toISOString().slice(0, 4));
const D = (md: string) => accountingDate(`${YEAR}-${md}`);

async function world() {
  const prep = await makeUser("Preparer");
  const appr = await makeUser("Approver");
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: D("01-01"), setupComplete: true }, prep);
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const post = async (md: string, lines: [string, string, string][], type: "MANUAL" | "OPENING" = "MANUAL") => {
    const e = await createManualJournalEntry({ type, entryDate: D(md), description: `cf ${md}`, lines: lines.map(([code, debit, credit]) => ({ accountId: acc[code], debit, credit })) }, prep);
    await submitJournalEntry(e.id, prep);
    await approveJournalEntry(e.id, appr);
    await postJournalEntry(e.id, appr);
  };
  await post("01-01", [["1120", "100000", "0"], ["3900", "0", "100000"]], "OPENING"); // opening balance, not a cash flow
  await post("02-01", [["1120", "50000", "0"], ["3100", "0", "50000"]]);             // capital injected   → financing +50,000
  await post("02-10", [["1210", "30000", "0"], ["1120", "0", "30000"]]);             // machine bought     → investing −30,000
  await post("03-01", [["1110", "20000", "0"], ["4100", "0", "20000"]]);             // cash sales         → profit +20,000
  await post("03-05", [["6200", "5000", "0"], ["2130", "0", "5000"]]);               // rent accrued       → profit −5,000, operating +5,000
  await post("03-10", [["6600", "1000", "0"], ["1290", "0", "1000"]]);               // depreciation       → profit −1,000, operating +1,000
  await post("03-15", [["1150", "2400", "0"], ["1120", "0", "2400"]]);               // prepaid rent       → operating −2,400
  return { prep, acc };
}

beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

test("statement for the year: hand-worked sections, opening entry treated as opening cash, identity holds", async () => {
  await world();
  const cf = await cashFlowStatement({ from: D("01-01"), to: D("12-31") });
  assert.equal(cf.netProfit, "14000.00");
  assert.equal(cf.operating.total, "17600.00", "14,000 + 5,000 + 1,000 − 2,400");
  assert.deepEqual(cf.operating.adjustments.map((l) => [l.kind, l.code, l.amount]),
    [["NON_CASH_PL", "6600", "1000.00"], ["WORKING_CAPITAL", "1150", "-2400.00"], ["WORKING_CAPITAL", "2130", "5000.00"]],
    "depreciation added back; prepaid rent and accrued rent as working capital");
  assert.equal(cf.operating.indirectTotal, cf.operating.total, "indirect method equals the cash allocated to operating");
  assert.equal(cf.investing.total, "-30000.00");
  assert.equal(cf.financing.total, "50000.00", "3900 opening equity is not a financing flow");
  assert.equal(cf.excluded.total, "0.00");
  assert.equal(cf.cashOpening, "100000.00");
  assert.equal(cf.netChange, "37600.00");
  assert.equal(cf.cashClosing, "137600.00");
  assert.equal(cf.reconciled, true);
  assert.deepEqual(cf.defaultedAccounts, [], "the template classifies every account it creates");
  const ledgerCash = await prisma.$queryRaw<{ s: string }[]>`SELECT SUM(l.debit - l.credit)::text s FROM "JournalEntryLine" l JOIN "Account" a ON a.id = l."accountId" WHERE a.code IN ('1110', '1120')`;
  assert.equal(Number(ledgerCash[0].s).toFixed(2), cf.cashClosing, "closing cash equals the ledger's cash balance");
});

test("a later start date moves earlier flows into opening cash", async () => {
  await world();
  const cf = await cashFlowStatement({ from: D("02-15"), to: D("12-31") });
  assert.equal(cf.cashOpening, "120000.00", "100,000 opening + 50,000 capital − 30,000 machine");
  assert.equal(cf.netChange, "17600.00");
  assert.equal(cf.investing.total, "0.00");
  assert.equal(cf.financing.total, "0.00");
  assert.equal(cf.reconciled, true);
});

test("classification: explicit change, default fallback listed, EXCLUDED breaks the check, bad value refused", async () => {
  const { prep, acc } = await world();
  await updateAccount(acc["2130"], { cashFlowClass: null }, prep);
  let cf = await cashFlowStatement({ from: D("01-01"), to: D("12-31") });
  assert.deepEqual(cf.defaultedAccounts, ["2130"]);
  assert.equal(cf.operating.adjustments.find((l) => l.code === "2130")?.defaulted, true);
  assert.equal(cf.reconciled, true);
  await updateAccount(acc["1150"], { cashFlowClass: "EXCLUDED" }, prep);
  cf = await cashFlowStatement({ from: D("01-01"), to: D("12-31") });
  assert.equal(cf.excluded.total, "-2400.00");
  assert.equal(cf.operating.total, "20000.00");
  assert.equal(cf.reconciled, false, "a non-zero excluded movement must be reviewed");
  await updateAccount(acc["1150"], { cashFlowClass: "INVESTING" }, prep);
  cf = await cashFlowStatement({ from: D("01-01"), to: D("12-31") });
  assert.equal(cf.investing.total, "-32400.00");
  assert.equal(cf.reconciled, true);
  await rejects(updateAccount(acc["1150"], { cashFlowClass: "BOGUS" }, prep), /Unknown cash-flow class/);
});
