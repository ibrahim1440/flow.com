// Runs the backend regression suites in order and reports one summary.
//
// Serially, deliberately. Every suite drives the same database and the same stock pool, and
// several of them assert on global inventory invariants at the end. Running two at once
// makes those assertions read another suite's data and fail for reasons that have nothing
// to do with the code under test — which is exactly what happened the first time they were
// run concurrently during certification.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
// Pure. Extracted so the runner's own trustworthiness check is testable — this file runs
// the entire regression suite at import time and so can never be imported by a test.
import { classifySuiteResult } from "./suite-verdict.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Order matters only in that the cheapest, most specific suites come first: a failure in
// the production gate is easier to read than the same failure surfacing inside a full
// order-to-delivery run twenty minutes later.
const SUITES = [
  "harness-selftest",        // proves the detector fires and the runner rejects dead suites — pure, no DB
  "production-gate",         // Production Entry Gate: approval/review required before production
  "production-concurrency",  // the gate under concurrent lifecycle transitions
  "lifecycle-locks",         // canonical lock order; deadlock freedom
  "reservation-cas",         // reservation compare-and-swap; no double reservation
  "packaging-stock",         // kilogram packaging arithmetic, roasted draw-down, availability
  "packaging-concurrency",   // canonical lot lock order; one packaging method per roast
  "packaging-idempotency",   // operation identity: replay, mismatch, retry-after-rollback
  "packaging-identity",      // coffee identity fail-closed; SKU auto-reservation to the owning line
  "production-demand",       // canonical demand truth; surplus gate; green-vs-finished; PO traceability
  "po-lifecycle",            // Production Order state machine, batches, cancellation
  "hardening",               // concurrency, idempotency, forced rollback, security smoke
  "finished-products",       // units, lots, packaging paths
  "delivery",                // dispatch, partial and full
  "order-to-delivery",       // end-to-end happy and unhappy paths
  "release-simulation",      // a second end-to-end pass on different data
  // LAST, deliberately: this one empties the whole database, which is the behaviour under
  // test. Nothing downstream may depend on what it removes.
  "reset-safety",            // reset atomicity + the destructive-reset environment boundary
];

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const list = only.length ? SUITES.filter((s) => only.includes(s)) : SUITES;

if (only.length && list.length !== only.length) {
  const unknown = only.filter((o) => !SUITES.includes(o));
  console.error(`Unknown suite(s): ${unknown.join(", ")}`);
  console.error(`Available: ${SUITES.join(", ")}`);
  process.exit(2);
}

const run = (name) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, `${name}.mjs`)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    // Only STDOUT feeds the summary match. Folding stderr into the same buffer meant any
    // text a suite wrote to stderr could satisfy the summary regex, so a suite could be
    // counted as having reported when it had not. stderr is still echoed live — never
    // hidden — it simply no longer counts as a report.
    let out = "";
    child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { process.stderr.write(d); });
    child.on("close", (code) => {
      // Each suite prints "<n> passed, <m> failed" as its last summary line.
      const m = [...out.matchAll(/^(\d+) passed, (\d+) failed/gm)].pop();
      // `reported` is the point: a suite that died before printing a summary used to be
      // indistinguishable from one that genuinely ran zero assertions, and both were
      // silently counted as 0/0.
      resolve({
        name,
        code,
        reported: m !== undefined,
        passed: m ? Number(m[1]) : 0,
        failed: m ? Number(m[2]) : 0,
      });
    });
  });

/**
 * Suites that are expected to assert nothing.
 *
 * Deliberately empty: every registered suite asserts, and the one non-assertion file in
 * this directory (catalog.mjs, a fixture builder) is not registered as a suite at all.
 * It exists so that a genuine future utility can be declared here EXPLICITLY rather than
 * by silently reporting zero.
 */
const ZERO_ASSERTION_OK = new Set();

const results = [];
for (const name of list) {
  console.log(`\n${"#".repeat(78)}\n#  ${name}\n${"#".repeat(78)}`);
  results.push(await run(name));
}

console.log(`\n${"=".repeat(78)}\n  REGRESSION SUMMARY\n${"=".repeat(78)}`);
let totalPassed = 0, totalFailed = 0;
const bad = [];
for (const r of results) {
  totalPassed += r.passed;
  totalFailed += r.failed;

  // A suite is only trustworthy if it ran, said what it did, and said something.
  const reasons = classifySuiteResult(r, ZERO_ASSERTION_OK);
  if (reasons.length) bad.push({ name: r.name, reasons });

  const status = reasons.length === 0 ? "ok" : reasons.join("; ");
  console.log(
    `  ${r.name.padEnd(24)} ${String(r.passed).padStart(4)} passed  ${String(r.failed).padStart(3)} failed  exit ${r.code}  ${status}`
  );
}
console.log(`\n  ${results.length} suite(s), ${totalPassed} harness assertions, ${totalFailed} failed`);

if (bad.length === 0) {
  console.log("  ALL SUITES GREEN\n");
} else {
  // Name them. A summary that says only "1 SUITE(S) RED" makes the reader hunt through
  // scrollback for which one, and a suite that died silently leaves nothing to find.
  console.log(`  ${bad.length} SUITE(S) NOT TRUSTWORTHY:`);
  for (const b of bad) console.log(`    - ${b.name}: ${b.reasons.join("; ")}`);
  console.log("");
}

// exitCode rather than process.exit: on Windows, stdout to a pipe is asynchronous, and an
// immediate exit can truncate the very summary above when the run is captured or teed.
// Every child has already closed, so nothing holds the loop open and the process still
// exits promptly with the same status.
process.exitCode = bad.length === 0 ? 0 : 1;
