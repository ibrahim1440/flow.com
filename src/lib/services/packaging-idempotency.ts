import { createHash, randomUUID } from "node:crypto";
// Type-only: Prisma is referenced solely in type positions here. Written as `import type`
// so the module carries no runtime dependency on the generated client, which is what lets
// harness-selftest import and exercise the real key validator with no build step and no
// database — see the request-key section there.
import type { Prisma } from "@/generated/prisma/client";

type PrismaTx = Prisma.TransactionClient;

/**
 * Operation-level idempotency for packaging.
 *
 * Packaging cannot be made idempotent by looking at the payload, because packing a roast in
 * several goes is ordinary work: two requests to pack 2 kg of the same batch are EITHER a
 * retry of one operation OR two genuine partial packs, and nothing in the payload
 * distinguishes them. Only the caller knows which it meant, so the caller names the
 * operation and the key is what identity is built on.
 *
 * That is also why the key cannot live on RoastingBatch. One key per batch would make the
 * second partial pack indistinguishable from a replay of the first.
 */

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

const KEY_MAX_LENGTH = 200;
// Letters, digits and a few separators. Deliberately narrow: it excludes control characters,
// newlines and quotes, so a key can never break a log line or be read back as markup. The key
// is never interpolated into a log message anyway — see the note on recordOperation.
const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type RequestKey =
  | { ok: true; key: string; clientSupplied: boolean }
  | { ok: false; message: string };

/**
 * Read and validate the Idempotency-Key header.
 *
 * TRANSITIONAL: a caller that sends no key still gets an operation row, under a
 * server-generated key. That preserves the audit identity of every packaging operation from
 * this wave onwards, but it does NOT protect that caller from double submission — a retry
 * arrives without the original key and so cannot be recognised. Only a client-supplied key
 * buys retry protection, which is why `clientSupplied` is reported rather than hidden.
 */
export function readRequestKey(request: Request): RequestKey {
  const raw = request.headers.get(IDEMPOTENCY_HEADER);

  if (raw === null || raw.trim() === "") {
    return { ok: true, key: `srv-${randomUUID()}`, clientSupplied: false };
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
  return { ok: true, key, clientSupplied: true };
}

/** The normalised intent of a kilogram pack — exactly the client-controlled inputs. */
export type KgIntent = {
  method: "KG";
  batchId: string;
  bags3kg: number;
  bags1kg: number;
  bags250g: number;
  bags150g: number;
  samplesGrams: number;
  productId: string | null;
  productSkuId: string | null;
};

/** The normalised intent of a unit pack. */
export type UnitIntent = {
  method: "UNIT";
  batchId: string;
  productSkuId: string;
  units: number;
};

/**
 * A deterministic hash of what the caller ASKED FOR.
 *
 * Hashed from a fixed-position array rather than an object, so JSON property order cannot
 * change the result — the raw request text is never hashed. It covers the method, the batch
 * and the client-controlled business inputs, and deliberately excludes anything the server
 * or the clock decides: no timestamps, no generated ids, no response fields, and no current
 * inventory state. Two submissions with the same intent must hash the same however they were
 * serialised, and a submission whose intent differs must not.
 */
export function packagingRequestHash(intent: KgIntent | UnitIntent): string {
  const canonical =
    intent.method === "KG"
      ? JSON.stringify([
          "KG",
          intent.batchId,
          intent.bags3kg,
          intent.bags1kg,
          intent.bags250g,
          intent.bags150g,
          intent.samplesGrams,
          intent.productId,
          intent.productSkuId,
        ])
      : JSON.stringify(["UNIT", intent.batchId, intent.productSkuId, intent.units]);

  return createHash("sha256").update(canonical).digest("hex");
}

/** Thrown when a stored operation should be replayed instead of executed. */
export type ReplaySignal = { _replayStatus: number; _replayBody: unknown };

export function isReplaySignal(err: unknown): err is ReplaySignal {
  return typeof err === "object" && err !== null && "_replayStatus" in err;
}

/**
 * The mandatory in-transaction idempotency check.
 *
 * Call this immediately AFTER the RoastingBatch row lock and before any eligibility work.
 * Its position is the whole design: the batch lock is already the serialisation point for
 * packaging, so two concurrent retries of one submit queue there, and the second sees the
 * first's committed row rather than racing it. No lock is taken on the operation row itself,
 * so nothing here can create a wait that points back at RoastingBatch and invert the
 * certified hierarchy.
 *
 * Throws rather than returning a verdict so that neither caller can forget to act on it.
 */
export async function guardIdempotency(
  tx: PrismaTx,
  batchId: string,
  requestKey: string,
  requestHash: string,
): Promise<void> {
  const existing = await tx.packagingOperation.findUnique({
    where: { batchId_requestKey: { batchId, requestKey } },
    select: { requestHash: true, responseStatus: true, responseJson: true },
  });
  if (!existing) return;

  if (existing.requestHash !== requestHash) {
    // Deliberately says nothing about what the original request contained.
    throw {
      _appCode: 422,
      message:
        "This idempotency key has already been used for a different packaging request on this batch. " +
        "Use a new key for a new operation, or resend the original request to retry it.",
    };
  }

  throw { _replayStatus: existing.responseStatus, _replayBody: existing.responseJson };
}

/**
 * Record the operation in the SAME transaction as the stock it describes.
 *
 * That is what makes a failed packaging safely retryable: if anything later in the
 * transaction throws, this row rolls back with the stock writes and the key is free to be
 * used again. A row here always means the work behind it committed.
 *
 * The response is stored as the snapshot a retry will receive, so a replay answers exactly
 * what the first execution answered rather than a freshly-derived and possibly different one.
 */
export async function recordOperation(
  tx: PrismaTx,
  data: {
    batchId: string;
    requestKey: string;
    requestHash: string;
    method: "KG" | "UNIT";
    quantityKg?: number | null;
    quantityUnits?: number | null;
    productSkuId?: string | null;
    finishedGoodsLotId?: string | null;
    responseStatus: number;
    responseBody: unknown;
    userId: string | null;
  },
): Promise<void> {
  await tx.packagingOperation.create({
    data: {
      batchId: data.batchId,
      requestKey: data.requestKey,
      requestHash: data.requestHash,
      method: data.method,
      quantityKg: data.quantityKg ?? null,
      quantityUnits: data.quantityUnits ?? null,
      productSkuId: data.productSkuId ?? null,
      finishedGoodsLotId: data.finishedGoodsLotId ?? null,
      responseStatus: data.responseStatus,
      // Through JSON so Date values become strings the column can hold, and so the stored
      // snapshot is exactly the bytes a replay will return.
      responseJson: JSON.parse(JSON.stringify(data.responseBody ?? null)) as Prisma.InputJsonValue,
      userId: data.userId,
    },
  });
}
