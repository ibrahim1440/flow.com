/**
 * What a PIN is.
 *
 * One rule, in one place, applied by every path that sets or checks one: employee create,
 * admin employee edit, self-service change, login, and the PIN re-verification that guards
 * the destructive resets. Five paths previously agreed only that a PIN was "at least 4
 * characters", and only two of them said so in the same words.
 *
 * ── Exactly six digits ─────────────────────────────────────────────────────
 * Not four: 10^4 is small enough that the rate limiting is doing all of the work. Not eight,
 * and not a range: this is a wall-mounted pad an operator taps between roasts, the login
 * screen submits the moment the last digit lands, and a variable length makes that
 * impossible — a 6-digit PIN would submit before a 7-digit one could be finished. A PIN
 * people cannot remember becomes a PIN written on the wall, which is a worse control than a
 * shorter one. Six digits with an auto-submitting pad is the shape that stays usable.
 *
 * ── Never a number ─────────────────────────────────────────────────────────
 * "012345" is a valid PIN and must survive as the string "012345". Parsing it as an integer
 * silently becomes 12345, which is a different, shorter credential — and one that would then
 * hash and look up differently on every path that happened to parse it.
 *
 * ── Whitespace is rejected, not trimmed ────────────────────────────────────
 * A credential is never silently transformed. Trimming would mean " 012345" and "012345"
 * authenticate the same account while being different strings, and the lookup, the verifier
 * and the rate-limit identifier would each have to agree on where the trimming happened.
 * Rejecting keeps one input string mapping to exactly one verifier and one lookup.
 */

export const PIN_LENGTH = 6;

/** Deliberately ASCII 0-9 only: \d in a Unicode regex also matches Arabic-Indic digits. */
const PIN_PATTERN = /^[0-9]{6}$/;

export type PinDecision =
  | { ok: true; pin: string }
  | { ok: false; message: string };

export const PIN_FORMAT_MESSAGE = `PIN must be exactly ${PIN_LENGTH} digits.`;

export function validatePin(raw: unknown): PinDecision {
  if (typeof raw !== "string" || !PIN_PATTERN.test(raw)) {
    return { ok: false, message: PIN_FORMAT_MESSAGE };
  }
  return { ok: true, pin: raw };
}

export function isValidPin(raw: unknown): raw is string {
  return typeof raw === "string" && PIN_PATTERN.test(raw);
}
