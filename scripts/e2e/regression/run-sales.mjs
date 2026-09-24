#!/usr/bin/env node
// Runs the Sales CRM & Commissions suites, in the order that makes a failure readable.
//
// A separate runner from run-all.mjs on purpose. The five suites below refuse to touch any
// database except the verified preview one, and the operational regression runs against a
// different database entirely — so registering them in one list would give whichever runner
// you invoked a guaranteed refusal. Two runners, two targets, one explicit boundary.
//
//   npm run regression          the 26 operational suites, against the regression database
//   npm run regression:sales    the 5 suites below, against sales_crm_preview
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Cheapest and most specific first: an arithmetic failure is far easier to read than the
// same wrong figure surfacing inside a fifteen-step workflow.
const SUITES = [
  "commission-engine",      // pure arithmetic — no database, no HTTP
  "quotes-domain",          // quotation pricing, lifecycle and CSV — no database, no HTTP
  "sales-commissions-db",   // constraints, concurrency, rollback — real PostgreSQL
  "sales-security",         // what is refused — real HTTP API
  "sales-workflow",         // the ordinary path, end to end — real HTTP API
];

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const list = only.length ? SUITES.filter((s) => only.includes(s)) : SUITES;
if (only.length && list.length !== only.length) {
  console.error(`Unknown suite: ${only.filter((o) => !SUITES.includes(o)).join(", ")}`);
  console.error(`Available: ${SUITES.join(", ")}`);
  process.exit(2);
}

const run = (name) =>
  new Promise((resolve) => {
    let out = "";
    const child = spawn(process.execPath, [path.join(HERE, `${name}.mjs`)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    child.on("close", (code) => {
      // Read the count out of the suite's own summary line rather than trusting the exit
      // code alone: a suite that crashes before asserting anything exits non-zero, and a
      // suite that exits zero having asserted nothing is the more dangerous of the two.
      const m = out.match(/(\d+) passed, (\d+) failed/);
      resolve({
        name,
        code,
        passed: m ? Number(m[1]) : 0,
        failed: m ? Number(m[2]) : 0,
        reported: Boolean(m),
      });
    });
  });

const results = [];
for (const name of list) {
  console.log(`\n${"#".repeat(78)}\n#  ${name}\n${"#".repeat(78)}`);
  results.push(await run(name));
}

console.log(`\n${"=".repeat(78)}\n  SALES REGRESSION SUMMARY\n${"=".repeat(78)}`);
let ok = true;
let passed = 0;
for (const r of results) {
  const verdict = !r.reported
    ? "NO SUMMARY — the suite did not report, which is a failure whatever its exit code"
    : r.failed > 0
      ? `${r.failed} FAILED`
      : r.passed === 0
        ? "ZERO ASSERTIONS — a suite that asserts nothing proves nothing"
        : `${r.passed} passed`;
  if (!r.reported || r.failed > 0 || r.passed === 0 || r.code !== 0) ok = false;
  passed += r.passed;
  console.log(`  ${r.name.padEnd(24)} ${verdict}`);
}
console.log(`\n  ${passed} assertions across ${results.length} suites`);
console.log(ok ? "  ALL SALES SUITES GREEN\n" : "  SALES SUITES NOT GREEN\n");
process.exit(ok ? 0 : 1);
