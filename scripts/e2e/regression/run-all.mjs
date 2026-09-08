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

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Order matters only in that the cheapest, most specific suites come first: a failure in
// the production gate is easier to read than the same failure surfacing inside a full
// order-to-delivery run twenty minutes later.
const SUITES = [
  "production-gate",         // Production Entry Gate: approval/review required before production
  "production-concurrency",  // the gate under concurrent lifecycle transitions
  "lifecycle-locks",         // canonical lock order; deadlock freedom
  "completion-gate",         // DEF-001: an order completes only once every line has shipped
  "reservation-cas",         // reservation compare-and-swap; no double reservation
  "po-lifecycle",            // Production Order state machine, batches, cancellation
  "hardening",               // concurrency, idempotency, forced rollback, security smoke
  "finished-products",       // units, lots, packaging paths
  "delivery",                // dispatch, partial and full
  "order-to-delivery",       // end-to-end happy and unhappy paths
  "release-simulation",      // a second end-to-end pass on different data
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
    let out = "";
    child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    child.on("close", (code) => {
      // Each suite prints "<n> passed, <m> failed" as its last summary line.
      const m = [...out.matchAll(/^(\d+) passed, (\d+) failed/gm)].pop();
      resolve({ name, code, passed: m ? Number(m[1]) : 0, failed: m ? Number(m[2]) : 0 });
    });
  });

const results = [];
for (const name of list) {
  console.log(`\n${"#".repeat(78)}\n#  ${name}\n${"#".repeat(78)}`);
  results.push(await run(name));
}

console.log(`\n${"=".repeat(78)}\n  REGRESSION SUMMARY\n${"=".repeat(78)}`);
let totalPassed = 0, totalFailed = 0, red = 0;
for (const r of results) {
  totalPassed += r.passed;
  totalFailed += r.failed;
  if (r.code !== 0) red++;
  console.log(
    `  ${r.name.padEnd(24)} ${String(r.passed).padStart(4)} passed  ${String(r.failed).padStart(3)} failed  exit ${r.code}`
  );
}
console.log(`\n  ${results.length} suite(s), ${totalPassed} harness assertions, ${totalFailed} failed`);
console.log(red === 0 ? "  ALL SUITES GREEN\n" : `  ${red} SUITE(S) RED\n`);
process.exit(red === 0 ? 0 : 1);
