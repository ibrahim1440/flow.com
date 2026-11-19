// The text a database guard (a trigger's RAISE EXCEPTION, a check) refused with — the one place every refusal mapper reads
// it from. No Prisma import: pure, unit-testable.
//
// R2-deps gate (Prisma 7.8 → 7.10): an ORM query refused by a trigger is now P2039 and its `message` wraps the guard's text
//   «…Database error. Code: `P0001`. Message: `<guard text>`»
// (a raw query, P2010: «Raw query failed. Code: `…`. Message: `<guard text>`»), and in development it also carries the
// calling source lines. The mappers' patterns ([^\n"]*) kept the closing backtick: English refusals ended in «`», the
// Arabic lookup of an HR guard missed, a location's name read «المستودع`». The driver adapter keeps the plain text in
// `meta.driverAdapterError.cause.originalMessage` (an ORM query's own DriverAdapterError: `cause.originalMessage`).

type Cause = { originalMessage?: unknown; message?: unknown } | undefined;
type Err = { message?: unknown; cause?: Cause; meta?: { message?: unknown; driverAdapterError?: { cause?: Cause } } } | null | undefined;

const WRAPPED = /(?:Database error|Raw query failed)\. Code: `[^`\n]*`\. Message: `([\s\S]*)`\s*$/;

/** A message with Prisma's «… Code: `x`. Message: `…`» wrapper → the guard's own text; any other text unchanged. */
export function unwrapDbMessage(message: string): string {
  const m = WRAPPED.exec(message);
  return m ? m[1] : message;
}

/** The guard's plain text of a database error (or any error's message, unwrapped). Never throws; "" when there is none. */
export function dbGuardText(err: unknown): string {
  if (typeof err === "string") return unwrapDbMessage(err);
  const e = err as Err;
  if (!e || typeof e !== "object") return "";
  for (const c of [e.meta?.driverAdapterError?.cause, e.cause]) {
    if (c && typeof c === "object" && typeof c.originalMessage === "string" && c.originalMessage) return c.originalMessage;
  }
  const raw = typeof e.meta?.message === "string" ? e.meta.message : typeof e.message === "string" ? e.message : "";
  return unwrapDbMessage(raw);
}
