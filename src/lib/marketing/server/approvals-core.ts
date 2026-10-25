import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { sha256 } from "./crypto";
import { audit, type AuditActor } from "./audit";

export type SubjectType = "POST" | "CAMPAIGN" | "BUDGET_CHANGE" | "AD_CHANGE" | "MESSAGE_CAMPAIGN" | "TRACKING_CHANGE" | "SENSITIVE_REPLY" | "JOURNEY";

/** Stable JSON (sorted keys) → SHA-256: what an approval is bound to. */
export function snapshotHash(snapshot: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === "object" && !(v instanceof Date)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
      : v instanceof Date ? v.toISOString() : v;
  return sha256(JSON.stringify(stable(snapshot)));
}

/**
 * Open a request. An older PENDING request for the same subject and action is cancelled first —
 * only the latest version of a thing can be approved.
 */
export async function openApproval(
  tx: Prisma.TransactionClient,
  args: { subjectType: SubjectType; subjectId: string; action: string; payload: unknown; actor: { id: string; name: string }; note?: string | null },
) {
  await tx.mktApproval.updateMany({
    where: { subjectType: args.subjectType, subjectId: args.subjectId, action: args.action, status: "PENDING" },
    data: { status: "CANCELLED", decisionNote: "استُبدل بطلب أحدث" },
  });
  const row = await tx.mktApproval.create({
    data: {
      subjectType: args.subjectType, subjectId: args.subjectId, action: args.action,
      payload: JSON.parse(JSON.stringify(args.payload ?? {})) as Prisma.InputJsonValue,
      payloadHash: snapshotHash(args.payload ?? {}),
      requestedById: args.actor.id, requestedByName: args.actor.name, requestNote: args.note ?? null,
    },
  });
  const actor: AuditActor = { kind: "USER", id: args.actor.id, name: args.actor.name };
  await audit(tx, actor, "approval.requested", args.subjectType, args.subjectId, { after: { approvalId: row.id, action: args.action } });
  return row;
}

/** Cancel open requests of a subject (it was edited or cancelled). */
export async function cancelOpenApprovals(tx: Prisma.TransactionClient, subjectType: SubjectType, subjectId: string, note: string) {
  await tx.mktApproval.updateMany({ where: { subjectType, subjectId, status: "PENDING" }, data: { status: "CANCELLED", decisionNote: note } });
}
