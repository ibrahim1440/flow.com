import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

type Tx = Prisma.TransactionClient | typeof prisma;

export type AuditActor = { kind: "USER" | "RULE" | "SYSTEM" | "WEBHOOK"; id?: string | null; name?: string | null };

/** Append one row to the marketing audit trail (append-only by trigger). Inside the caller's transaction. */
export async function audit(
  tx: Tx,
  actor: AuditActor,
  action: string,
  entityType: string,
  entityId: string | null,
  change: { before?: unknown; after?: unknown; note?: string | null } = {},
) {
  await tx.mktAuditLog.create({
    data: {
      actorKind: actor.kind, actorId: actor.id ?? null, actorName: actor.name ?? null, action, entityType, entityId,
      before: change.before === undefined ? undefined : (JSON.parse(JSON.stringify(change.before)) as Prisma.InputJsonValue),
      after: change.after === undefined ? undefined : (JSON.parse(JSON.stringify(change.after)) as Prisma.InputJsonValue),
      note: change.note ?? null,
    },
  });
}

export const userActor = (u: { id: string; name: string }): AuditActor => ({ kind: "USER", id: u.id, name: u.name });
