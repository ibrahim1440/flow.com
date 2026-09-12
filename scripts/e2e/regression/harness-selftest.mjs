// Proof that the harness can actually fail.
//
// Two things are proved here, both of which the certified harness got wrong, and both of
// which are unprovable against a live database because neither failure can be staged:
//
//   1. the oversell detector fires on an invalid reservation state, and stays silent on
//      a valid one;
//   2. the runner refuses a suite that died, said nothing, or asserted nothing.
//
// ── Why this suite exists ────────────────────────────────────────────────────
// A green harness proves nothing on its own. The certified regression run reported ALL
// SUITES GREEN while its inventory-safety detector was incapable of firing: skuUnits()
// returned no `free` key, so `free0` was `undefined`, and both
//
//     check("racers together take at most the N units that were free", gained <= free0)
//     if (gained > free0) issue("BLOCKER", "Concurrent reservations oversell...")
//
// evaluated against `undefined`. The first was permanently false (a standing red nobody
// chased) and the second was permanently false too — so the single worst inventory
// failure this harness exists to catch could not be reported under ANY circumstances.
//
// Fixing the arithmetic is not enough. Something has to demonstrate, on every run, that
// a deliberately invalid state still produces a BLOCKER. That is this file.
//
// ── Why it needs no database ─────────────────────────────────────────────────
// It imports oversell.mjs and suite-verdict.mjs and nothing else. Both are pure, and —
// critically — both are the SAME modules harness.mjs, order-to-delivery.mjs and
// run-all.mjs use, so exercising them here exercises the shipped decision paths rather
// than copies of them. It deliberately does NOT import harness.mjs, which refuses to load
// without an approved throwaway database.
//
// It therefore runs on a clean clone with no server, no database and no credentials,
// which is exactly what makes it a usable baseline check.

import { freeUnits, assessOversell } from "./oversell.mjs";
import { classifySuiteResult } from "./suite-verdict.mjs";

let pass = 0,
  fail = 0;
const failures = [];

const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log("  [PASS] " + name);
  } else {
    fail++;
    failures.push(name);
    console.log("  [FAIL] " + name + (detail ? "  << " + detail : ""));
  }
  return ok;
};
const section = (t) => console.log("\n" + "=".repeat(78) + "\n  " + t + "\n" + "=".repeat(78));
const sub = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 60 - t.length)));

/** Assert that a call raises — the guard is only useful if it actually stops things. */
function throws(name, fn, expectedFragment) {
  let raised = null;
  try {
    fn();
  } catch (e) {
    raised = e;
  }
  if (!raised) return check(name, false, "expected a throw, none happened");
  return check(
    name,
    String(raised.message).includes(expectedFragment),
    `message did not mention "${expectedFragment}": ${raised.message}`
  );
}

section("HARNESS SELF-TEST — can this harness fail? (no database, no server)");

// ─────────────────────────────────────────────────────────────────────────────
sub("A. free-to-promise arithmetic");

check("4 on hand, 0 reserved -> 4 free", freeUnits(4, 0) === 4, String(freeUnits(4, 0)));
check("10 on hand, 6 reserved -> 4 free", freeUnits(10, 6) === 4, String(freeUnits(10, 6)));
check("6 on hand, 6 reserved -> 0 free", freeUnits(6, 6) === 0, String(freeUnits(6, 6)));

// The reason clamping is refused. If reserved has somehow exceeded available, the harness
// must be able to SEE the negative number; Math.max(0, ...) would report a healthy 0.
check(
  "over-reserved lot reports NEGATIVE free, not a clamped 0",
  freeUnits(4, 7) === -3,
  String(freeUnits(4, 7))
);

// ─────────────────────────────────────────────────────────────────────────────
sub("B. VALID synthetic states — the detector must stay silent");

// Six racers, 4 units free, 4 taken. The reservation guards did their job.
const exact = assessOversell({ freeBefore: 4, reservedBefore: 0, reservedAfter: 4 });
check("consuming exactly the free stock is NOT an oversell", exact.oversold === false, JSON.stringify(exact));
check("  and it reports the 4 units gained", exact.gained === 4, JSON.stringify(exact));

