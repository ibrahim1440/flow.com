// Readiness review P1-6: in-app notifications (the existing catalogue and channels — never to a customer) for samples and
// stage-move requests, which used to be pull-only. Each call is one event with a stable dedupe key, so a replayed
// request adds nothing; the actor is never told about their own act (notify()).
import type { Prisma } from "@/generated/prisma/client";
import { notify } from "@/lib/notifications/notify";
import { GENERAL_MANAGER_ROLE } from "./stage-move";

type Tx = Prisma.TransactionClient;

async function admins(tx: Tx): Promise<string[]> {
  // By permission document: the administrator accounts (role-based recipients are «admins» everywhere in the catalogue).
  return (await tx.employee.findMany({ where: { role: "admin", active: true }, select: { id: true } })).map((e) => e.id);
}
async function generalManagers(tx: Tx): Promise<string[]> {
  return (await tx.employee.findMany({ where: { active: true, accessRole: { name: GENERAL_MANAGER_ROLE } }, select: { id: true } })).map((e) => e.id);
}

async function sampleFacts(tx: Tx, sampleId: string) {
  const s = await tx.sampleShipment.findUnique({
    where: { id: sampleId },
    select: {
      id: true, createdById: true, description: true, opportunityId: true,
      productSku: { select: { name: true, nameAr: true } },
      opportunity: { select: { id: true, ownerId: true, customer: { select: { name: true, nameAr: true, accountOwnerId: true } } } },
    },
  });
  if (!s) return null;
  const by = s.createdById ? await tx.employee.findUnique({ where: { id: s.createdById }, select: { name: true } }) : null;
  const c = s.opportunity.customer;
  return {
    s,
    facts: {
      sampleId: s.id, dealId: s.opportunityId,
      productName: s.productSku?.nameAr || s.productSku?.name || s.description || "", productNameEn: s.productSku?.name || s.description || "",
      customerName: c ? c.nameAr || c.name : "", customerNameEn: c?.name ?? "", requesterName: by?.name ?? "",
    },
    owners: [s.opportunity.ownerId, c?.accountOwnerId],
  };
}

/** A sample request: to dispatch when it may be issued now; to the approvers when a second sample needs approval. */
export async function notifySampleRequested(tx: Tx, sampleId: string, actorId: string, needsApproval: boolean) {
  const f = await sampleFacts(tx, sampleId);
  if (!f) return;
  if (needsApproval) {
    await notify(tx, { event: "sales.sample_approval_pending", dedupeKey: sampleId, actorId, facts: f.facts, entity: { type: "SampleShipment", id: sampleId }, people: { admins: await admins(tx) } });
  } else {
    await notify(tx, { event: "sales.sample_requested", dedupeKey: sampleId, actorId, facts: f.facts, entity: { type: "SampleShipment", id: sampleId } });
  }
}

/** A second sample decided: the requester (and the deal owner) learn it; an approved one now waits for dispatch. */
export async function notifySampleDecided(tx: Tx, sampleId: string, actorId: string, decision: "APPROVE" | "DECLINE", note: string | null) {
  const f = await sampleFacts(tx, sampleId);
  if (!f) return;
  await notify(tx, { event: "sales.sample_decided", dedupeKey: `${sampleId}:${decision}`, actorId, facts: { ...f.facts, decision, note }, entity: { type: "SampleShipment", id: sampleId }, people: { requester: f.s.createdById, dealOwner: f.s.opportunity.ownerId } });
  if (decision === "APPROVE") await notify(tx, { event: "sales.sample_requested", dedupeKey: sampleId, actorId, facts: f.facts, entity: { type: "SampleShipment", id: sampleId } });
}

export async function notifySampleSent(tx: Tx, sampleId: string, actorId: string) {
  const f = await sampleFacts(tx, sampleId);
  if (!f) return;
  await notify(tx, { event: "sales.sample_sent", dedupeKey: sampleId, actorId, facts: f.facts, entity: { type: "SampleShipment", id: sampleId }, people: { dealOwner: f.s.opportunity.ownerId, requester: f.s.createdById } });
}

export async function notifySampleFeedback(tx: Tx, sampleId: string, actorId: string) {
  const f = await sampleFacts(tx, sampleId);
  if (!f) return;
  await notify(tx, { event: "sales.sample_feedback", dedupeKey: sampleId, actorId, facts: f.facts, entity: { type: "SampleShipment", id: sampleId }, people: { dealOwner: f.s.opportunity.ownerId } });
}

async function moveFacts(tx: Tx, requestId: string) {
  const r = await tx.stageMoveRequest.findUnique({
    where: { id: requestId },
    select: { id: true, requestedById: true, toStageId: true, decisionNote: true, opportunity: { select: { id: true, title: true } } },
  });
  if (!r) return null;
  const [stage, by] = await Promise.all([
    tx.pipelineStage.findUnique({ where: { id: r.toStageId }, select: { nameAr: true, nameEn: true } }),
    tx.employee.findUnique({ where: { id: r.requestedById }, select: { name: true } }),
  ]);
  return { r, facts: { requestId: r.id, dealId: r.opportunity.id, dealTitle: r.opportunity.title, toStage: stage?.nameAr ?? "", toStageEn: stage?.nameEn ?? "", requesterName: by?.name ?? "" } };
}

export async function notifyStageMovePending(tx: Tx, requestId: string, actorId: string) {
  const m = await moveFacts(tx, requestId);
  if (!m) return;
  await notify(tx, { event: "sales.stage_move_pending", dedupeKey: requestId, actorId, facts: m.facts, entity: { type: "StageMoveRequest", id: requestId }, people: { generalManagers: await generalManagers(tx), admins: await admins(tx) } });
}

export async function notifyStageMoveDecided(tx: Tx, requestId: string, actorId: string, decision: "APPROVE" | "REJECT") {
  const m = await moveFacts(tx, requestId);
  if (!m) return;
  await notify(tx, { event: "sales.stage_move_decided", dedupeKey: `${requestId}:${decision}`, actorId, facts: { ...m.facts, decision, note: m.r.decisionNote }, entity: { type: "StageMoveRequest", id: requestId }, people: { requester: m.r.requestedById } });
}
