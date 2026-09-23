// COMMISSION ENGINE — pure arithmetic, no database and no HTTP.
//
// Every expected figure below is worked out independently and written as a literal. None of
// it is produced by calling the engine and asserting the engine agrees with itself, which
// would pass just as happily with the arithmetic inverted.
//
// The cases marked "brief" are the worked examples the business supplied. They are FIXTURES
// for this test, not an approved commission policy — the policy lives in
// docs/sales/COMMISSION_RULES.md and is explicitly recorded there as provisional.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
// The engine is TypeScript; this suite runs the compiled JS the build produces so the test
// exercises exactly what ships. Resolved lazily so a missing build fails loudly here rather
// than as a confusing import error.
const enginePath = path.join(ROOT, ".test-build/lib/services/commissions/engine.js");
const engine = await import(`file://${enginePath}`).catch((e) => {
  console.log("FATAL: build the engine first — npm run build:test-domain");
  console.log(String(e?.message ?? e));
  process.exit(1);
});

const {
  validatePlanRules, qualifyingBase, commissionOnCumulativeBase, shareOfBase,
  validateSplits, riyadhMonthStart, riyadhMonthEnd, selectPlanVersion,
  findOverlappingAssignment, roundMoney, Decimal,
} = engine;

// Built from the engine's own re-export, so the test constructs the exact Decimal the
// engine computes with rather than a second implementation that might round differently.
const D = (v) => new Decimal(v);
const results = { pass: 0, fail: 0, failures: [] };
function check(name, ok, detail = "") {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
}
const section = (t) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
/** Compare as fixed-2 strings: 100 and 100.004 are not the same wage. */
const money = (d) => d.toFixed(2);

const plan = (baseRatePercent, tiers = [], tierMode = "INCREMENTAL", currency = "SAR") => ({
  basis: "NET_COLLECTION",
  tierMode,
  baseRatePercent: D(baseRatePercent),
  tiers: tiers.map((t) => ({
    fromAmount: D(t[0]),
    toAmount: t[1] === null ? null : D(t[1]),
    ratePercent: D(t[2]),
  })),
  currency,
});

// ═══════════════════════════════════════════════════════════════════════════
section("A — THE BASE IS NET OF TAX AND OF WHAT DOES NOT QUALIFY");

sub("A1. brief: a fully qualifying invoice, net 10,000 + VAT 1,500");
// 11,500 gross collected in full → base 10,000. The 1,500 is the state's, never earned.
const fullBase = qualifyingBase({ amountGross: D(11500), amountTax: D(1500), amountNonQualifying: D(0) });
check("collecting 11,500 on net 10,000 gives a base of 10,000", money(fullBase) === "10000.00", money(fullBase));

sub("A2. brief: a partial collection of 5,750 on that same invoice");
// Half the gross arrives. Tax travels with it proportionally: 5,750 − 750 = 5,000.
const halfBase = qualifyingBase({ amountGross: D(5750), amountTax: D(750), amountNonQualifying: D(0) });
check("collecting 5,750 gives a qualifying base of 5,000", money(halfBase) === "5000.00", money(halfBase));

sub("A3. non-qualifying lines come out too");
const mixed = qualifyingBase({ amountGross: D(11500), amountTax: D(1500), amountNonQualifying: D(2000) });
check("10,000 net less 2,000 non-qualifying is 8,000", money(mixed) === "8000.00", money(mixed));

sub("A4. a base can never go negative");
const over = qualifyingBase({ amountGross: D(1000), amountTax: D(500), amountNonQualifying: D(900) });
check("an over-subtracted base floors at zero, it does not claw back", money(over) === "0.00", money(over));

// ═══════════════════════════════════════════════════════════════════════════
section("B — DIFFERENT RATES PER EMPLOYEE, NO TIERS");

sub("B1. brief: employee A on 1% and employee B on 2%, base 10,000");
const a1 = commissionOnCumulativeBase(D(10000), plan(1));
const b1 = commissionOnCumulativeBase(D(10000), plan(2));
check("A earns 100.00", money(a1.amount) === "100.00", money(a1.amount));
check("B earns 200.00", money(b1.amount) === "200.00", money(b1.amount));
check("and the rate reported back is the rate applied", a1.effectiveRatePercent.toFixed(2) === "1.00",
  a1.effectiveRatePercent.toString());

