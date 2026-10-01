export class AccountingError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AccountingError";
    this.status = status;
    this.details = details;
  }
}

/**
 * A rule is holding an automatic posting back — not a failure. The event stays BLOCKED with
 * this message and is retried once the cause (an unapproved policy, an unmapped account, a
 * closed period, an earlier unposted event for the same party) is removed.
 */
export class PostingBlocked extends AccountingError {
  constructor(message: string, details?: unknown) {
    super(message, 409, details);
    this.name = "PostingBlocked";
  }
}

/**
 * The message a database guard raised (see the ledger-core migration), when `err` is one.
 * The guards raise SQLSTATE 23000 with a sentence meant for the user; Prisma's driver
 * adapter nests it in different places depending on the call path, so all are searched.
 */
export function databaseGuardMessage(err: unknown): string | null {
  const seen = new Set<unknown>();
  const visit = (e: unknown, depth: number): string | null => {
    if (!e || typeof e !== "object" || seen.has(e) || depth > 6) return null;
    seen.add(e);
    const o = e as Record<string, unknown>;
    const code = String(o.code ?? o.originalCode ?? "");
    const msg = typeof o.message === "string" ? o.message : typeof o.originalMessage === "string" ? o.originalMessage : "";
    if (code === "23000" && msg) return msg.replace(/^[\s\S]*?ERROR:\s*/, "").trim();
    for (const k of ["cause", "meta", "driverAdapterError", "kind"]) {
      const r = visit(o[k], depth + 1);
      if (r) return r;
    }
    const m = /integrity_constraint_violation|23000/.test(msg) ? /(?:ERROR:|message: )\s*"?([^"\n]+)/.exec(msg) : null;
    return m ? m[1].trim() : null;
  };
  return visit(err, 0);
}
