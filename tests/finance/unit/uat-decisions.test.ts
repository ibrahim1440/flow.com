// Pure rules behind decisions D3b (profit explanation) and D4a (verified zero vs missing data).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rowCompleteness, unreconciledAccounts, type OpenLine } from "../../../src/lib/finance/completeness";
import { isProfitLike } from "../../../src/lib/finance/profit-hint";

const line = (amount: number, over: Partial<OpenLine> = {}): OpenLine => ({ amount, status: "CONFIRMED", reviewStatus: "NEEDS_REVIEW", finCategoryIds: [], ...over });

describe("D4a row completeness", () => {
  test("no indicators → verified zero", () => {
    assert.deepEqual(rowCompleteness({ kind: "PAYMENT", finCategoryId: "rent" }, [], []), { verified: true, unreviewed: 0, pending: 0, unreconciled: [] });
  });
  test("an unclassified receipt awaiting review affects receipt rows only", () => {
    const lines = [line(230000)];
    assert.equal(rowCompleteness({ kind: "RECEIPT", finCategoryId: "cafe" }, lines, []).verified, false);
    assert.equal(rowCompleteness({ kind: "RECEIPT", finCategoryId: "cafe" }, lines, []).unreviewed, 1);
    assert.equal(rowCompleteness({ kind: "PAYMENT", finCategoryId: "rent" }, lines, []).verified, true);
  });
  test("a line already classified to another category does not make this row incomplete", () => {
    const lines = [line(-45000, { finCategoryIds: ["util"] })];
    assert.equal(rowCompleteness({ kind: "PAYMENT", finCategoryId: "rent" }, lines, []).verified, true);
    assert.equal(rowCompleteness({ kind: "PAYMENT", finCategoryId: "util" }, lines, []).verified, false);
  });
  test("pending lines in the row's direction count, reviewed confirmed lines do not", () => {
    const lines = [line(-45000, { status: "PENDING", reviewStatus: "REVIEWED", finCategoryIds: ["util"] }), line(-10000, { reviewStatus: "REVIEWED", finCategoryIds: ["util"] })];
    const c = rowCompleteness({ kind: "PAYMENT", finCategoryId: "util" }, lines, []);
    assert.deepEqual([c.verified, c.pending, c.unreviewed], [false, 1, 0]);
  });
  test("an account not reconciled through the report date keeps every row unverified", () => {
    const unrec = unreconciledAccounts([{ id: "a", code: "SNB" }, { id: "b", code: "CASH" }], new Map([["a", "2026-09-26"], ["b", "2026-09-20"]]), "2026-09-26");
    assert.deepEqual(unrec, ["CASH"]);
    assert.equal(rowCompleteness({ kind: "PAYMENT", finCategoryId: "rent" }, [], unrec).verified, false);
    assert.deepEqual(unreconciledAccounts([{ id: "c", code: "NEW" }], new Map(), "2026-09-26"), ["NEW"], "never reconciled");
  });
});

describe("D3b profit-like categories", () => {
  for (const c of [{ nameEn: "Owner profit share" }, { nameAr: "حصة أرباح المالك" }, { code: "AL-PROFIT" }, { nameEn: "Dividends" }, { nameEn: "Partner draw" }, { nameAr: "توزيعات الشركاء" }, { nameAr: "مسحوبات المالك" }]) {
    test(`flags ${JSON.stringify(c)}`, () => assert.equal(isProfitLike(c), true));
  }
  for (const c of [{ nameEn: "Salaries", nameAr: "الرواتب" }, { nameEn: "Green coffee purchasing", code: "AL-GREEN" }, { nameEn: "VAT reserve" }, { nameEn: "Operating reserve", nameAr: "الاحتياطي التشغيلي" }]) {
    test(`does not flag ${JSON.stringify(c)}`, () => assert.equal(isProfitLike(c), false));
  }
});