sub("B2. a zero base earns nothing, and does not throw");
const z = commissionOnCumulativeBase(D(0), plan(1));
check("zero base, zero commission", money(z.amount) === "0.00", money(z.amount));

// ═══════════════════════════════════════════════════════════════════════════
section("C — TIERS APPLY TO THE SLICE, NOT TO THE WHOLE BASE");

// brief: 1% on everything, plus 0.5 points more on the part between 100,000 and 120,000.
const tiered = plan(1, [[100000, 120000, 0.5]]);

sub("C1. brief: a cumulative base of 110,000 earns 1,150");
// Worked by hand: 110,000 x 1% = 1,100. The slice inside the band is 110,000 − 100,000
// = 10,000, at 0.5 points = 50. Total 1,150.
const t110 = commissionOnCumulativeBase(D(110000), tiered);
check("110,000 earns exactly 1,150.00", money(t110.amount) === "1150.00", money(t110.amount));
check("the effective rate is 1.045455%, not 1.5%",
  t110.effectiveRatePercent.toFixed(4) === "1.0455", t110.effectiveRatePercent.toString());

sub("C2. below the band, the tier contributes nothing");
// 90,000 x 1% = 900.
const t90 = commissionOnCumulativeBase(D(90000), tiered);
check("90,000 earns 900.00", money(t90.amount) === "900.00", money(t90.amount));

sub("C3. exactly at the lower bound is still outside the band");
// 100,000 x 1% = 1,000, and the slice above 100,000 is zero.
const t100 = commissionOnCumulativeBase(D(100000), tiered);
check("100,000 earns 1,000.00", money(t100.amount) === "1000.00", money(t100.amount));

sub("C4. above the band, only the band's own width is uplifted");
// 130,000 x 1% = 1,300, plus the full 20,000 band at 0.5 points = 100. Total 1,400.
const t130 = commissionOnCumulativeBase(D(130000), tiered);
check("130,000 earns 1,400.00 — the uplift stops at the band's ceiling",
  money(t130.amount) === "1400.00", money(t130.amount));

sub("C5. one riyal inside the band");
// 100,001 x 1% = 1,000.01, plus 1 x 0.5% = 0.005 → 1,000.015 → half-up → 1,000.02.
const t1 = commissionOnCumulativeBase(D(100001), tiered);
check("100,001 earns 1,000.02 — halves round up, they are not dropped",
  money(t1.amount) === "1000.02", money(t1.amount));

sub("C6. an open-ended top band");
// 1% on 200,000 = 2,000, plus 0.5 points on everything above 100,000 = 500. Total 2,500.
const open = plan(1, [[100000, null, 0.5]]);
const tOpen = commissionOnCumulativeBase(D(200000), open);
check("an 'and above' band uplifts everything past its floor", money(tOpen.amount) === "2500.00",
  money(tOpen.amount));

// ═══════════════════════════════════════════════════════════════════════════
section("D — SPLIT OWNERSHIP DIVIDES THE BASE");

sub("D1. brief: base 5,000 split 60/40, A on 1% and B on 2%");
// A: 5,000 x 60% = 3,000 base, x 1% = 30. B: 5,000 x 40% = 2,000 base, x 2% = 40.
const aShare = shareOfBase(D(5000), D(60));
const bShare = shareOfBase(D(5000), D(40));
check("A's share of base is 3,000", money(aShare) === "3000.00", money(aShare));
check("B's share of base is 2,000", money(bShare) === "2000.00", money(bShare));
const aSplit = commissionOnCumulativeBase(aShare, plan(1));
const bSplit = commissionOnCumulativeBase(bShare, plan(2));
check("A earns 30.00", money(aSplit.amount) === "30.00", money(aSplit.amount));
check("B earns 40.00", money(bSplit.amount) === "40.00", money(bSplit.amount));

sub("D2. splits must total exactly 100");
const bad = validateSplits([{ employeeId: "a", sharePercent: D(60) }, { employeeId: "b", sharePercent: D(30) }]);
check("90% total is refused, not normalised", bad.some((p) => p.code === "SPLIT_TOTAL"), JSON.stringify(bad));
const good = validateSplits([{ employeeId: "a", sharePercent: D(60) }, { employeeId: "b", sharePercent: D(40) }]);
check("100% total is accepted", good.length === 0, JSON.stringify(good));
const dupe = validateSplits([{ employeeId: "a", sharePercent: D(50) }, { employeeId: "a", sharePercent: D(50) }]);
check("the same person twice is refused", dupe.some((p) => p.code === "SPLIT_DUPLICATE"), JSON.stringify(dupe));

