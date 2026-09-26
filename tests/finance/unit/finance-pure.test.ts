// Pure finance logic. No database. Run: npm run test:finance:unit
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fromMinor, parseMoney, splitByWeights, toMinor, parsePercentScaled, formatSAR } from "../../../src/lib/finance/money";
import { computeAllocation, validateRuleSteps, fundingNeed, AllocationRefused, type CategoryState, type RuleStep } from "../../../src/lib/finance/allocation-engine";
import { computeVariance, aggregateVariance, crossesThreshold, forecastAtCompletion } from "../../../src/lib/finance/variance";
import { plannedThrough } from "../../../src/lib/finance/phasing";
import { runForecast } from "../../../src/lib/finance/forecast";
import { fingerprintRows, mapRows, parseCsv } from "../../../src/lib/finance/csv";

const cat = (id: string, over: Partial<CategoryState> = {}): CategoryState => ({
  id, code: id, priority: 100, fundingType: "OPEN", targetAmount: null, replenish: false, isTaxReserve: false, active: true,
  balance: 0, fundedThisMonth: 0, fundedEver: 0, obligationsRemaining: 0, ...over,
});
const pct = (seq: number, categoryId: string, p: string): RuleStep => ({ seq, method: "PERCENT_OF_BASE", categoryId, percentScaled: parsePercentScaled(p) });

describe("money", () => {
  test("parses and formats without floating point", () => {
    assert.equal(parseMoney("10,000.00"), 1_000_000);
    assert.equal(parseMoney("(45.5)"), -4550);
    assert.equal(parseMoney("١٢٣٫٤٥"), 12345);
    assert.equal(parseMoney("0.105"), null, "a third decimal is refused, not rounded");
    assert.equal(parseMoney("1,00"), null, "misplaced thousands separator");
    assert.equal(fromMinor(-123456), "-1234.56");
    assert.equal(toMinor("6500.00"), 650000);
    assert.equal(parseMoney(0.1 + 0.2), 30, "a JSON number exact to the halala is accepted");
    assert.equal(parseMoney(0.105), null, "a number with a real third decimal is refused");
    assert.match(formatSAR(650000, "en"), /SAR 6,500\.00/);
  });

  test("splitByWeights always sums exactly and is deterministic", () => {
    for (const total of [1, 7, 100, 999_999, 1_000_001]) {
      const parts = splitByWeights(total, [1, 1, 1]);
      assert.equal(parts.reduce((a, b) => a + b, 0), total);
      assert.deepEqual(parts, splitByWeights(total, [1, 1, 1]));
    }
    assert.deepEqual(splitByWeights(100, [1, 1, 1]), [34, 33, 33]);
  });
});

