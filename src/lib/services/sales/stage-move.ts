// «طلب نقل» — a manual stage move that waits for a supervisor (pipeline v2, owner decision 3; docs/sales/PIPELINE_STAGES.md).
//
// A manual move (dragging a card, «نقل إلى…») by somebody WITHOUT `sales › deal_stage_move` is not applied: it becomes
// a StageMoveRequest that a supervisor approves or rejects. Whoever holds `deal_stage_move` — or `lead_assign`, the
// supervisor — moves directly. The automatic moves (a sample requested, a quotation issued or accepted) never need any
// of this: the act is the move.
//
// Rules, all enforced here, inside the caller's transaction, behind row locks:
//   - a closed deal is never moved, and never gets a request;
//   - ONE PENDING request per deal (a partial unique index backs it): a new request REPLACES the pending one, which
//     becomes SUPERSEDED — the newer intention is the one a supervisor should judge;
//   - approvers (owner's rule, gate fix MEDIUM-3): a supervisor or manager — `lead_assign` (whose scope is every deal),
//     the administrator (by its template's lead_assign), or a member of the «مدير عام» role — and never the requester (four eyes). `deal_stage_move`
//     alone NEVER approves: it only means "I may move deals in my own scope directly, without a request";
//   - approving applies the move through `transitionOpportunity` — the same rules as any move (the documented sample
//     skip included: a request that passes Sample Evaluation with no sample needs its reason when it is made) — with
//     the stage event's reason «يدوي — باعتماد <approver>»; rejecting (a reason required) leaves the deal where it is;
//   - a pending request is CANCELLED when the deal's stage or outcome changes first (an automatic move, a close, a
//     direct move), or when its target stage is hidden (stages PATCH): approving it then would apply a decision about a
//     deal that is no longer where it was, or put an open deal into a column the board no longer draws. A stale
//     request found at decision time is cancelled and the caller answers 409 — the cancel is committed, not thrown away.
import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { isSimpleMode } from "@/lib/simple-mode";
import { sampleSkipRequired, SAMPLE_SKIP_REFUSAL } from "./stages";
import { transitionOpportunity } from "./leads";

type Tx = PrismaNS.TransactionClient;
type Actor = { id: string; name?: string | null; permissions: Permissions | Record<string, unknown>; generalManager?: boolean };

/** The role template whose members approve stage moves whatever their sub-privileges (owner's rule). */
export const GENERAL_MANAGER_ROLE = "مدير عام";

/** Is this employee a member of the «مدير عام» role template? */
export async function isGeneralManager(db: Pick<Tx, "employee">, employeeId: string): Promise<boolean> {
  const e = await db.employee.findUnique({ where: { id: employeeId }, select: { accessRole: { select: { name: true } } } });
  return e?.accessRole?.name === GENERAL_MANAGER_ROLE;
}

export const STAGE_MOVE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "SUPERSEDED"] as const;
export type StageMoveStatus = (typeof STAGE_MOVE_STATUSES)[number];

/**
 * May this person move a deal between stages directly (no request)? `deal_stage_move` (deals in their own scope —
 * the route has already refused a deal outside it), the supervisor (`lead_assign`), or the administrator.
 */
export function movesDirectly(permissions: Actor["permissions"], generalManager = false): boolean {
  // A «مدير عام» member is a manager: moves directly, as a lead_assign holder does (gate round 2). By permission only
  // (release gate A5 / N2): the administrator holds lead_assign through its template, so no role check decides here.
  if (generalManager) return true;
  return hasSubPrivilege(permissions as Permissions, "sales", "deal_stage_move") || hasSubPrivilege(permissions as Permissions, "sales", "lead_assign");
}

/**
 * May this person decide stage-move requests? A supervisor or manager: `lead_assign` (scope: every deal), the
 * administrator, or a «مدير عام» member (`actor.generalManager`, from `isGeneralManager`). Never `deal_stage_move`
 * alone. Not their own request: checked on decide.
 */
export function approvesMove(actor: Actor): boolean {
  // By permission only (release gate A5 / N2): the administrator holds lead_assign through its template.
  if (actor.generalManager) return true;
  return hasSubPrivilege(actor.permissions as Permissions, "sales", "lead_assign");
}

const refuse = (status: number, code: string, ar: string, en: string) => ({ _appCode: status, code, message: en, errorAr: ar });

/** Cancel the deal's pending request because the deal changed first. Returns how many were cancelled (0 or 1). */
export async function invalidatePendingMoves(tx: Tx, opportunityId: string, why: string, now: Date = new Date()): Promise<number> {
  const r = await tx.stageMoveRequest.updateMany({
    where: { opportunityId, status: "PENDING" },
    data: { status: "CANCELLED", decidedAt: now, decisionNote: why.slice(0, 300) },
  });
  return r.count;
}

/**
 * A rep's manual move, recorded as a request. Throws coded refusals: 404 (no deal), 409 DEAL_CLOSED, 400 STAGE_INVALID
 * (not an active stage, or the stage it is already in), 409 SAMPLE_SKIP_REASON_REQUIRED (past Sample Evaluation with
 * no sample and no reason). Returns the request and the one it replaced, if any.
 */
