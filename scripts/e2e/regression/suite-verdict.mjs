// Is a finished suite trustworthy? Pure decision logic for run-all.mjs.
//
// PURE BY CONSTRUCTION: no imports, no I/O. It lives outside run-all.mjs for one reason —
// run-all.mjs runs the whole regression suite at import time, so nothing can import it to
// test it. Extracting the verdict is what makes the runner's own correctness provable by
// harness-selftest.mjs, on every run, with no database.
//
// ── The hole this closes ─────────────────────────────────────────────────────
// run-all.mjs scraped "<n> passed, <m> failed" out of a suite's output and, when the
// regex did not match, recorded `passed: 0, failed: 0`. A suite that crashed at import —
// as delivery.mjs did for two commits, on a ReferenceError — was therefore recorded as
// having run and asserted nothing, which is indistinguishable in the summary from a suite
// that legitimately had nothing to say. Ten green rows and one silent hole looked the
// same as eleven green rows.
//
// The verdict below refuses all three shapes of that failure, and a fourth: a suite that
// reports failures and then claims success with its exit code.

/**
 * @param {{name: string, code: number, reported: boolean, passed: number, failed: number}} r
 *        `reported` MUST mean "a summary line was matched on stdout", not "the process
 *        produced output" — that distinction is the entire point of the check.
 * @param {Set<string>} zeroAssertionOk  suites explicitly declared as non-asserting
 * @returns {string[]} reasons the suite is not trustworthy; empty means it is
 */
export function classifySuiteResult(r, zeroAssertionOk = new Set()) {
  const reasons = [];

  // A. The suite itself said it failed, or died.
  if (r.code !== 0) reasons.push(`exited ${r.code}`);

  if (!r.reported) {
    // B. It never printed a summary — a crash at import, a fatal throw, or an exit on an
    // early path. This is the case that used to be silently scored 0/0.
    reasons.push('printed no "<n> passed, <m> failed" summary');
  } else if (r.passed + r.failed === 0 && !zeroAssertionOk.has(r.name)) {
    // C. It reported, but asserted nothing. A regression suite that tests nothing is not
    // a passing suite. Being non-asserting has to be declared, not merely observed.
    reasons.push("reported zero assertions");
  } else if (r.failed > 0 && r.code === 0) {
    // D. It reported failures and still exited successfully. Its own exit logic is wrong,
    // and trusting the exit code alone would bury the failures it just printed.
    reasons.push(`reported ${r.failed} failure(s) but exited 0`);
  }

  return reasons;
}
