// The approval queue and decisions. A request is shown to — and decidable by — only the
// named approver, or (when none is named) any holder of the required duty with access to
// the branch. The requester never decides their own request — there is no exception.
import { prisma } from "@/lib/db";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { audit, FinanceError, str, type Db, type FinanceActor, type FinanceScope } from "./context";
import { assertMayDecide } from "./approval-core";
import { activateRuleVersion, executeCategoryTransfer } from "./allocation";
import { decideRevision } from "./budgets";
import { emitAutomationEvent } from "@/lib/automation/emit";

export async function approvalQueue(db: Db, actor: FinanceActor, scope: FinanceScope) {
  const subs = ["budget_approve", "transfer_approve", "spend_override_approve", "period_close"].filter((s) => hasSubPrivilege(actor.permissions, "finance", s));
  const mine = await db.finApprovalRequest.findMany({
    where: {
      status: "PENDING",
      ...(scope.all ? {} : { branchKey: { in: scope.branchKeys } }),
      OR: [{ assignedToId: actor.id }, { assignedToId: null, requiredSub: { in: subs } }],
    },
    orderBy: { requestedAt: "asc" }, take: 200,
  });
  const raised = await db.finApprovalRequest.findMany({ where: { requestedBy: actor.id }, orderBy: { requestedAt: "desc" }, take: 50 });
  const ids = [...new Set([...mine, ...raised].flatMap((r) => [r.requestedBy, r.assignedToId, r.decidedBy]).filter(Boolean) as string[])];
  const people = await db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return { toDecide: mine.filter((r) => r.requestedBy !== actor.id), raisedByMe: raised, people };
}

export async function decideApproval(actor: FinanceActor, scope: FinanceScope, id: string, body: Record<string, unknown>) {
  const approve = body.decision === "APPROVE";
  if (!approve && body.decision !== "REJECT") throw new FinanceError("decision must be APPROVE or REJECT.", 400);
  const note = str(body.note, 1000);
  if (!approve && !note) throw new FinanceError("A rejection needs a reason.", 400);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FinApprovalRequest" WHERE id = ${id} FOR UPDATE`;
    const req = await tx.finApprovalRequest.findUnique({ where: { id } });
    if (!req) throw new FinanceError("Not found", 404);
    await assertMayDecide(tx, actor, scope, req);

    // The decision is written first: the database lets an approval-gated state change (a
    // rule going live, a held payment released, a transfer, a reopened period, an approved
    // revision) only under an APPROVED request decided by someone other than its requester.
    const upd = await tx.finApprovalRequest.update({
      where: { id },
      data: { status: approve ? "APPROVED" : "REJECTED", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note },
    });
    await emitAutomationEvent(tx, {
      eventType: "finance.approval_decided",
      subjectType: "FinApprovalRequest",
      subjectId: id,
      payload: { decision: approve ? "APPROVED" : "REJECTED" },
      actorId: actor.id,
    });

    switch (req.type) {
      case "BUDGET_APPROVAL":
        await decideRevision(tx, req.entityId, approve, actor.id, note);
        break;
      case "ALLOCATION_RULES":
        if (approve) await activateRuleVersion(tx, req.entityId, actor.id);
        else await tx.allocationRuleVersion.update({ where: { id: req.entityId }, data: { status: "REJECTED" } });
        break;
      case "CATEGORY_TRANSFER":
        if (approve) await executeCategoryTransfer(tx, req, actor.id);
        break;
      case "SPEND_OVERRIDE": {
        const r = await tx.paymentReservation.findUnique({ where: { id: req.entityId } });
        if (!r || r.status !== "PENDING_APPROVAL") throw new FinanceError("The payment request is no longer waiting.", 409);
        await tx.paymentReservation.update({ where: { id: r.id }, data: { status: approve ? "ACTIVE" : "REJECTED" } });
        break;
      }
      case "PERIOD_REOPEN":
        if (approve) {
          const b = await tx.finBudget.findUnique({ where: { id: req.entityId } });
          if (!b || b.status !== "CLOSED") throw new FinanceError("Budget is not closed.", 409);
          await tx.finBudget.update({ where: { id: b.id }, data: { status: "APPROVED", closedAt: null, closedBy: null } });
        }
        break;
    }
    await audit(tx, {
      action: `approval.${approve ? "approved" : "rejected"}`, entityType: "FinApprovalRequest", entityId: id, branchKey: req.branchKey,
      before: { status: req.status }, after: { status: upd.status }, reason: note, refs: { type: req.type, entityType: req.entityType, entityId: req.entityId }, userId: actor.id,
    });
    return upd;
  });
}

export async function cancelApproval(actor: FinanceActor, id: string) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.finApprovalRequest.findUnique({ where: { id } });
    if (!req || req.requestedBy !== actor.id) throw new FinanceError("Not found", 404);
    if (req.status !== "PENDING") throw new FinanceError("Already decided.", 409);
    if (req.type === "BUDGET_APPROVAL") {
      const rev = await tx.budgetRevision.findUnique({ where: { id: req.entityId } });
      if (rev?.status === "SUBMITTED") {
        await tx.budgetRevision.update({ where: { id: rev.id }, data: { status: "DRAFT", submittedAt: null, submittedBy: null } });
        if (rev.revisionNo === 1) await tx.finBudget.update({ where: { id: rev.budgetId }, data: { status: "DRAFT" } });
      }
    }
    if (req.type === "ALLOCATION_RULES") await tx.allocationRuleVersion.updateMany({ where: { id: req.entityId, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } });
    if (req.type === "SPEND_OVERRIDE") await tx.paymentReservation.updateMany({ where: { id: req.entityId, status: "PENDING_APPROVAL" }, data: { status: "RELEASED", releasedAt: new Date(), releasedBy: actor.id, releaseReason: "Request withdrawn" } });
    const upd = await tx.finApprovalRequest.update({ where: { id }, data: { status: "CANCELLED", decidedAt: new Date(), decidedBy: actor.id, decisionNote: "Withdrawn by requester" } });
    await emitAutomationEvent(tx, {
      eventType: "finance.approval_decided",
      subjectType: "FinApprovalRequest",
      subjectId: id,
      payload: { decision: "CANCELLED" },
      actorId: actor.id,
    });
    await audit(tx, { action: "approval.withdrawn", entityType: "FinApprovalRequest", entityId: id, branchKey: req.branchKey, userId: actor.id });
    return upd;
  });
}
