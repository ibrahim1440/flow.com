/**
 * The rule for a manual stock adjustment's reason.
 *
 * A manual adjustment is a person overruling the system's idea of what is physically on the
 * shelf. It is the one inventory movement with no document behind it — no purchase, no
 * roast, no packing, no delivery — so the reason IS the document. It was optional on both
 * adjustment routes, which meant the ledger could carry an unexplained correction of any
 * size: attributable to a person, but not to anything that person could later be asked
 * about. "Stock count 12 March, two bags found behind the pallet" and silence are not the
 * same entry, and only one of them can be reconciled a month later.
 *
 * Pure and shared so the green-coffee route and the packaging-material route cannot drift
 * apart on what counts as an explanation, and so every case can be exercised with no server
 * and no database.
 *
 * Deliberately NOT applied to system-generated movements. A roast, a pack, a delivery or a
 * purchase each already carry a source document and a source id; demanding prose from them
 * would be asking a machine to justify arithmetic.
 */

export const ADJUSTMENT_REASON_MAX_LENGTH = 500;

/**
 * Eight characters: long enough to exclude "ok", "fix" and a stray keystroke, short enough
 * to accept a real one like "recount" plus a date. It is a floor against absent-mindedness,
 * not an attempt to legislate meaning — no length check can tell a good reason from a bad
 * one, and pretending otherwise would only teach people to type eight spaces.
 */
export const ADJUSTMENT_REASON_MIN_LENGTH = 8;

export type AdjustmentReasonDecision =
  | { ok: true; reason: string }
  | { ok: false; message: string };

export function normalizeAdjustmentReason(raw: unknown): AdjustmentReasonDecision {
  const reason = typeof raw === "string" ? raw.trim() : "";

  if (!reason) {
    return {
      ok: false,
      message:
        "A reason is required for a manual stock adjustment — it is the only record of why " +
        "the counted quantity differs from the system's.",
    };
  }
  if (reason.length < ADJUSTMENT_REASON_MIN_LENGTH) {
    return {
      ok: false,
      message:
        `The reason must be at least ${ADJUSTMENT_REASON_MIN_LENGTH} characters — enough for ` +
        "somebody reconciling this later to know what happened.",
    };
  }
  if (reason.length > ADJUSTMENT_REASON_MAX_LENGTH) {
    return {
      ok: false,
      message: `The reason must be at most ${ADJUSTMENT_REASON_MAX_LENGTH} characters.`,
    };
  }

  return { ok: true, reason };
}
