// Creating approval requests and deciding who may decide them. Effects live in approvals.ts.
import { Prisma } from "@/generated/prisma/client";
import { hasSubPrivilege, parsePermissions, buildDefaultPermissions } from "@/lib/auth-shared";
import { audit, can, FinanceError, getSettings, inScope, type Db, type FinanceActor, type FinanceScope, type FinanceSub } from "./context";

export type ApprovalType = "BUDGET_APPROVAL" | "ALLOCATION_RULES" | "CATEGORY_TRANSFER" | "SPEND_OVERRIDE" | "PERIOD_REOPEN";

export const APPROVAL_SUB: Record<ApprovalType, FinanceSub> = {
  BUDGET_APPROVAL: "budget_approve",
  ALLOCATION_RULES: "budget_approve",
  CATEGORY_TRANSFER: "transfer_approve",
  SPEND_OVERRIDE: "spend_override_approve",
  PERIOD_REOPEN: "period_close",
};

export async function createApproval(
  tx: Prisma.TransactionClient,
  actor: FinanceActor,
  input: {
    type: ApprovalType;
    branchKey: string;
    entityType: string;
    entityId: string;
    summary: string;
    payload: Record<string, unknown>;
    reason?: string | null;
    assignedToId?: string | null;
  },
) {
  // A named approver must actually hold the duty, or the request would sit forever.
  if (input.assignedToId) {
    const emp = await tx.employee.findUnique({ where: { id: input.assignedToId }, select: { active: true, role: true, permissions: true } });
    const perms = emp ? (() => { const p = parsePermissions(emp.permissions); return Object.keys(p).length ? p : buildDefaultPermissions(emp.role); })() : null;
    if (!emp || !emp.active || !perms || !hasSubPrivilege(perms, "finance", APPROVAL_SUB[input.type])) {
      throw new FinanceError("The named approver is inactive or does not hold the approval duty.", 409);
    }
  }
  const req = await tx.finApprovalRequest.create({
    data: {
      type: input.type,
      branchKey: input.branchKey,
      entityType: input.entityType,
      entityId: input.entityId,
      summary: input.summary,
      payload: input.payload as Prisma.InputJsonValue,
      requiredSub: APPROVAL_SUB[input.type],
      assignedToId: input.assignedToId ?? null,
      requestedBy: actor.id,
      reason: input.reason ?? null,
    },
  });
  await audit(tx, {
    action: "approval.requested",
    entityType: "FinApprovalRequest",
    entityId: req.id,
    branchKey: input.branchKey,
    after: { type: input.type, entityType: input.entityType, entityId: input.entityId, summary: input.summary, assignedToId: input.assignedToId ?? null },
    reason: input.reason,
    userId: actor.id,
  });
  return req;
}

export async function assertMayDecide(
  db: Db,
  actor: FinanceActor,
  scope: FinanceScope,
  req: { requiredSub: string; branchKey: string; assignedToId: string | null; requestedBy: string; status: string },
) {
  if (req.status !== "PENDING") throw new FinanceError("This request has already been decided.", 409);
  if (!can(actor, req.requiredSub as FinanceSub)) throw new FinanceError("You do not hold the duty required to decide this request.", 403);
  if (!inScope(scope, req.branchKey)) throw new FinanceError("Not found", 404);
  if (req.assignedToId && req.assignedToId !== actor.id) {
    throw new FinanceError("This request is assigned to a named approver.", 403);
  }
  if (req.requestedBy === actor.id) {
    const settings = await getSettings(db);
    if (!settings.allowSelfApproval) throw new FinanceError("You cannot decide a request you raised.", 403);
  }
}
