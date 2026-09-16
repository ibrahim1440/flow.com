import { createHash } from "node:crypto";

/**
 * Making one dispatch happen once.
 *
 * The delivery route had no request identity at all. A retry after an ambiguous outcome —
 * the commit succeeded, the response never arrived — created a second Delivery row, applied
 * the quantity a second time and consumed the stock a second time. The ordered-quantity
 * check bounded how much damage a retry could do; it never noticed that the retry WAS the
 * first request. Bounded damage is not idempotency.
 *
 * ── Why the key is required here, unlike packaging ─────────────────────────
 * Packaging accepts a keyless caller and mints `srv-<uuid>` so the operation still has an
 * audit identity, because callers predating that control had to keep working. Delivery has
 * exactly one caller and it is being updated in the same wave, so a keyless path would only
 * preserve the non-idempotent execution it exists to remove. Absent key is a 400.
 *
 * ── One canonical object, hashed and executed ──────────────────────────────
 * The hash is taken over the same normalized values the operation then persists and spends.
 * Hashing one number and writing another would mean a retry with identical intent could
 * produce a different hash — or worse, that a replay returns a row describing something
 * other than what was done.
 */

const IDEMPOTENCY_HEADER = "Idempotency-Key";
const KEY_MAX_LENGTH = 200;

/** The certified dialect, shared with packaging so the codebase has one key grammar. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type DeliveryKey =
  | { ok: true; key: string }
  | { ok: false; message: string };

/**
 * Surrounding whitespace is trimmed and the trimmed value IS the key; interior whitespace is
 * refused by the charset. Trimming rather than rejecting is deliberate: a retry that arrives
 * padded should still be recognised as the same operation, which is the entire point.
 */
export function readDeliveryRequestKey(request: Request): DeliveryKey {
  const raw = request.headers.get(IDEMPOTENCY_HEADER);

  if (raw === null || raw.trim() === "") {
    return {
      ok: false,
      message:
        `${IDEMPOTENCY_HEADER} is required. A dispatch must carry a key so a retry can be ` +
        "recognised instead of shipping the goods twice.",
    };
  }

  const key = raw.trim();
  if (key.length > KEY_MAX_LENGTH) {
    return { ok: false, message: `${IDEMPOTENCY_HEADER} must be at most ${KEY_MAX_LENGTH} characters.` };
  }
  if (!KEY_PATTERN.test(key)) {
    return {
      ok: false,
      message: `${IDEMPOTENCY_HEADER} may contain only letters, digits, and the characters . _ : -`,
    };
  }
  return { ok: true, key };
}

/** Gram-level precision, matching every other kilogram figure in this system. */
export const roundKg = (v: number): number => Number(v.toFixed(3));

export type DeliveryIntent = {
  orderItemId: string;
  finishedGoodsLotId: string;
  deliveryType: string;
  quantityUnits: number | null;
  quantityKg: number | null;
  notes: string | null;
};

export type IntentDecision =
  | { ok: true; intent: DeliveryIntent }
  | { ok: false; message: string };

/**
 * Turn a request body into the one canonical description of the dispatch.
 *
 * Exactly one quantity axis is required. An irrelevant second one is refused rather than
 * ignored, because silently dropping it would let two callers describe the same physical
 * dispatch with two different bodies — and therefore two different hashes, defeating the
 * key. Which axis is CORRECT for the line is decided later against the authoritative
 * OrderItem; a request on the wrong axis is refused and never commits, so it can never bind
 * a key.
 */
export function normalizeDeliveryIntent(body: Record<string, unknown>): IntentDecision {
  const orderItemId = typeof body.orderItemId === "string" ? body.orderItemId.trim() : "";
  if (!orderItemId) return { ok: false, message: "orderItemId is required." };

  const finishedGoodsLotId =
    typeof body.finishedGoodsLotId === "string" ? body.finishedGoodsLotId.trim() : "";
  if (!finishedGoodsLotId) {
    return { ok: false, message: "A finished goods lot is required for all deliveries." };
  }

  const deliveryType =
    typeof body.deliveryType === "string" ? body.deliveryType.trim().toLowerCase() : "";
  if (deliveryType !== "full" && deliveryType !== "partial") {
    return { ok: false, message: 'deliveryType must be either "full" or "partial".' };
  }

  const hasUnits = body.quantityUnits !== undefined && body.quantityUnits !== null;
  const hasKg = body.quantityKg !== undefined && body.quantityKg !== null;

  if (hasUnits && hasKg) {
    return {
      ok: false,
      message:
        "Supply exactly one of quantityUnits or quantityKg — the line decides which one " +
        "applies, and sending both leaves the dispatch ambiguous.",
    };
  }
  if (!hasUnits && !hasKg) {
    return { ok: false, message: "Supply exactly one of quantityUnits or quantityKg." };
  }

  let quantityUnits: number | null = null;
  let quantityKg: number | null = null;

  if (hasUnits) {
    const units = Number(body.quantityUnits);
    if (!Number.isInteger(units) || units <= 0) {
      return { ok: false, message: "quantityUnits must be a whole number greater than zero." };
    }
    quantityUnits = units;
  } else {
    const kg = Number(body.quantityKg);
    if (!Number.isFinite(kg) || kg <= 0) {
      return { ok: false, message: "quantityKg must be a positive number." };
    }
    // Rounded ONCE, here. This same number is hashed, persisted on the Delivery, applied to
    // the delivered total, drawn from the lot and written to the ledger.
    quantityKg = roundKg(kg);
  }

  const rawNotes = typeof body.notes === "string" ? body.notes.trim() : "";

  return {
    ok: true,
    intent: {
      orderItemId,
      finishedGoodsLotId,
      deliveryType,
      quantityUnits,
      quantityKg,
      notes: rawNotes === "" ? null : rawNotes,
    },
  };
}

/**
 * SHA-256 over a FIXED-POSITION array, never raw JSON.
 *
 * Property order in an object literal is not part of its meaning, but it is part of its
 * serialization — hashing JSON would let a reordered body look like a different dispatch.
 * `notes` is included because it is caller-supplied and persisted: a retry that changes it is
 * asking for something different, and must be told so rather than silently replayed.
 */
export function deliveryIntentHash(intent: DeliveryIntent): string {
  const positional = [
    intent.orderItemId,
    intent.finishedGoodsLotId,
    intent.deliveryType,
    intent.quantityUnits,
    intent.quantityKg,
    intent.notes,
  ];
  return createHash("sha256").update(JSON.stringify(positional)).digest("hex");
}