export async function requestStageMove(
  tx: Tx,
  input: { opportunityId: string; toStageId: string; reason?: string | null; requestedById: string },
  now: Date = new Date(),
) {
  const rows = await tx.$queryRaw<{ id: string; stageId: string; outcome: string }[]>`
    SELECT "id", "stageId", "outcome"::text AS outcome FROM "Opportunity" WHERE "id" = ${input.opportunityId} FOR UPDATE`;
  const deal = rows[0];
  if (!deal) throw { _appCode: 404, message: "Deal not found." };
  if (deal.outcome !== "OPEN") throw refuse(409, "DEAL_CLOSED", "الصفقة مغلقة؛ لا تُنقل بين المراحل.", "This deal is closed; it is not moved between stages.");
  const ends = await tx.pipelineStage.findMany({ where: { id: { in: [deal.stageId, input.toStageId] } }, select: { id: true, position: true, isActive: true } });
  const from = ends.find((s) => s.id === deal.stageId);
  const to = ends.find((s) => s.id === input.toStageId);
  if (!to || !to.isActive || to.id === deal.stageId) throw refuse(400, "STAGE_INVALID", "اختر مرحلة أخرى متاحة.", "Choose another available stage.");
  const reason = (input.reason ?? "").trim().slice(0, 500) || null;
  // The documented skip: asked for NOW, from the rep who knows why, not later from the approver.
  const sampleStage = await tx.pipelineStage.findFirst({ where: { purpose: "SAMPLE_EVALUATION", isActive: true }, select: { position: true } });
  if (sampleStage && from) {
    const sampleCount = await tx.sampleShipment.count({ where: { opportunityId: deal.id, status: { not: "CANCELLED" } } });
    if (sampleSkipRequired({ fromPosition: from.position, toPosition: to.position, samplePosition: sampleStage.position, sampleCount }) && (reason ?? "").length < 2) {
      throw { ...SAMPLE_SKIP_REFUSAL };
    }
  }
  // One pending per deal: the newer request replaces the older (owner decision 3, documented above).
  const replaced = await tx.stageMoveRequest.updateMany({
    where: { opportunityId: deal.id, status: "PENDING" },
    data: { status: "SUPERSEDED", decidedAt: now, decisionNote: "استُبدل بطلب أحدث" },
  });
  const request = await tx.stageMoveRequest.create({
    data: { opportunityId: deal.id, fromStageId: deal.stageId, toStageId: to.id, reason, requestedById: input.requestedById, status: "PENDING" },
  });
  // Readiness review P1-6: the approvers are told (lead_assign holders, «مدير عام» members, the admins).
  const { notifyStageMovePending } = await import("./sample-stage-notify");
  await notifyStageMovePending(tx, request.id, input.requestedById);
  return { request, replaced: replaced.count };
}

/**
 * The supervisor's decision. APPROVE applies the move (through `transitionOpportunity`) with the reason «يدوي — باعتماد
 * <approver>»; REJECT needs a note and changes nothing on the deal. Throws coded refusals: 404, 403 STAGE_MOVE_APPROVER
 * (no duty or no scope, or the requester), 409 STAGE_MOVE_DECIDED (not pending any more), 409 STAGE_MOVE_STALE (the
 * deal moved or closed since — the request is cancelled), 400 STAGE_MOVE_REASON (a rejection without a note).
 */