// ═══════════════════════════════════════════════════════════════════════════
section("E — PARTIAL PAYMENTS ACCRUE ONCE, CUMULATIVELY");

sub("E1. brief: 5,000 then the remaining 5,000 adds 50, it does not re-add 100");
// This is the property the whole cumulative-then-difference design exists for.
const first = commissionOnCumulativeBase(D(5000), plan(1));   // 50.00
const both = commissionOnCumulativeBase(D(10000), plan(1));   // 100.00
const increment = roundMoney(both.amount.minus(first.amount));
check("the first 5,000 earns 50.00", money(first.amount) === "50.00", money(first.amount));
check("cumulative 10,000 is worth 100.00", money(both.amount) === "100.00", money(both.amount));
check("so the second payment adds 50.00, not another 100.00", money(increment) === "50.00", money(increment));

sub("E2. a re-delivered payment adds nothing");
// The same cumulative base recomputed gives the same target, so the difference is zero.
const replay = roundMoney(commissionOnCumulativeBase(D(10000), plan(1)).amount.minus(both.amount));
check("recomputing the same cumulative base yields a zero increment", money(replay) === "0.00", money(replay));

sub("E3. thirds of a riyal do not leak across three payments");
// 1% of 10,000 in three parts. Each part alone rounds; the cumulative method must still
// total exactly 100.00 rather than 99.99 or 100.01.
const p1 = commissionOnCumulativeBase(D(3333.33), plan(1)).amount;
const p2 = commissionOnCumulativeBase(D(6666.66), plan(1)).amount;
const p3 = commissionOnCumulativeBase(D(10000), plan(1)).amount;
const inc1 = p1, inc2 = roundMoney(p2.minus(p1)), inc3 = roundMoney(p3.minus(p2));
const total = roundMoney(inc1.plus(inc2).plus(inc3));
check(`three increments total exactly 100.00 (${money(inc1)} + ${money(inc2)} + ${money(inc3)})`,
  money(total) === "100.00", money(total));

sub("E4. a refund reduces the cumulative base and reverses the difference");
// 10,000 collected then 2,000 refunded → cumulative 8,000 → target 80.00, so −20.00.
const afterRefund = commissionOnCumulativeBase(D(8000), plan(1));
const reversal = roundMoney(afterRefund.amount.minus(both.amount));
check("a 2,000 refund produces a −20.00 adjustment", money(reversal) === "-20.00", money(reversal));

// ═══════════════════════════════════════════════════════════════════════════
section("F — RULES WE REFUSE RATHER THAN APPROXIMATE");

sub("F1. retroactive tiers are refused");
const retro = validatePlanRules(plan(1, [[100000, 120000, 0.5]], "RETROACTIVE"));
check("a retroactive plan cannot be saved",
  retro.some((p) => p.code === "RETROACTIVE_TIERS_UNSUPPORTED"), JSON.stringify(retro));
check("and the refusal explains why rather than just failing",
  retro.some((p) => /incremental/i.test(p.message)), JSON.stringify(retro));

sub("F2. a non-SAR plan is refused, not converted");
const usd = validatePlanRules(plan(1, [], "INCREMENTAL", "USD"));
check("USD is refused", usd.some((p) => p.code === "CURRENCY_UNSUPPORTED"), JSON.stringify(usd));
check("because there is no exchange policy to honour",
  usd.some((p) => /exchange-rate policy/i.test(p.message)), JSON.stringify(usd));

sub("F3. overlapping tiers are refused");
const overlap = validatePlanRules(plan(1, [[0, 100, 0.5], [50, 200, 0.5]]));
check("overlapping bands cannot be saved", overlap.some((p) => p.code === "TIER_OVERLAP"), JSON.stringify(overlap));

sub("F4. an empty band and a band above an open band are refused");
const empty = validatePlanRules(plan(1, [[100, 100, 0.5]]));
check("a zero-width band is refused", empty.some((p) => p.code === "TIER_EMPTY"), JSON.stringify(empty));
const afterOpen = validatePlanRules(plan(1, [[0, null, 0.5], [100, 200, 0.5]]));
check("nothing may sit above an open-ended band",
  afterOpen.some((p) => p.code === "TIER_AFTER_OPEN_BAND"), JSON.stringify(afterOpen));