describe("allocation engine", () => {
  test("ACCEPTANCE 1 — SAR 10,000 at 65/5/18/7/5% is exactly 6,500 / 500 / 1,800 / 700 / 500", () => {
    const cats = ["A", "B", "C", "D", "E"].map((c) => cat(c));
    const steps = [pct(1, "A", "65"), pct(2, "B", "5"), pct(3, "C", "18"), pct(4, "D", "7"), pct(5, "E", "5")];
    assert.ok(validateRuleSteps(steps, cats).ok);
    const r = computeAllocation({ receiptUnallocated: 1_000_000, taxComponent: 0, poolUnallocated: 1_000_000, month: "2026-09", steps, categories: cats });
    assert.deepEqual(r.lines.map((l) => [l.categoryId, l.amount]), [["A", 650000], ["B", 50000], ["C", 180000], ["D", 70000], ["E", 50000]]);
    assert.equal(r.allocatedTotal, 1_000_000);
    assert.equal(r.leftUnallocated, 0);
  });

  test("odd amounts still allocate to the halala with no drift", () => {
    const cats = ["A", "B", "C"].map((c) => cat(c));
    const steps = [pct(1, "A", "33.3333"), pct(2, "B", "33.3333"), pct(3, "C", "33.3334")];
    const r = computeAllocation({ receiptUnallocated: 100_01, taxComponent: 0, poolUnallocated: 1e9, month: "2026-09", steps, categories: cats });
    assert.equal(r.allocatedTotal, 100_01);
  });

  test("percentages above 100% and flat-percent tax reserves are refused", () => {
    const cats = [cat("A"), cat("T", { isTaxReserve: true })];
    assert.equal(validateRuleSteps([pct(1, "A", "80"), pct(2, "A", "30")], cats).ok, false);
    const v = validateRuleSteps([pct(1, "T", "15")], cats);
    assert.equal(v.ok, false);
    assert.match(v.errors.join(" "), /tax reserve cannot be funded with a flat percentage/);
  });

  test("execution order is fixed: VAT, percentages on one base, obligations, targets, remainder", () => {
    const cats = [cat("VAT", { isTaxReserve: true }), cat("GREEN"), cat("RENT", { obligationsRemaining: 100_000 }), cat("SAL", { fundingType: "MONTHLY_TARGET", targetAmount: 200_000 }), cat("R1"), cat("R2")];
    const steps: RuleStep[] = [
      { seq: 1, method: "WEIGHTED_REMAINDER", categoryId: "R1", weight: 3 },
      { seq: 2, method: "WEIGHTED_REMAINDER", categoryId: "R2", weight: 1 },
      { seq: 3, method: "FILL_TARGET", categoryId: "SAL" },
      { seq: 4, method: "FUND_OBLIGATIONS", categoryId: "RENT" },
      pct(5, "GREEN", "50"),
      { seq: 6, method: "RECEIPT_TAX_COMPONENT", categoryId: "VAT" },
    ];
    const r = computeAllocation({ receiptUnallocated: 1_150_000, taxComponent: 150_000, poolUnallocated: 1e9, month: "2026-09", steps, categories: cats });
    const got = Object.fromEntries(r.lines.map((l) => [l.categoryId, l.amount]));
    assert.equal(r.base, 1_000_000, "base = receipt − VAT");
    assert.equal(got.VAT, 150_000);
    assert.equal(got.GREEN, 500_000, "50% of the base, not of a running remainder");
    assert.equal(got.RENT, 100_000);
    assert.equal(got.SAL, 200_000);
    assert.equal(got.R1 + got.R2, 200_000);
    assert.equal(got.R1, 150_000);
    assert.equal(r.leftUnallocated, 0);
  });

  test("a run never exceeds the pool's unallocated cash", () => {
    assert.throws(() => computeAllocation({ receiptUnallocated: 100, taxComponent: 0, poolUnallocated: 50, month: "2026-09", steps: [pct(1, "A", "10")], categories: [cat("A")] }), AllocationRefused);
  });

  test("ACCEPTANCE 5/6 (pure) — monthly target does not refill after spending; replenishing reserve does", () => {
    const monthly = cat("M", { fundingType: "MONTHLY_TARGET", targetAmount: 300_000, fundedThisMonth: 300_000, balance: 0 });
    assert.equal(fundingNeed(monthly, "2026-09"), 0, "spent to zero, but the month is funded");
    const reserve = cat("R", { fundingType: "RESERVE_TARGET", targetAmount: 300_000, replenish: true, fundedEver: 300_000, balance: 0 });
    assert.equal(fundingNeed(reserve, "2026-09"), 300_000);
    const oneTime = cat("O", { fundingType: "RESERVE_TARGET", targetAmount: 300_000, replenish: false, fundedEver: 300_000, balance: 0 });
    assert.equal(fundingNeed(oneTime, "2026-09"), 0);
  });
});

describe("variance", () => {
  test("ACCEPTANCE 10 — expense budget 10,000, actual 12,000 → 2,000 overrun, +20%", () => {
    const v = computeVariance("PAYMENT", 1_000_000, 1_200_000);
    assert.equal(v.variance, 200_000);
    assert.equal(v.percentBp, 2000);
    assert.equal(v.state, "OVERRUN");
    assert.equal(v.adverse, true);
  });

  test("ACCEPTANCE 11 — revenue plan 10,000, actual 8,000 → −2,000 (shortfall of 20%)", () => {
    const v = computeVariance("RECEIPT", 1_000_000, 800_000);
    assert.equal(v.variance, -200_000);
    assert.equal(v.percentBp, -2000);
    assert.equal(Math.abs(v.percentBp!), 2000);
    assert.equal(v.state, "SHORTFALL");
  });

  test("ACCEPTANCE 12 — spending against a zero budget is Unbudgeted, never infinite", () => {
    const v = computeVariance("PAYMENT", 0, 50_000);
    assert.equal(v.state, "UNBUDGETED");
    assert.equal(v.percentBp, null);
    const z = computeVariance("PAYMENT", 0, 0);
    assert.equal(z.state, "NO_ACTIVITY");
    assert.equal(z.percentBp, null);
  });

  test("expense below plan is 'below budget', not savings", () => {
    assert.equal(computeVariance("PAYMENT", 1_000_000, 600_000).state, "BELOW_BUDGET");
  });

  test("aggregate percentages come from aggregate amounts", () => {
    // Lines: +100% on 100 and −10% on 10,000. Averaging would say +45%.
    const agg = aggregateVariance("PAYMENT", [{ planned: 10_000, actual: 20_000 }, { planned: 1_000_000, actual: 900_000 }]);
    assert.equal(agg.variance, -90_000);
    assert.equal(agg.percentBp, Math.round((-90_000 / 1_010_000) * 10_000));
  });

  test("threshold logic: EITHER vs BOTH", () => {
    const v = computeVariance("PAYMENT", 1_000_000, 1_050_000); // 500 SAR, 5%
    assert.equal(crossesThreshold(v, { amount: 40_000, percentBp: 1000, mode: "EITHER" }), true);
    assert.equal(crossesThreshold(v, { amount: 40_000, percentBp: 1000, mode: "BOTH" }), false);
  });

  test("FAC = actual + remaining forecast (commitments + additional)", () => {
    assert.deepEqual(forecastAtCompletion({ actualToDate: 500, openCommitments: 200, additionalForecast: 100 }), { remainingForecast: 300, fac: 800 });
  });
});

