// Pure tests of the transaction-aware cash-flow engine (no database). Run: npm run test:accounting:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { allocate, buildCashFlow, type CfAccount } from "../../../src/lib/accounting/cashflow-engine";

const d = (s: string) => new Prisma.Decimal(s);
const A = (code: string, type: string, cls: CfAccount["cls"]): CfAccount => ({ id: code, code, nameAr: null, nameEn: code, type, cls, defaulted: false });
const accounts = new Map([
  A("1120", "ASSET", "CASH"), A("1210", "ASSET", "INVESTING"), A("1290", "ASSET", "INVESTING"), A("1150", "ASSET", "OPERATING"),
  A("2110", "LIABILITY", "OPERATING"), A("2195", "LIABILITY", "INVESTING"), A("2220", "LIABILITY", "FINANCING"), A("3100", "EQUITY", "FINANCING"),
  A("4100", "REVENUE", null), A("4800", "REVENUE", null), A("6200", "EXPENSE", null), A("6960", "EXPENSE", null),
].map((a) => [a.id, a]));
let n = 0;
const entry = (lines: [string, string, string][]) => ({ id: `e${++n}`, entryNo: n, entryDate: new Date(0), description: null, lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit: d(debit), credit: d(credit) })) });

test("allocate splits to the cent and always sums exactly", () => {
  for (const [cash, ws] of [["100.00", ["1", "1", "1"]], ["-0.01", ["3", "3"]], ["18000", ["15000", "3000"]], ["1234.57", ["0.33", "0.33", "0.34"]]] as [string, string[]][]) {
    const out = allocate(d(cash), ws.map(d));
    assert.equal(out.reduce((s, x) => s.add(x), d("0")).toFixed(2), d(cash).toFixed(2));
  }
});

test("partly-cash asset purchase: cash part investing, credit part disclosed", () => {
  const cf = buildCashFlow([entry([["1210", "100", "0"], ["1120", "0", "40"], ["2195", "0", "60"]])], accounts);
  assert.equal(cf.investing.total, "-40.00");
  assert.equal(cf.operating.total, "0.00");
  assert.deepEqual(cf.nonCash.map((x) => x.amount), ["60.00"]);
  assert.equal(cf.reconciled, true);
});

test("disposal at a gain: all proceeds investing, gain removed from profit", () => {
  const cf = buildCashFlow([entry([["1120", "18000", "0"], ["1210", "0", "15000"], ["4800", "0", "3000"]])], accounts);
  assert.equal(cf.investing.total, "18000.00");
  assert.equal(cf.netProfit, "3000.00");
  assert.equal(cf.operating.total, "0.00");
  assert.equal(cf.operating.indirectTotal, "0.00");
});

test("debt converted to equity is non-cash; nothing moves in any section", () => {
  const cf = buildCashFlow([entry([["2220", "5000", "0"], ["3100", "0", "5000"]])], accounts);
  assert.deepEqual([cf.operating.total, cf.investing.total, cf.financing.total], ["0.00", "0.00", "0.00"]);
  assert.deepEqual(cf.nonCash.map((x) => x.amount), ["5000.00"]);
});

test("ordinary operating entries give no non-cash disclosure and indirect = direct", () => {
  const cf = buildCashFlow([
    entry([["1150", "1000", "0"], ["4100", "0", "1000"]]),
    entry([["1120", "600", "0"], ["1150", "0", "600"]]),
    entry([["6200", "250", "0"], ["2110", "0", "250"]]),
  ], accounts);
  assert.equal(cf.operating.total, "600.00");
  assert.equal(cf.operating.indirectTotal, "600.00");
  assert.deepEqual(cf.nonCash, []);
});

test("an unbalanced classification is reported, not hidden: cash into an EXCLUDED account", () => {
  const acc = new Map(accounts); acc.set("3900", A("3900", "EQUITY", "EXCLUDED"));
  const cf = buildCashFlow([entry([["1120", "500", "0"], ["3900", "0", "500"]])], acc);
  assert.equal(cf.excluded.total, "500.00");
  assert.equal(cf.checks.excludedIsZero, false);
  assert.equal(cf.reconciled, false);
});