export async function decideStageMove(
  tx: Tx,
  input: { requestId: string; decision: "APPROVE" | "REJECT"; note?: string | null; actor: Actor },
  now: Date = new Date(),
) {
  const reqs = await tx.$queryRaw<{ id: string; opportunityId: string; fromStageId: string; toStageId: string; status: string; reason: string | null; requestedById: string }[]>`
    SELECT "id", "opportunityId", "fromStageId", "toStageId", "status", "reason", "requestedById" FROM "StageMoveRequest" WHERE "id" = ${input.requestId} FOR UPDATE`;
  const r = reqs[0];
  if (!r) throw { _appCode: 404, message: "Request not found." };
  const deals = await tx.$queryRaw<{ id: string; stageId: string; outcome: string; ownerId: string }[]>`
    SELECT "id", "stageId", "outcome"::text AS outcome, "ownerId" FROM "Opportunity" WHERE "id" = ${r.opportunityId} FOR UPDATE`;
  const deal = deals[0];
  if (!deal) throw { _appCode: 404, message: "Deal not found." };
  const actor = { ...input.actor, generalManager: input.actor.generalManager ?? await isGeneralManager(tx, input.actor.id) };
  if (!approvesMove(actor) || (r.requestedById === input.actor.id && !isSimpleMode())) {
    throw refuse(403, "STAGE_MOVE_APPROVER", "اعتماد طلب النقل للمشرف أو لمن يملك صلاحية نقل الصفقات، ولا يعتمد صاحب الطلب طلبه.", "Only a supervisor (or a holder of the stage-move permission whose scope covers the deal) decides a move, and never the requester.");
  }
  if (r.status !== "PENDING") throw refuse(409, "STAGE_MOVE_DECIDED", "قُرّر هذا الطلب مسبقًا أو أُلغي.", "This request was already decided or cancelled.");
  // Stale: the deal moved or closed, or the target stage was hidden since the request. The request is cancelled and
  // the caller answers 409 AFTER the transaction commits (gate fix MEDIUM-1) — throwing here would roll the cancel back.
  const target = (await tx.$queryRaw<{ isActive: boolean }[]>`SELECT "isActive" FROM "PipelineStage" WHERE "id" = ${r.toStageId} FOR SHARE`)[0];
  const stale = deal.outcome !== "OPEN" || deal.stageId !== r.fromStageId ? "MOVED" as const : !target?.isActive ? "STAGE_HIDDEN" as const : null;
  if (stale) {
    await tx.stageMoveRequest.update({ where: { id: r.id }, data: { status: "CANCELLED", decidedAt: now,
      decisionNote: stale === "MOVED" ? "تغيّرت مرحلة الصفقة أو أُغلقت قبل الاعتماد" : "أُخفيت المرحلة المطلوبة قبل الاعتماد" } });
    return { status: "STALE" as const, request: r, moved: null, stale };
  }
  const note = (input.note ?? "").trim().slice(0, 500) || null;
  if (input.decision === "REJECT") {
    if (!note || note.length < 2) throw refuse(400, "STAGE_MOVE_REASON", "اذكر سبب الرفض؛ يقرؤه المندوب.", "Give the reason for rejecting; the rep reads it.");
    await tx.stageMoveRequest.update({ where: { id: r.id }, data: { status: "REJECTED", decidedById: input.actor.id, decidedAt: now, decisionNote: note } });
    { const { notifyStageMoveDecided } = await import("./sample-stage-notify"); await notifyStageMoveDecided(tx, r.id, input.actor.id, "REJECT"); }
    return { status: "REJECTED" as const, request: r, moved: null, stale: null };
  }
  // APPROVED first: the move below must not cancel the very request it applies (transitionOpportunity cancels pending ones).
  await tx.stageMoveRequest.update({ where: { id: r.id }, data: { status: "APPROVED", decidedById: input.actor.id, decidedAt: now, decisionNote: note } });
  const requester = await tx.employee.findUnique({ where: { id: r.requestedById }, select: { name: true } });
  const approverName = input.actor.name ?? (await tx.employee.findUnique({ where: { id: input.actor.id }, select: { name: true } }))?.name ?? "";
  const moved = await transitionOpportunity(tx, {
    opportunityId: r.opportunityId,
    toStageId: r.toStageId,
    skipReason: r.reason,
    actorId: input.actor.id,
    canReopen: false,
    manualNote: `يدوي — باعتماد ${approverName}${requester?.name ? ` · بطلب ${requester.name}` : ""}${r.reason ? ` · ${r.reason}` : ""}`,
  });
  { const { notifyStageMoveDecided } = await import("./sample-stage-notify"); await notifyStageMoveDecided(tx, r.id, input.actor.id, "APPROVE"); }
  return { status: "APPROVED" as const, request: r, moved, stale: null };
}

/** The 409 a stale decision answers once its cancel is committed. */
export function staleRefusal(stale: "MOVED" | "STAGE_HIDDEN") {
  return stale === "MOVED"
    ? refuse(409, "STAGE_MOVE_STALE", "تغيّرت مرحلة الصفقة أو أُغلقت بعد الطلب؛ أُلغي الطلب.", "The deal moved or closed after the request; the request is cancelled.")
    : refuse(409, "STAGE_MOVE_STALE", "أُخفيت المرحلة المطلوبة بعد الطلب؛ أُلغي الطلب.", "The requested stage was hidden after the request; the request is cancelled.");
}

/** Cancel the pending requests that target stages being hidden (stages PATCH, gate fix MEDIUM-1). */
export async function cancelMovesToStages(tx: Tx, stageIds: string[], now: Date = new Date()): Promise<number> {
  if (stageIds.length === 0) return 0;
  const r = await tx.stageMoveRequest.updateMany({
    where: { toStageId: { in: stageIds }, status: "PENDING" },
    data: { status: "CANCELLED", decidedAt: now, decisionNote: "أُخفيت المرحلة المطلوبة" },
  });
  return r.count;
}

/** The requester withdraws their own pending request. */
export async function withdrawStageMove(tx: Tx, input: { requestId: string; actorId: string }, now: Date = new Date()) {
  const r = await tx.stageMoveRequest.findUnique({ where: { id: input.requestId }, select: { id: true, status: true, requestedById: true } });
  if (!r || r.requestedById !== input.actorId) throw { _appCode: 404, message: "Request not found." };
  if (r.status !== "PENDING") throw refuse(409, "STAGE_MOVE_DECIDED", "قُرّر هذا الطلب مسبقًا أو أُلغي.", "This request was already decided or cancelled.");
  await tx.stageMoveRequest.update({ where: { id: r.id }, data: { status: "CANCELLED", decidedById: input.actorId, decidedAt: now, decisionNote: "سحبه صاحب الطلب" } });
  return { status: "CANCELLED" as const };
}
