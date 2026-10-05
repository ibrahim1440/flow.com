// Depreciation arithmetic (stage 5). Values are synthetic test assumptions, worked by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { chargeThrough, startMonth, ym, type DepAsset } from "../../../src/lib/accounting/fa-depreciation";

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const Z = { accumulated: new Prisma.Decimal(0), months: 0 };
const asset = (o: Partial<DepAsset>): DepAsset => ({
  cost: "18500.00", residualValue: "0", openingAccumulated: "0", openingMonths: 0, usefulLifeMonths: 36,
  method: "STRAIGHT_LINE", decliningFactor: null, startConvention: "IN_SERVICE_MONTH", inServiceDate: D("2026-05-01"), ...o,
});
/** Charge month by month from the start, as posted runs would. */
function monthly(a: DepAsset, months: number) {
  let posted = Z;
  const out: string[] = [];
  for (let m = startMonth(a); m < startMonth(a) + months; m++) {
    const c = chargeThrough(a, m, posted);
    out.push(c.amount.toFixed(2));
    posted = { accumulated: posted.accumulated.add(c.amount), months: posted.months + c.months };
  }
  return { out, posted };
}

test("straight line, cumulative target: 18,500 over 36 months, no drift, last month exact", () => {
  const a = asset({});
  const { out, posted } = monthly(a, 40);
  // round2(18500 × k / 36): 513.89, 1027.78, 1541.67, 2055.56, 2569.44 → charges 513.89 ×4, then 513.88
  assert.deepEqual(out.slice(0, 5), ["513.89", "513.89", "513.89", "513.89", "513.88"]);
  assert.equal(posted.accumulated.toFixed(2), "18500.00", "fully depreciated, not a halala more");
  assert.deepEqual(out.slice(36), ["0.00", "0.00", "0.00", "0.00"], "nothing after the end of life");
  assert.equal(posted.months, 36);
});

test("catch-up: an asset first charged five months after it went into service takes the months in one line", () => {
  const c = chargeThrough(asset({}), ym(D("2026-09-30")), Z);
  assert.equal(c.amount.toFixed(2), "2569.44");
  assert.equal(c.months, 5);
  assert.match(c.note ?? "", /4 earlier month/);
  assert.equal(c.nbvAfter.toFixed(2), "15930.56");
});

test("start convention NEXT_MONTH and residual value: 120,000 − 12,000 over 60 months = 1,800.00 a month", () => {
  const a = asset({ cost: "120000.00", residualValue: "12000.00", usefulLifeMonths: 60, startConvention: "NEXT_MONTH", inServiceDate: D("2025-12-15") });
  assert.equal(chargeThrough(a, ym(D("2025-12-31")), Z).amount.toFixed(2), "0.00", "nothing in the in-service month");
  const { out, posted } = monthly(a, 61);
  assert.ok(out.slice(0, 60).every((x) => x === "1800.00"));
  assert.equal(posted.accumulated.toFixed(2), "108000.00");
  assert.equal(new Prisma.Decimal("120000").sub(posted.accumulated).toFixed(2), "12000.00", "stops at the residual value");
});

test("opening depreciation at cutover: 60,000 with 24,000 over 24 months, life 60 → 36,000 over the 36 months left", () => {
  const a = asset({ cost: "60000.00", openingAccumulated: "24000.00", openingMonths: 24, usefulLifeMonths: 60, inServiceDate: D("2026-01-01") });
  const c = chargeThrough(a, ym(D("2026-01-31")), Z);
  assert.equal(c.amount.toFixed(2), "1000.00");
  assert.equal(c.accumulatedAfter.toFixed(2), "25000.00");
  const { posted } = monthly(a, 36);
  assert.equal(posted.accumulated.toFixed(2), "36000.00");
});

test("declining balance, factor 2 over 5 years: 10,000 → 333.33, then on the reduced NBV; never below the residual; last month to the residual", () => {
  const a = asset({ cost: "10000.00", residualValue: "500.00", usefulLifeMonths: 60, method: "DECLINING_BALANCE", decliningFactor: "2", inServiceDate: D("2026-01-01") });
  const { out, posted } = monthly(a, 60);
  assert.equal(out[0], "333.33");               // 10,000 × 2 / 5 / 12
  assert.equal(out[1], "322.22");               // 9,666.67 × 0.4 / 12 = 322.222…
  assert.equal(posted.accumulated.toFixed(2), "9500.00", "the last month takes the NBV to the residual value");
  assert.ok(out.every((x) => Number(x) >= 0));
});

test("nothing to charge when the base is used up or the asset has no life left", () => {
  assert.equal(chargeThrough(asset({ residualValue: "18500.00" }), ym(D("2026-09-30")), Z).amount.toFixed(2), "0.00");
  assert.equal(chargeThrough(asset({ openingMonths: 36, usefulLifeMonths: 36, openingAccumulated: "18500.00" }), ym(D("2026-09-30")), Z).amount.toFixed(2), "0.00");
});
