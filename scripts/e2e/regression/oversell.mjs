// Over-reservation arithmetic for the regression harness.
//
// PURE BY CONSTRUCTION: no imports, no I/O, no database, no side effects. That is the
// whole point of the file — the oversell detector can be proved to fire against synthetic
// numbers, with nothing running and nothing to set up. See harness-selftest.mjs.
//
// ── Why this is a module and not two inline expressions ──────────────────────
// There is deliberately ONE definition, used by both places that need it:
//
//   harness.mjs  skuUnits()          — computes the `free` figure every suite reads
//   order-to-delivery.mjs section F  — decides whether a race oversold finished goods
//
// A private copy inside the self-test would prove only that the copy works. Routing the
// shipped path through the same functions is what makes the proof mean anything.
//
// ── The defect this file was written for ─────────────────────────────────────
// skuUnits() used to return { produced, available, reserved } while four committed
// assertions read `.free`. Reading a key that does not exist is not an error in
// JavaScript: it yields `undefined`, and `undefined` poisons every comparison it touches
// SILENTLY — `gained <= undefined` is false, and so is `gained > undefined`. The result
// was a permanently red assertion sitting next to an oversell detector that could never
// fire, in a suite that was believed to be certifying inventory safety.
//
// The guard below is the direct answer to that: these functions refuse a missing or
// non-finite balance loudly instead of quietly answering "no". A comparison that cannot
// be trusted must raise, not return false.

/**
 * Reject exactly the class of value that caused the original defect.
 *
 * `undefined` is the one that matters, but NaN behaves identically in comparisons (every
 * relational operator against NaN is false), and a numeric string would compare by
 * coercion in some positions and not others. All three are refused.
 */
function requireBalance(label, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    // String(value) rather than JSON.stringify: stringify renders BOTH NaN and Infinity as
    // "null", which would point a reader at the wrong bug. Strings are quoted so that the
    // numeric-string case ("4") is still distinguishable from the number 4.
    const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
    throw new TypeError(
      `${label} must be a finite number, received ${shown}. A missing balance makes every ` +
        "comparison against it false, which reads as \"nothing is wrong\" — that is the " +
        "defect this guard exists to prevent."
    );
  }
}

/**
 * Free-to-promise, defined exactly as the application defines it.
 *
 * unitsAvailable - unitsReserved (see prisma/schema.prisma, and the CAS guard in
 * src/lib/services/finished-products.ts). `available` is total stock ON HAND INCLUDING
 * what is reserved — reserving raises `reserved` alone and never lowers `available`,
 * which is why the subtraction is the right expression.
 *
 * WHOLE UNITS ONLY. Both live callers pass integers (`::int` in skuUnits, and integer
 * allocation sums in section F), so the comparisons below are exact. The kilogram pair
 * availableQty/reservedQty follows the same rule arithmetically but is FLOAT: 0.1 + 0.2
 * exceeds 0.3 by 5.6e-17, which is enough to report a spurious oversell. A kg caller must
 * introduce a tolerance first — the rest of this harness uses `near(a, b, tol)` — rather
 * than reusing these functions as they stand.
 *
 * DELIBERATELY NOT CLAMPED AT ZERO. A negative result means reserved exceeded available,
 * which is precisely the over-reservation these suites exist to catch. Math.max(0, ...)
 * would convert that evidence into a plausible-looking 0.
 */
export function freeUnits(available, reserved) {
  requireBalance("available", available);
  requireBalance("reserved", reserved);
  return available - reserved;
}

/**
 * Did a set of concurrent reservations take more stock than was free?
 *
 * `gained` is signed on purpose: concurrent work that NET RELEASES stock produces a
 * negative gain, and that is not an oversell. Only taking strictly more than was free is.
 *
 * The comparison is strict (`>`): consuming exactly the free stock is the correct,
 * expected outcome of a race that the reservation guards handled properly, not a defect.
 *
 * @param {{freeBefore: number, reservedBefore: number, reservedAfter: number}} snapshot
 * @returns {{gained: number, freeBefore: number, oversold: boolean, overage: number}}
 */
export function assessOversell({ freeBefore, reservedBefore, reservedAfter }) {
  requireBalance("freeBefore", freeBefore);
  requireBalance("reservedBefore", reservedBefore);
  requireBalance("reservedAfter", reservedAfter);

  const gained = reservedAfter - reservedBefore;
  const oversold = gained > freeBefore;
  return { gained, freeBefore, oversold, overage: oversold ? gained - freeBefore : 0 };
}