const under = assessOversell({ freeBefore: 4, reservedBefore: 2, reservedAfter: 5 });
check("taking less than was free is NOT an oversell", under.oversold === false, JSON.stringify(under));

const none = assessOversell({ freeBefore: 0, reservedBefore: 6, reservedAfter: 6 });
check("taking nothing when nothing is free is NOT an oversell", none.oversold === false, JSON.stringify(none));

// A cancellation racing the reservations nets stock back. Signed `gained` keeps that from
// reading as a violation.
const released = assessOversell({ freeBefore: 2, reservedBefore: 9, reservedAfter: 5 });
check("a net RELEASE is NOT an oversell", released.oversold === false, JSON.stringify(released));
check("  and it reports a negative gain", released.gained === -4, JSON.stringify(released));
// Without this, dropping the `oversold ?` ternary from `overage` goes unnoticed: every
// other overage assertion is on the oversold branch, where the mutant agrees.
check("  and overage is 0 when nothing was oversold", released.overage === 0, JSON.stringify(released));

// ─────────────────────────────────────────────────────────────────────────────
sub("C. INVALID synthetic states — the detector MUST fire");

// THE PROOF. Six racers each reserve 1 unit against a shelf holding 4 free. Two units
// that do not exist have been promised. This is the exact failure section F watches for,
// and before this repair it produced no BLOCKER and no red assertion.
const oversold = assessOversell({ freeBefore: 4, reservedBefore: 0, reservedAfter: 6 });
check("6 units taken from 4 free IS an oversell", oversold.oversold === true, JSON.stringify(oversold));
check("  and the overage is reported as 2 units", oversold.overage === 2, JSON.stringify(oversold));
check("  and the gain is reported as 6 units", oversold.gained === 6, JSON.stringify(oversold));

// One unit over is still over. The boundary must be strict, or a single-unit oversell
// hides forever.
const byOne = assessOversell({ freeBefore: 4, reservedBefore: 0, reservedAfter: 5 });
check("exceeding free stock by a single unit IS an oversell", byOne.oversold === true, JSON.stringify(byOne));
check("  overage 1", byOne.overage === 1, JSON.stringify(byOne));

// Reserving anything at all when nothing is free.
const fromEmpty = assessOversell({ freeBefore: 0, reservedBefore: 3, reservedAfter: 4 });
check("reserving against an empty shelf IS an oversell", fromEmpty.oversold === true, JSON.stringify(fromEmpty));

// An already-inverted lot: free is negative before the race even starts.
const alreadyInverted = assessOversell({ freeBefore: -2, reservedBefore: 8, reservedAfter: 8 });
check(
  "a lot already over-reserved IS an oversell even with no new gain",
  alreadyInverted.oversold === true,
  JSON.stringify(alreadyInverted)
);

// ─────────────────────────────────────────────────────────────────────────────
sub("D. The original defect must be impossible to reintroduce");

// This is the regression guard for the bug itself. Before the repair, `free0` was
// `undefined` and BOTH directions of the comparison silently answered false. If a future
// change reintroduces a missing balance, these must raise rather than quietly pass.
throws(
  "an undefined `free` raises instead of silently comparing false",
  () => assessOversell({ freeBefore: undefined, reservedBefore: 0, reservedAfter: 6 }),
  "freeBefore must be a finite number"
);
throws(
  "an undefined reservedAfter raises",
  () => assessOversell({ freeBefore: 4, reservedBefore: 0, reservedAfter: undefined }),
  "reservedAfter must be a finite number"
);
throws(
  "NaN raises — it compares false in every direction, exactly like undefined",
  () => assessOversell({ freeBefore: NaN, reservedBefore: 0, reservedAfter: 6 }),
  "freeBefore must be a finite number"
);
throws(
  "an undefined balance raises in freeUnits too",
  () => freeUnits(undefined, 0),
  "available must be a finite number"
);

