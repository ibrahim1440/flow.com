/**
 * Client-side naming of one packaging operation.
 *
 * The server cannot tell a double submit from a genuine second partial pack by looking at
 * the payload — packing 2 kg of a roast twice is ordinary work — so the caller has to say
 * which it meant. That makes the key's LIFETIME, not its format, the thing that has to be
 * right, and the reason this lives in its own module rather than inline in the page: the
 * rules below are asserted directly by harness-selftest, against this file, with no
 * browser and no database.
 *
 * Deliberately dependency-free and framework-free.
 */

/**
 * A cryptographically strong v4 UUID.
 *
 * Two sources, in order of preference, and no weak third. `randomUUID` is restricted to
 * secure contexts, and this ERP is reachable over plain http inside the roastery, so the
 * fallback matters — but `getRandomValues` is available in every context and is just as
 * strong, so the fallback costs nothing in quality.
 *
 * If neither exists this THROWS rather than reaching for Math.random. A weak key is worse
 * than no key: two operations that collide would make the second one silently answer with
 * the first one's result, which is a pack that the operator believes happened and did not.
 * Failing loudly at the point of generation is the safe direction.
 */
export function newRequestKey(): string {
  const c: Crypto | undefined = globalThis.crypto;

  if (c && typeof c.randomUUID === "function") return c.randomUUID();

  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 1
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  throw new Error(
    "No cryptographic random source is available, so no idempotency key can be generated."
  );
}

/**
 * Statuses that say nothing about whether the operation ran.
 *
 * Each of these can be produced by something between the browser and the packaging
 * transaction rather than by the transaction itself, which means the pack may well have
 * committed:
 *
 *   408 Request Timeout   — the request was abandoned in flight; the server may still have
 *                           finished the work after giving up on the connection.
 *   425 Too Early         — refused at the TLS layer, before any application code decided
 *                           anything, but a replayed early-data request may also have been
 *                           accepted on a previous attempt.
 *   429 Too Many Requests — a rate limiter that may sit in front of the application, and
 *                           that this ERP also applies inside it; either way it is a
 *                           "try again", not "this did not happen".
 *
 * A new key here would be the worst possible response: it would turn an infrastructure
 * hiccup into a second, genuinely separate packaging operation, and the roast would be
 * drawn down twice.
 */
const AMBIGUOUS_STATUSES = new Set([408, 425, 429]);

/**
 * Did the server definitively decide the fate of this operation?
 *
 * Fail-safe by construction: only two bands are treated as conclusive, and everything else
 * — 3xx, the ambiguous statuses above, every 5xx, and any status this code has never heard
 * of — keeps the key. Being wrong in that direction costs a 422 the operator can recover
 * from; being wrong in the other direction double-packs a roast.
 */
export function isConclusiveResponse(status: number): boolean {
  if (status >= 200 && status < 300) return true; // it ran, and the answer is stored
  if (status >= 400 && status < 500 && !AMBIGUOUS_STATUSES.has(status)) {
    // A deterministic refusal from the application itself: validation, authorization, the
    // status gate, an idempotency-key mismatch. All of these throw before or inside the
    // transaction, so nothing was written and the operator is free to correct and resubmit.
    return true;
  }
  return false;
}

export type RequestKeyHolder = {
  /** The key for an attempt at the current operation, minted on first use. */
  keyForAttempt(): string;
  /** Report the status an attempt came back with; retires the key only if it was conclusive. */
  recordResponse(status: number): void;
  /** Abandon the current operation outright, whatever its state. */
  abandon(): void;
  /** The key currently held, or null when no operation is in flight. Diagnostics and tests. */
  current(): string | null;
};

/**
 * Holds the key for the operation the operator is currently performing.
 *
 * One operation gets one key, however many attempts it takes:
 *
 *   - the key is minted lazily on the first attempt, so nothing is generated for a form
 *     that is opened and closed again;
 *   - it is RETAINED while the outcome is unknown — no response at all, a 5xx, or one of
 *     the ambiguous statuses listed above, every one of which can mean the pack committed
 *     and the answer was lost on the way back. A retry then carries the same key and the
 *     server recognises it instead of packing twice;
 *   - it is RETIRED once the server has definitively decided, which includes a refusal: a
 *     4xx means nothing was written, so the operator is free to correct the quantity and
 *     submit again as a genuinely new operation. Keeping the key across a refusal would
 *     turn that correction into a 422 hash mismatch, which is the opposite of helpful.
 *
 * "Did the server decide?" — not "was it an error?" — is the whole distinction, and it is
 * why this is a small state machine rather than a variable assigned next to a fetch call.
 * Most 4xx answers are decisions and retire the key; 408, 425 and 429 are 4xx answers that
 * decide nothing and keep it.
 *
 * The holder is not tied to one batch, and does not need to be: the server scopes a key to
 * (batchId, requestKey), so a key left over from an abandoned attempt on one roast cannot
 * be mistaken for an operation on another.
 */
export function createRequestKeyHolder(): RequestKeyHolder {
  let key: string | null = null;

  return {
    keyForAttempt() {
      if (key === null) key = newRequestKey();
      return key;
    },
    recordResponse(status: number) {
      // Only a conclusive answer retires the key. Anything ambiguous — and, by never
      // calling this at all, a dropped connection — leaves the operation unresolved and the
      // key in place, so the next attempt is recognised as the same operation.
      if (isConclusiveResponse(status)) key = null;
    },
    abandon() {
      key = null;
    },
    current() {
      return key;
    },
  };
}
