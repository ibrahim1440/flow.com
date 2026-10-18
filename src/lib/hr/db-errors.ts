// Native HR — pure classification of database failures (no Prisma import, unit-testable).

/** Round-4 W6 fallback: the message and code of a deadlock / serialization failure. Nothing was saved. */
export const CONCURRENT_UPDATE_RETRY = "CONCURRENT_UPDATE_RETRY";
export const CONCURRENT_UPDATE_MESSAGE = "Another change to the same records was being saved at the same moment, so this one was stopped and nothing was saved. Try again.";

const RETRY_SQLSTATES = new Set(["40P01", "40001"]); // deadlock_detected, serialization_failure

type AdapterCause = { kind?: string; code?: string; originalCode?: string } | undefined;
type DbErr = { code?: string; name?: string; cause?: AdapterCause; meta?: { code?: string; driverAdapterError?: { cause?: AdapterCause } } } | null | undefined;

/**
 * Why a database failure is a concurrency failure, or null. Round-5 P3a/b: decided by STRUCTURE,
 * never by message text — a message that merely mentions "deadlock" is not one:
 *   · the SQLSTATE the driver adapter reports (Prisma 7: `meta.driverAdapterError.cause` for a raw
 *     query (P2010), or the DriverAdapterError's own `cause` for an ORM query): `originalCode` /
 *     `code` 40P01 (deadlock) or 40001 (serialization failure);
 *   · the adapter's `TransactionWriteConflict` kind (a SERIALIZABLE write conflict);
 *   · Prisma's own transaction-conflict code P2034.
 */
export function concurrencyFailureOf(err: unknown): string | null {
  const e = err as DbErr;
  if (!e || typeof e !== "object") return null;
  if (e.code === "P2034") return "P2034";
  for (const cause of [e.meta?.driverAdapterError?.cause, e.cause]) {
    if (!cause || typeof cause !== "object") continue;
    if (cause.kind === "TransactionWriteConflict") return "TransactionWriteConflict";
    for (const c of [cause.originalCode, cause.code]) if (c && RETRY_SQLSTATES.has(String(c))) return String(c);
  }
  if (e.meta?.code && RETRY_SQLSTATES.has(String(e.meta.code))) return String(e.meta.code);
  return null;
}

export function isConcurrencyFailure(err: unknown): boolean {
  return concurrencyFailureOf(err) !== null;
}
