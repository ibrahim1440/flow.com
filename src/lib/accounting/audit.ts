// Accounting core A1 — the audit context of a transaction (council invariant 8: who, when, what, before / after,
// from which IP / device). The database writes "AccountingAuditLog" itself (trigger ledger_audit_row on the chart,
// roles, years, periods, settings, journal entries and the opening grid); the application only tells it WHO is
// acting and from WHERE, transaction-locally (set_config(…, true) = SET LOCAL: it ends with the transaction and
// never leaks to the next user of a pooled connection).
import type { Prisma } from "@/generated/prisma/client";

export type AuditContext = { actorId: string; ip?: string | null; userAgent?: string | null; reason?: string | null };

type Tx = Prisma.TransactionClient;

/** The request's IP and device, for the audit trail (the platform address rule of extractIp). */
export function auditFromRequest(request: Request | null | undefined, actorId: string, reason?: string | null): AuditContext {
  if (!request) return { actorId, reason: reason ?? null };
  // The platform address rule of extractIp (src/lib/rate-limit.ts, review P2-6): x-real-ip only on Vercel, where
  // the edge sets it; a client-sent X-Forwarded-For is never read. (Not imported: rate-limit needs its secret at load.)
  const ip = process.env.VERCEL === "1" ? request.headers.get("x-real-ip")?.trim() || null : null;
  return { actorId, ip, userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300) || null, reason: reason ?? null };
}

/** Must run inside the transaction whose writes it describes (first statement is best). */
export async function setAuditContext(tx: Tx, ctx: AuditContext): Promise<void> {
  await tx.$queryRaw`SELECT set_config('hiqbah.actor_id', ${ctx.actorId}, true), set_config('hiqbah.audit_ip', ${ctx.ip ?? ""}, true),
                            set_config('hiqbah.audit_ua', ${ctx.userAgent ?? ""}, true), set_config('hiqbah.audit_reason', ${(ctx.reason ?? "").slice(0, 500)}, true)`;
}
