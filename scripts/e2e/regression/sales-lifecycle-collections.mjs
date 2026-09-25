// LEAD → PIPELINE → QUOTATION → COLLECTION → COMMISSION, as pure domain behaviour.
//
// No database and no HTTP. Everything here calls the real service functions with a stand-in
// transaction object, which is enough to prove the DECISIONS: which outcomes qualify a
// lead, how a gross receipt is split into tax and net, what a replay does, and what a
// reversal does to the money.
//
// What this does NOT prove, stated once so no line below can be read as claiming it:
//   - that anything persists. The `tx` here is a recorder, not a database.
//   - that any of it is authorised. Authorisation is in the routes, which are not called.
//   - that two concurrent callers serialise. `FOR UPDATE` is a database behaviour and a
//     fake cannot exhibit it; the integration suite is where that is proven.
//
// The arithmetic and the qualification rules, however, are proven here and are the part
// most likely to be got wrong by a later edit.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const load = async (rel) => {
  const p = path.join(ROOT, ".test-build/lib/services", rel);
  return import(`file://${p}`).catch((e) => {
    console.log("FATAL: build the domain first — npm run build:test-domain");
    console.log(String(e?.message ?? e));
    process.exit(1);
  });
};

const qualification = await load("sales/qualification.js");
const collections = await load("sales/collections.js");
const engine = await load("commissions/engine.js");

const { QUALIFYING_OUTCOMES, APPOINTMENT_OUTCOMES, ACTIVITY_OUTCOMES, qualifies } = qualification;
const { allocate, COLLECTION_SOURCE } = collections;
const { Decimal } = engine;

const results = { pass: 0, fail: 0, failures: [] };
function check(name, ok, detail = "") {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
}
const section = (t) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const D = (x) => new Decimal(String(x));

// ─────────────────────────────────────────────────────────────────────────────
section("1. WHICH INTERACTIONS PUT A LEAD IN THE PIPELINE");

sub("the five that mean the customer engaged");
for (const o of ["INTERESTED", "MEETING_SCHEDULED", "VISIT_SCHEDULED", "MEETING_COMPLETED", "VISIT_COMPLETED"]) {
  check(`${o} qualifies`, qualifies(o) === true);
}

sub("and nothing else does");
for (const o of ["NO_ANSWER", "LEFT_MESSAGE", "FOLLOW_UP_REQUIRED", "NOT_INTERESTED", "NOTE_ONLY"]) {
  check(`${o} does NOT qualify`, qualifies(o) === false);
}
check("a missing outcome does not qualify", qualifies(null) === false && qualifies(undefined) === false);
check("an unknown string does not qualify", qualifies("SOMETHING_ELSE") === false);

sub("the set is exactly five, and every member is a real outcome");
check("five qualifying outcomes", QUALIFYING_OUTCOMES.size === 5, `got ${QUALIFYING_OUTCOMES.size}`);
check(
  "every qualifying outcome is a declared outcome",
  [...QUALIFYING_OUTCOMES].every((o) => ACTIVITY_OUTCOMES.includes(o)),
);

sub("a customer appointment is distinguishable from an internal reminder");
check("a scheduled meeting is an appointment", APPOINTMENT_OUTCOMES.has("MEETING_SCHEDULED"));
check("a scheduled visit is an appointment", APPOINTMENT_OUTCOMES.has("VISIT_SCHEDULED"));
check("follow-up-required is NOT an appointment", !APPOINTMENT_OUTCOMES.has("FOLLOW_UP_REQUIRED"));
check("a note is NOT an appointment", !APPOINTMENT_OUTCOMES.has("NOTE_ONLY"));
check(
  "every appointment also qualifies",
  [...APPOINTMENT_OUTCOMES].every((o) => QUALIFYING_OUTCOMES.has(o)),
);

// ─────────────────────────────────────────────────────────────────────────────
section("2. SPLITTING A RECEIPT INTO TAX AND NET");

// The worked example the specification names, and the one a reader will check first.
const doc = {
  quoteId: "q1", quoteNumber: "Q-202609-0008", currency: "SAR",
  gross: D("5750.00"), tax: D("750.00"), net: D("5000.00"),
};

sub("the whole document at once");
{
  const { tax, net } = allocate(D("5750.00"), doc, D(0), D(0));
  check("tax is 750.00", tax.toFixed(2) === "750.00", tax.toFixed(2));
  check("net is 5,000.00", net.toFixed(2) === "5000.00", net.toFixed(2));
  check("gross reconciles", tax.plus(net).toFixed(2) === "5750.00");
}

sub("a partial payment takes its proportional share, not a guessed rate");
{
  // 2,300 of 5,750 is 40%. 40% of 750 is 300.
  const { tax, net } = allocate(D("2300.00"), doc, D(0), D(0));
  check("tax is 300.00", tax.toFixed(2) === "300.00", tax.toFixed(2));
  check("net is 2,000.00", net.toFixed(2) === "2000.00", net.toFixed(2));
}

sub("the settling payment takes whatever tax is left, so the document reconciles exactly");
{
  // A deliberately awkward split: thirds of a document whose tax does not divide evenly.
  const odd = { ...doc, gross: D("1000.00"), tax: D("130.44"), net: D("869.56") };
  const a = allocate(D("333.33"), odd, D(0), D(0));
  const b = allocate(D("333.33"), odd, D("333.33"), a.tax);
  const c = allocate(D("333.34"), odd, D("666.66"), a.tax.plus(b.tax));

  const totalGross = D("333.33").plus(D("333.33")).plus(D("333.34"));
  const totalTax = a.tax.plus(b.tax).plus(c.tax);
  const totalNet = a.net.plus(b.net).plus(c.net);

  check("the three payments sum to the document's gross", totalGross.toFixed(2) === "1000.00");
  check("their tax sums to the document's tax EXACTLY", totalTax.toFixed(2) === "130.44", totalTax.toFixed(2));
  check("their net sums to the document's net EXACTLY", totalNet.toFixed(2) === "869.56", totalNet.toFixed(2));
  check("gross = tax + net across the whole document", totalTax.plus(totalNet).toFixed(2) === "1000.00");
}

