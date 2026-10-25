import "server-only";
import { prisma, TX_OPTS } from "@/lib/db";
import { MktError, notFound, str, type Actor, can, denied } from "./http";
import { audit, userActor } from "./audit";
import { applyPostApproval, rejectPostApproval } from "./posts";
import { applyCampaignApproval } from "./campaigns";
import { applyJourneyApproval, applyMessageCampaignApproval } from "./messaging";

/**
 * Deciding a marketing request. Four eyes, enforced three times: here (a clear refusal), the
 * database CHECK (decidedById <> requestedById), and the effect re-validates the subject against
 * the snapshot the requester submitted — an edit after the request makes the approval stale, and
 * the approver is told so instead of approving something they did not see.
 */

export async function listApprovals(q: { status?: string | null; mine?: boolean }, actor: Actor) {
  const rows = await prisma.mktApproval.findMany({
    where: { ...(q.status ? { status: q.status } : {}), ...(q.mine ? { requestedById: actor.id } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  // Titles for the subjects, read in one query per type.
  const ids = (t: string) => rows.filter((r) => r.subjectType === t).map((r) => r.subjectId);
  const [posts, campaigns, journeys] = await Promise.all([
    prisma.mktPost.findMany({ where: { id: { in: ids("POST") } }, select: { id: true, title: true, aiGenerated: true, scheduledAt: true } }),
    prisma.mktCampaign.findMany({ where: { id: { in: [...ids("CAMPAIGN"), ...ids("MESSAGE_CAMPAIGN")] } }, select: { id: true, name: true } }),
    prisma.mktJourney.findMany({ where: { id: { in: ids("JOURNEY") } }, select: { id: true, name: true } }),
  ]);
  const title = new Map<string, string>([...posts.map((p) => [p.id, p.title] as const), ...campaigns.map((c) => [c.id, c.name] as const), ...journeys.map((j) => [j.id, j.name] as const)]);
  return rows.map((r) => ({ ...r, subjectTitle: title.get(r.subjectId) ?? null, canDecide: can(actor, "approve") && r.requestedById !== actor.id && r.status === "PENDING" }));
}

export async function decideApproval(id: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "approve")) throw denied("لا تملك صلاحية اعتماد طلبات التسويق.");
  const decision = body.decision === "APPROVE" ? "APPROVED" : body.decision === "REJECT" ? "REJECTED" : null;
  if (!decision) throw new MktError("القرار يجب أن يكون اعتماداً أو رفضاً.", "decision must be APPROVE or REJECT.");
  const note = str(body.note, "ملاحظة القرار", { max: 1000 });
  if (decision === "REJECTED" && !note) throw new MktError("اذكر سبب الرفض.", "A reason is required to reject.", 400, "MKT_REASON_REQUIRED");
  return prisma.$transaction(async (tx) => {
    const a = await tx.mktApproval.findUnique({ where: { id } });
    if (!a) throw notFound();
    if (a.status !== "PENDING") throw new MktError("تم البت في هذا الطلب أو إلغاؤه.", "Already decided or cancelled.", 409, "MKT_DECIDED");
    if (a.requestedById === actor.id) throw new MktError("لا يمكنك اعتماد طلبك أو رفضه.", "You cannot decide your own request.", 403, "MKT_FOUR_EYES");
    // Claim first: a concurrent decision on the same row loses here, not after an effect ran.
    const claimed = await tx.mktApproval.updateMany({ where: { id, status: "PENDING" }, data: { status: decision, decidedById: actor.id, decidedByName: actor.name, decisionNote: note, decidedAt: new Date() } });
    if (claimed.count === 0) throw new MktError("تم البت في هذا الطلب للتو.", "Decided concurrently.", 409, "MKT_DECIDED");
    const approver = { id: actor.id, name: actor.name };
    if (decision === "APPROVED") {
      if (a.subjectType === "POST") await applyPostApproval(tx, a, approver);
      else if (a.subjectType === "CAMPAIGN") await applyCampaignApproval(tx, a, approver);
      else if (a.subjectType === "JOURNEY") await applyJourneyApproval(tx, a, approver);
      else if (a.subjectType === "MESSAGE_CAMPAIGN") await applyMessageCampaignApproval(tx, a, approver);
      else throw new MktError("لا يوجد تنفيذ آلي لهذا النوع من الطلبات في هذا الإصدار.", "No effect is implemented for this request type.", 409, "MKT_NO_EFFECT");
    } else if (a.subjectType === "POST") {
      await rejectPostApproval(tx, a.subjectId, approver, note);
    }
    await audit(tx, userActor(actor), decision === "APPROVED" ? "approval.approved" : "approval.rejected", a.subjectType, a.subjectId, { after: { approvalId: id, action: a.action }, note });
    return { id, status: decision };
  }, TX_OPTS);
}

export async function cancelApproval(id: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.mktApproval.findUnique({ where: { id } });
    if (!a) throw notFound();
    if (a.requestedById !== actor.id && !can(actor, "approve")) throw denied();
    if (a.status !== "PENDING") throw new MktError("الطلب ليس معلقاً.", "Not pending.", 409);
    await tx.mktApproval.update({ where: { id }, data: { status: "CANCELLED", decisionNote: "سحبه مقدم الطلب" } });
    if (a.subjectType === "POST") {
      const p = await tx.mktPost.findUnique({ where: { id: a.subjectId }, select: { status: true } });
      if (p?.status === "IN_REVIEW") await tx.mktPost.update({ where: { id: a.subjectId }, data: { status: "DRAFT" } });
    }
    await audit(tx, userActor(actor), "approval.cancelled", a.subjectType, a.subjectId, { after: { approvalId: id } });
  }, TX_OPTS);
}