sub("F5. a valid incremental plan passes clean");
check("the brief's own tiered plan validates", validatePlanRules(tiered).length === 0,
  JSON.stringify(validatePlanRules(tiered)));

// ═══════════════════════════════════════════════════════════════════════════
section("G — PERIODS ARE RIYADH MONTHS, STORED AS UTC INSTANTS");

sub("G1. a Riyadh month begins at 21:00 UTC on the last day of the previous month");
// 1 Feb 2026 00:00 Riyadh is 31 Jan 2026 21:00 UTC.
const feb = riyadhMonthStart(new Date("2026-02-14T10:00:00Z"));
check("February 2026 starts at 2026-01-31T21:00:00Z", feb.toISOString() === "2026-01-31T21:00:00.000Z",
  feb.toISOString());
const febEnd = riyadhMonthEnd(new Date("2026-02-14T10:00:00Z"));
check("and ends at 2026-02-28T21:00:00Z", febEnd.toISOString() === "2026-02-28T21:00:00.000Z",
  febEnd.toISOString());

sub("G2. the month edge falls on the Riyadh boundary, not the UTC one");
// 2026-01-31T22:00Z is already 1 Feb in Riyadh, so it belongs to February.
const lateJan = riyadhMonthStart(new Date("2026-01-31T22:00:00Z"));
check("22:00 UTC on 31 Jan belongs to February", lateJan.toISOString() === "2026-01-31T21:00:00.000Z",
  lateJan.toISOString());
// 2026-01-31T20:00Z is still 31 Jan in Riyadh, so it belongs to January.
const earlier = riyadhMonthStart(new Date("2026-01-31T20:00:00Z"));
check("20:00 UTC on 31 Jan still belongs to January", earlier.toISOString() === "2025-12-31T21:00:00.000Z",
  earlier.toISOString());

sub("G3. December rolls into the next year");
const dec = riyadhMonthEnd(new Date("2026-12-20T00:00:00Z"));
check("December 2026 ends at 2026-12-31T21:00:00Z", dec.toISOString() === "2026-12-31T21:00:00.000Z",
  dec.toISOString());

// ═══════════════════════════════════════════════════════════════════════════
section("H — PLAN VERSIONS AND ASSIGNMENT OVERLAP");

sub("H1. the version in force is chosen by the date the money arrived");
const versions = [
  { id: "v1", effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: new Date("2026-06-01T00:00:00Z") },
  { id: "v2", effectiveFrom: new Date("2026-06-01T00:00:00Z"), effectiveTo: null },
];
check("a March collection uses v1",
  selectPlanVersion(versions, new Date("2026-03-15T00:00:00Z"))?.id === "v1", "");
check("a September collection uses v2",
  selectPlanVersion(versions, new Date("2026-09-15T00:00:00Z"))?.id === "v2", "");
check("the boundary belongs to the version that starts on it",
  selectPlanVersion(versions, new Date("2026-06-01T00:00:00Z"))?.id === "v2", "");
check("a date before any version has no plan, rather than a guessed one",
  selectPlanVersion(versions, new Date("2025-01-01T00:00:00Z")) === null, "");

sub("H2. overlapping assignments for one employee are detected");
const existing = [{ effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: new Date("2026-06-01T00:00:00Z") }];
check("an overlapping assignment is refused",
  findOverlappingAssignment(existing, {
    effectiveFrom: new Date("2026-03-01T00:00:00Z"), effectiveTo: null }) !== null, "");
check("an adjacent assignment is allowed",
  findOverlappingAssignment(existing, {
    effectiveFrom: new Date("2026-06-01T00:00:00Z"), effectiveTo: null }) === null, "");
check("an open-ended existing assignment blocks everything after it",
  findOverlappingAssignment(
    [{ effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: null }],
    { effectiveFrom: new Date("2027-01-01T00:00:00Z"), effectiveTo: null }) !== null, "");

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${"=".repeat(78)}\n  COMMISSION ENGINE RESULT\n${"=".repeat(78)}`);
console.log(`${results.pass} passed, ${results.fail} failed`);
if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
process.exit(results.fail === 0 ? 0 : 1);