sub("a zero-rated document allocates no tax");
{
  const free = { ...doc, gross: D("1000.00"), tax: D("0.00"), net: D("1000.00") };
  const { tax, net } = allocate(D("400.00"), free, D(0), D(0));
  check("no tax", tax.toFixed(2) === "0.00");
  check("all of it is net", net.toFixed(2) === "400.00");
}

sub("tax can never exceed the payment it is taken from");
{
  // A pathological document — tax larger than gross — must not produce a negative net.
  const broken = { ...doc, gross: D("100.00"), tax: D("500.00"), net: D("-400.00") };
  const { tax, net } = allocate(D("100.00"), broken, D(0), D(0));
  check("tax is clamped to the payment", tax.lessThanOrEqualTo(D("100.00")), tax.toFixed(2));
  check("net is never negative", net.greaterThanOrEqualTo(D(0)), net.toFixed(2));
}

// ─────────────────────────────────────────────────────────────────────────────
section("3. WHAT COMMISSION AN APPROVED COLLECTION IS WORTH");

sub("the specification's worked example, through the real engine");
{
  const rules = {
    currency: "SAR",
    baseRatePercent: D("1"),
    tierMode: "INCREMENTAL",
    tiers: [],
  };
  const { amount, effectiveRatePercent } = engine.commissionOnCumulativeBase(D("5000.00"), rules);
  check("1% of a 5,000 net basis is 50.00", amount.toFixed(2) === "50.00", amount.toFixed(2));
  check("the effective rate is 1%", effectiveRatePercent.toFixed(2) === "1.00");
}

sub("a partial collection does not earn commission on the whole quotation");
{
  const rules = { currency: "SAR", baseRatePercent: D("1"), tierMode: "INCREMENTAL", tiers: [] };
  // First payment: 2,000 net of the 5,000.
  const first = engine.commissionOnCumulativeBase(D("2000.00"), rules);
  check("the first 2,000 earns 20.00, not 50.00", first.amount.toFixed(2) === "20.00", first.amount.toFixed(2));

  // The remainder brings the cumulative base to 5,000; the DELTA is what gets posted.
  const whole = engine.commissionOnCumulativeBase(D("5000.00"), rules);
  const delta = whole.amount.minus(first.amount);
  check("the remainder adds 30.00", delta.toFixed(2) === "30.00", delta.toFixed(2));
  check("the two together are 50.00", first.amount.plus(delta).toFixed(2) === "50.00");
}

sub("replaying the first approval adds nothing");
{
  const rules = { currency: "SAR", baseRatePercent: D("1"), tierMode: "INCREMENTAL", tiers: [] };
  const once = engine.commissionOnCumulativeBase(D("2000.00"), rules).amount;
  const again = engine.commissionOnCumulativeBase(D("2000.00"), rules).amount;
  // The engine is a function of the cumulative base. A replay does not change that base, so
  // the target is identical and the delta against what is already recorded is zero.
  check("the same base gives the same target", once.toFixed(2) === again.toFixed(2));
  check("the delta against what is already posted is zero", again.minus(once).toFixed(2) === "0.00");
}

sub("a reversal drops the base and the difference comes out negative");
{
  const rules = { currency: "SAR", baseRatePercent: D("1"), tierMode: "INCREMENTAL", tiers: [] };
  const posted = engine.commissionOnCumulativeBase(D("5000.00"), rules).amount;
  // Reversing the 2,000 leaves 3,000 in the period.
  const afterReversal = engine.commissionOnCumulativeBase(D("3000.00"), rules).amount;
  const delta = afterReversal.minus(posted);
  check("the correction is negative", delta.isNegative(), delta.toFixed(2));
  check("it is exactly -20.00", delta.toFixed(2) === "-20.00", delta.toFixed(2));
}

sub("the share divides the base BEFORE the rate, not the commission after it");
{
  const base = D("30000.00");
  const share = D("60");
  const shared = engine.shareOfBase(base, share);
  check("60% of 30,000 is 18,000", shared.toFixed(2) === "18000.00", shared.toFixed(2));

  const rules = { currency: "SAR", baseRatePercent: D("1"), tierMode: "INCREMENTAL", tiers: [] };
  const commission = engine.commissionOnCumulativeBase(shared, rules).amount;
  check("1% of the shared base is 180.00", commission.toFixed(2) === "180.00", commission.toFixed(2));
}

// ─────────────────────────────────────────────────────────────────────────────
section("4. THE SOURCE STAMP");

check(
  "approved collections are stamped MANUAL_FINANCE_VERIFICATION",
  COLLECTION_SOURCE === "MANUAL_FINANCE_VERIFICATION",
  COLLECTION_SOURCE,
);
check(
  "which is not the sandbox source, so the two can never be confused",
  COLLECTION_SOURCE !== "SANDBOX",
);

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(78)}`);
console.log(`  ${results.pass} passed, ${results.fail} failed`);
if (results.fail) {
  console.log("\n  Failures:");
  for (const f of results.failures) console.log(`    - ${f}`);
}
console.log("=".repeat(78));
process.exit(results.fail ? 1 : 0);