describe("phasing", () => {
  test("ACCEPTANCE 14 — mid-month compares against the plan due by the reporting date", () => {
    const rent = { planned: 1_000_000, phasing: "DUE_DATE" as const, dueDate: "2026-09-25" };
    assert.equal(plannedThrough(rent, "2026-09", "2026-09-15"), 0, "rent not yet due mid-month");
    assert.equal(plannedThrough(rent, "2026-09", "2026-09-30"), 1_000_000);
    const straight = { planned: 3_000_000, phasing: "STRAIGHT_LINE" as const };
    assert.equal(plannedThrough(straight, "2026-09", "2026-09-15"), 1_500_000);
    const weights = { planned: 900_000, phasing: "CUSTOM_WEIGHTS" as const, weights: { "1": 1, "15": 1, "28": 1 } };
    assert.equal(plannedThrough(weights, "2026-09", "2026-09-15"), 600_000);
    // Mid-month variance vs the phased plan; the full-month comparison is a separate figure.
    const v = computeVariance("PAYMENT", plannedThrough(straight, "2026-09", "2026-09-15"), 1_600_000);
    assert.equal(v.variance, 100_000);
    assert.equal(computeVariance("PAYMENT", 3_000_000, 1_600_000).state, "BELOW_BUDGET");
  });
});

describe("13-week forecast", () => {
  test("closing becomes next opening; shortfall and conservative delay", () => {
    const f = runForecast(100_000, "2026-09-20", [{ date: "2026-09-22", amount: 50_000, label: "collection", source: "t", collection: true }], [{ date: "2026-09-29", amount: 120_000, label: "rent", source: "t" }]);
    assert.equal(f.weeks.length, 13);
    for (let i = 1; i < 13; i++) assert.equal(f.weeks[i].opening, f.weeks[i - 1].closing);
    assert.equal(f.weeks[1].closing, 30_000);
    assert.equal(f.firstShortfallWeek, null);
    const c = runForecast(100_000, "2026-09-20", [{ date: "2026-09-22", amount: 50_000, label: "collection", source: "t", collection: true }], [{ date: "2026-09-29", amount: 120_000, label: "rent", source: "t" }], { delayWeeks: 2, collectPct: 80 });
    assert.equal(c.firstShortfallWeek, 2);
    assert.equal(c.weeks[2].receipts, 40_000);
  });
});

describe("CSV", () => {
  const csv = "Date,Amount,Reference,Description\n2026-09-01,150.00,,Cafe sale\n2026-09-01,150.00,,Cafe sale\n2026-09-02,-75.5,TRX9,Beans\n";
  test("two identical legitimate rows both get distinct fingerprints; re-import gives identical ones", () => {
    const { parsed, errors } = mapRows(parseCsv(csv), { date: "Date", amount: "Amount", reference: "Reference", description: "Description", dateFormat: "YYYY-MM-DD", hasHeader: true });
    assert.equal(errors.length, 0);
    const a = fingerprintRows("acc", parsed);
    assert.notEqual(a[0], a[1]);
    assert.deepEqual(a, fingerprintRows("acc", parsed));
  });
  test("validation errors are reported per row", () => {
    const { errors } = mapRows(parseCsv("Date,Amount\n31/02/2026,10\n2026-09-01,abc\n"), { date: "Date", amount: "Amount", dateFormat: "YYYY-MM-DD", hasHeader: true });
    assert.equal(errors.length, 2);
  });
});
