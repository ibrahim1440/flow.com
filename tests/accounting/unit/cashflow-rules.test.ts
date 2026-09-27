// Template cash-flow classes (PROVISIONAL until the accountant approves them).
// Run: npm run test:accounting:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCashFlowClass } from "../../../src/lib/accounting/cashflow-rules";
import { COA_TEMPLATE } from "../../../src/lib/accounting/coa-template";

test("every postable balance-sheet template account gets a class; P&L accounts none", () => {
  for (const a of COA_TEMPLATE) {
    if ((a as { header?: boolean }).header) continue;
    const c = defaultCashFlowClass({ code: a.code, type: a.type, control: (a as { control?: string }).control });
    if (a.type === "REVENUE" || a.type === "EXPENSE") assert.equal(c, null, a.code);
    else assert.ok(c, a.code);
  }
});

test("specific defaults", () => {
  const c = (code: string, type: string, control?: string) => defaultCashFlowClass({ code, type, control });
  assert.equal(c("1110", "ASSET", "CASH"), "CASH");
  assert.equal(c("1120", "ASSET", "CASH"), "CASH");
  assert.equal(c("1130", "ASSET", "RECEIVABLE"), "OPERATING");
  assert.equal(c("1210", "ASSET"), "INVESTING");
  assert.equal(c("1290", "ASSET"), "INVESTING", "accumulated depreciation belongs with the fixed assets; depreciation is added back as a non-cash item");
  assert.equal(c("2195", "LIABILITY"), "INVESTING", "payables for fixed assets: paying them is an investing outflow");
  assert.equal(c("2220", "LIABILITY"), "FINANCING");
  assert.equal(c("2110", "LIABILITY", "PAYABLE"), "OPERATING");
  assert.equal(c("3100", "EQUITY"), "FINANCING");
  assert.equal(c("3200", "EQUITY"), "EXCLUDED");
  assert.equal(c("3900", "EQUITY"), "EXCLUDED");
  assert.equal(c("4100", "REVENUE"), null);
});