// Demonstrates WHY the guard is needed, using raw JavaScript rather than the helper: both
// directions of the comparison are false, so a naive detector reports neither a violation
// nor a pass. This is what the certified harness was doing.
const poisoned = 6 > undefined || 6 <= undefined;
check(
  "an unguarded comparison against undefined answers false BOTH ways (why the guard exists)",
  poisoned === false,
  String(poisoned)
);

// ─────────────────────────────────────────────────────────────────────────────
sub("E. the runner must not accept an untrustworthy suite");

// A healthy suite: ran, reported, asserted, exited clean.
const healthy = classifySuiteResult({ name: "delivery", code: 0, reported: true, passed: 22, failed: 0 });
check("a suite that ran and asserted is accepted", healthy.length === 0, JSON.stringify(healthy));

// A suite that reported real failures and exited non-zero is red, but it is HONEST — the
// one reason is its exit code, not a trustworthiness problem.
const honestRed = classifySuiteResult({ name: "delivery", code: 1, reported: true, passed: 20, failed: 2 });
check("a suite that reports failures and exits 1 is flagged once", honestRed.length === 1, JSON.stringify(honestRed));
check("  and the reason is its exit code", honestRed[0] === "exited 1", JSON.stringify(honestRed));

// CASE A — non-zero exit.
const crashed = classifySuiteResult({ name: "delivery", code: 2, reported: true, passed: 5, failed: 0 });
check("A. a non-zero exit is rejected", crashed.includes("exited 2"), JSON.stringify(crashed));

// CASE B — THE DEAD SUITE. This is exactly what delivery.mjs did for two commits: it threw
// a ReferenceError at module evaluation, printed no summary, and was scored 0/0 alongside
// nine green suites. Before this repair the runner recorded it as passed:0 failed:0 and
// said nothing at all.
const dead = classifySuiteResult({ name: "delivery", code: 1, reported: false, passed: 0, failed: 0 });
check("B. a suite that printed no summary is rejected", dead.includes('printed no "<n> passed, <m> failed" summary'), JSON.stringify(dead));
// Both reasons, not just one: `dead.length > 0` would be implied by the line above and
// could not fail independently. Asserting exactly two catches a classifier that dropped
// the exit-code reason while keeping the summary one.
check("  and BOTH its exit code and its silence are reported", dead.length === 2, JSON.stringify(dead));

// A suite can also die silently with a SUCCESSFUL exit code — an early `process.exit(0)`,
// or output swallowed. The exit code alone would clear it; the summary check does not.
const silentZeroExit = classifySuiteResult({ name: "delivery", code: 0, reported: false, passed: 0, failed: 0 });
check("  a suite that exits 0 but printed no summary is STILL rejected", silentZeroExit.length > 0, JSON.stringify(silentZeroExit));

// CASE C — reported, exited clean, asserted nothing. Cannot be staged against a real
// database, which is precisely why it is proved here.
const empty = classifySuiteResult({ name: "delivery", code: 0, reported: true, passed: 0, failed: 0 });
check("C. a suite reporting zero assertions is rejected", empty.includes("reported zero assertions"), JSON.stringify(empty));

// ...unless it is DECLARED non-asserting. Declared, never merely observed.
const declared = classifySuiteResult({ name: "some-utility", code: 0, reported: true, passed: 0, failed: 0 }, new Set(["some-utility"]));
check("  a suite explicitly declared non-asserting is accepted", declared.length === 0, JSON.stringify(declared));
const undeclared = classifySuiteResult({ name: "delivery", code: 0, reported: true, passed: 0, failed: 0 }, new Set(["some-utility"]));
check("  the exemption applies only to the declared suite", undeclared.length > 0, JSON.stringify(undeclared));

// CASE D — a suite that printed failures and then claimed success.
const liar = classifySuiteResult({ name: "delivery", code: 0, reported: true, passed: 3, failed: 4 });
check("D. a suite reporting failures but exiting 0 is rejected", liar.includes("reported 4 failure(s) but exited 0"), JSON.stringify(liar));

// ─────────────────────────────────────────────────────────────────────────────
section("HARNESS SELF-TEST");
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) console.log("FAILURES:\n  - " + failures.join("\n  - "));
process.exit(fail === 0 ? 0 : 1);
