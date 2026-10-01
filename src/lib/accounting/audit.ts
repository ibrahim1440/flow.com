// Accounting decisions go to the append-only FinAuditLog (database trigger forbids update and
// delete), under entity types prefixed "accounting.", rather than a second audit table.
import type { Prisma } from "@/generated/prisma/client";

type Tx = Prisma.TransactionClient;

export async function auditAccounting(
  tx: Tx,
  entry: { action: string; entityType: string; entityId: string; userId: string | null; before?: unknown; after?: unknown; reason?: string | null; refs?: unknown },
) {
  await tx.finAuditLog.create({
    data: {
      action: entry.action,
      entityType: `accounting.${entry.entityType}`,
      entityId: entry.entityId,
      userId: entry.userId,
      before: entry.before === undefined ? undefined : (JSON.parse(JSON.stringify(entry.before)) as Prisma.InputJsonValue),
      after: entry.after === undefined ? undefined : (JSON.parse(JSON.stringify(entry.after)) as Prisma.InputJsonValue),
      reason: entry.reason ?? null,
      refs: entry.refs === undefined ? undefined : (JSON.parse(JSON.stringify(entry.refs)) as Prisma.InputJsonValue),
    },
  });
}
