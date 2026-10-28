import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { assertAdminRoleGate } from "@/lib/auth-server";
import { ROASTING_STATION, PROBLEM_KINDS, PROBLEM_REASONS, PROBLEM_STATE, LOSS_REASONS, type ProblemKind, type StationItemType } from "@/lib/station/shared";
import { operatorRefusal, operatorVerdict } from "@/lib/services/roaster-controls";
import { isAssignedOperator } from "@/lib/services/roaster-operators";
import { scheduleCan, startSlot, ScheduleError } from "@/lib/services/schedule/schedule-db";
import type { Permissions } from "@/lib/auth-shared";
import { greenRefusal } from "@/lib/green-source";
import { greenSourceFacts, pickFromFacts } from "@/lib/services/green-source";
import { roasterSiteId } from "@/lib/services/stock-locations";

/**
 * The roasting station's coordination records (Workstations W1; owner decision D10 adopts
 * WorkItemClaim and WorkstationActionLog as they are).
 *
 *   start   R2 «بدء التحميص»: a WorkItemClaim on the work (one ACTIVE claim per item, enforced by
 *           the unique activeItemRef) and a CLAIM row in the action log. NO stock moves and no batch
 *           is created (J-12): the batch, the green draw and the ledger rows happen only when the
 *           weights are recorded (POST /api/roasting-batches with this claimId).
 *   problem R7: a FLAG row (PAUSED / STOPPED_MALFUNCTION / RELEASE_REQUESTED) with the reason. The
 *           claim is NOT released and the roaster status is NOT changed (D13); no stock moves.
 *   resume  back to ROASTING after a pause.
 *   release the claimer (or an admin) gives the work back to the queue.
 *
 * Every write carries the caller's Idempotency-Key as WorkstationActionLog.idempotencyKey (unique):
 * a retry answers with the first result, and GET /api/station/actions/[key] tells the station what
 * happened to an interrupted request before it sends anything again (S6).
 *
 * Log rows name the claim: itemType "WorkItemClaim", itemId = the claim id.
 */

type Db = Prisma.TransactionClient;
type Actor = { id: string; name: string; role: string; permissions: unknown };

const AR = (ar: string, en: string, status: number, code: string) => ({ _appCode: status, message: ar, errorEn: en, code });

export type ClaimView = {
  id: string;
  itemType: string;
  itemId: string;
  claimedAt: string;
  claimedById: string;
  claimedByName: string;
  status: string;
  /** ROASTING | PAUSED | STOPPED_MALFUNCTION | RELEASE_REQUESTED (from the last log row). */
  state: string;
  stateReason: string | null;
  stateAt: string | null;
};

/** The current state of each claim: the last state-changing log row about it. */
export async function claimStates(db: Db | typeof prisma, claimIds: string[], stationType: string = ROASTING_STATION) {
  if (claimIds.length === 0) return new Map<string, { state: string; reason: string | null; at: Date }>();
  const rows = await db.workstationActionLog.findMany({
    where: { stationType, itemType: "WorkItemClaim", itemId: { in: claimIds }, status: "SUCCESS", toState: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { itemId: true, toState: true, reason: true, createdAt: true },
  });
  const out = new Map<string, { state: string; reason: string | null; at: Date }>();
  for (const r of rows) out.set(r.itemId, { state: r.toState!, reason: r.reason, at: r.createdAt });
  return out;
}

export function toClaimView(c: { id: string; itemType: string; itemId: string; claimedAt: Date; claimedById: string; claimedByName: string; status: string }, st?: { state: string; reason: string | null; at: Date }): ClaimView {
  return {
    id: c.id, itemType: c.itemType, itemId: c.itemId, claimedAt: c.claimedAt.toISOString(),
    claimedById: c.claimedById, claimedByName: c.claimedByName, status: c.status,
    state: st?.state ?? "ROASTING", stateReason: st?.reason ?? null, stateAt: st?.at.toISOString() ?? null,
  };
}

async function logAction(db: Db, a: { claimId: string; action: string; fromState: string | null; toState: string | null; user: Actor; key: string; reason?: string | null; stationType?: string }) {
  return db.workstationActionLog.create({
    data: {
      stationType: a.stationType ?? ROASTING_STATION, itemType: "WorkItemClaim", itemId: a.claimId, action: a.action,
      fromState: a.fromState, toState: a.toState, employeeId: a.user.id, employeeName: a.user.name,
      idempotencyKey: a.key, status: "SUCCESS", reason: a.reason ?? null, sourceInterface: "STATION",
    },
  });
}

/** A replay of a station write: the log row this key already wrote, or null. Someone else's key is refused. */
async function replayByKey(db: Db | typeof prisma, key: string, user: Actor) {
  const row = await db.workstationActionLog.findUnique({ where: { idempotencyKey: key } });
  if (!row) return null;
  if (row.employeeId !== user.id) throw AR("مفتاح التكرار مستخدم لعملية أخرى.", "This Idempotency-Key belongs to another action.", 422, "IDEMPOTENCY_MISMATCH");
  return row;
}

async function activeClaim(db: Db | typeof prisma, claimId: string, anyStation = false) {
  const c = await db.workItemClaim.findUnique({ where: { id: claimId } });
  if (!c || (!anyStation && c.stationType !== ROASTING_STATION)) throw AR("المهمة غير موجودة.", "Task not found.", 404, "CLAIM_NOT_FOUND");
  if (c.status !== "ACTIVE") throw AR("هذه المهمة لم تعد محجوزة. عد إلى الطابور.", "This task is no longer claimed. Go back to the queue.", 409, "CLAIM_NOT_ACTIVE");
  return c;
}

/** Can this work be started now? The item must still exist and still be roastable. */
async function assertItemStartable(db: Db, item: { type: StationItemType; id: string }) {
  if (item.type === "RoastCoffee") {
    const p = await db.coffeeProduct.findUnique({ where: { id: item.id }, select: { id: true } });
    if (!p) throw AR("القهوة غير موجودة.", "Coffee not found.", 404, "ITEM_NOT_FOUND");
    return { productId: p.id };
  }
  const po = await db.productionOrder.findUnique({ where: { id: item.id }, select: { id: true, status: true, sourceOrderItemId: true, productSku: { select: { productId: true } } } });
  if (!po || !["PENDING", "IN_PRODUCTION"].includes(po.status)) throw AR("أمر الإنتاج لم يعد مفتوحًا.", "This production order is no longer open.", 409, "ITEM_NOT_OPEN");
  return { productId: po.productSku.productId };
}

/**
 * R2 «بدء التحميص». Refused (nothing written) when: the roaster is not available; the caller is
 * not an assigned operator of it (admins pass, logged); the green is short for the roaster's usual
 * charge (J-13) — or for the slot's planned green; somebody else holds the work; or the caller
 * already has another active roast.
 *
 * From a slot of today's schedule (`slotId`): the slot must be this coffee's and this roaster's (no
 * roaster named → the slot's), and it is started (IN_PROGRESS, schedule-db startSlot: its operator or a
 * schedule manager) in THIS transaction — a refused claim leaves the slot planned. A slot already
 * started from the ERP schedule is claimed as it is.
 */
export async function startRoast(args: { user: Actor; item: { type: StationItemType; id: string }; roasterId: string | null; key: string; slotId?: string | null }) {
  const { user, item, key } = args;
  let roasterId = args.roasterId;
  const slotId = args.slotId ?? null;
  return prisma.$transaction(async (tx) => {
    const replay = await replayByKey(tx, key, user);
    if (replay) {
      const c = await tx.workItemClaim.findUnique({ where: { id: replay.itemId } });
      return { claim: c ? toClaimView(c) : null, replayed: true };
    }
    const { productId } = await assertItemStartable(tx, item);

    const slot = slotId
      ? await tx.scheduledSlot.findUnique({ where: { id: slotId }, select: { id: true, roasterId: true, productId: true, operatorId: true, startedById: true, status: true, plannedGreenKg: true } })
      : null;
    if (slotId) {
      if (!slot) throw new ScheduleError(404, "الخانة غير موجودة.", "Slot not found.", "NOT_FOUND");
      if (slot.productId !== productId) throw new ScheduleError(409, "قهوة الخانة غير قهوة الدفعة.", "The slot's coffee is not this batch's coffee.", "COFFEE_MISMATCH");
      if (roasterId && slot.roasterId !== roasterId) {
        throw new ScheduleError(409, "هذه الخانة مخططة على محمصة أخرى.", "This slot is planned on another roaster.", "SLOT_ROASTER_MISMATCH", { slotRoasterId: slot.roasterId });
      }
      roasterId = slot.roasterId;
    }

    let roasterName: string | null = null;
    let plannedGreenKg: number | null = null;
    let bypass = false;
    if (roasterId) {
      const r = await tx.roaster.findUnique({ where: { id: roasterId }, select: { id: true, name: true, status: true, defaultTargetKg: true } });
      if (!r || r.status === "RETIRED") throw AR("الحمّاصة غير موجودة أو خرجت من الخدمة.", "Roaster not found or retired.", 404, "ROASTER_NOT_FOUND");
      if (r.status !== "AVAILABLE") throw AR(`المحمصة ${r.name} غير متاحة الآن.`, `${r.name} is not available now.`, 409, "ROASTER_UNAVAILABLE");
      const op = operatorVerdict(user.role, await isAssignedOperator(tx, r.id, user.id));
      if (op.kind === "refused") throw operatorRefusal(r.name);
      bypass = op.kind === "admin_bypass";
      // The admin role exercised (identity; SIMPLE MODE waives it); the bypass is logged below.
      if (bypass) await assertAdminRoleGate(user, "production.roaster_operator_bypass");
      roasterName = r.name;
      plannedGreenKg = Number(r.defaultTargetKg);
    }
    // A slot's own planned green is the charge the green has to cover.
    if (slot) plannedGreenKg = Number(slot.plannedGreenKg);

    // J-13: the green has to be there for the usual charge before anything is claimed.
    const facts = await greenSourceFacts(tx, { productId, siteId: await roasterSiteId(tx, roasterId) });
    const pick = pickFromFacts(facts, plannedGreenKg ?? 0);
    if (!pick.ok && pick.reason === "AT_OTHER_SITE") {
      // Enough in the company, not at the production site: it waits for the supervisor's transfer.
      const m = greenRefusal(pick, plannedGreenKg ?? 0);
      throw AR(m.ar, m.en, 409, "GREEN_AT_OTHER_SITE");
    }
    if (!pick.ok) {
      throw AR(
        `لا يمكن البدء: البن الأخضر غير كافٍ. المطلوب ${(plannedGreenKg ?? 0).toFixed(2)} كغ والمتاح ${pick.availableKg.toFixed(2)} كغ.`,
        `Cannot start: not enough green coffee. ${(plannedGreenKg ?? 0).toFixed(2)} kg needed, ${pick.availableKg.toFixed(2)} kg available.`,
        409, "GREEN_SHORT",
      );
    }

    // The slot starts with the claim (same transaction: any refusal below rolls it back).
    if (slot && slot.status === "IN_PROGRESS") {
      const can = scheduleCan({ permissions: user.permissions as Permissions });
      if (!can.manage && slot.operatorId !== user.id && slot.startedById !== user.id) {
        throw new ScheduleError(403, "يبدأ الخانة مشغّلها أو من يدير الجدول.", "A slot is started by its operator or by a schedule manager.", "FORBIDDEN");
      }
    } else if (slot) {
      await startSlot(tx, slot.id, { id: user.id, name: user.name, can: scheduleCan({ permissions: user.permissions as Permissions }) });
    }

    const mine = await tx.workItemClaim.findFirst({ where: { stationType: ROASTING_STATION, status: "ACTIVE", claimedById: user.id } });
    const itemRef = `${item.type}:${item.id}`;
    if (mine && mine.itemRef === itemRef) return { claim: toClaimView(mine), replayed: true };
    if (mine) throw AR("لديك دفعة نشطة. أنهِها أو حرّرها قبل بدء أخرى.", "You already have an active roast. Finish or release it first.", 409, "ONE_ACTIVE_ROAST");
    const taken = await tx.workItemClaim.findUnique({ where: { activeItemRef: itemRef } });
    if (taken) throw AR(`يعمل على هذه الدفعة ${taken.claimedByName} الآن.`, `${taken.claimedByName} is working on this batch now.`, 409, "CLAIM_TAKEN");

    const claim = await tx.workItemClaim.create({
      data: { stationType: ROASTING_STATION, itemType: item.type, itemId: item.id, itemRef, activeItemRef: itemRef, claimedById: user.id, claimedByName: user.name, status: "ACTIVE" },
    });
    await logAction(tx, {
      claimId: claim.id, action: "CLAIM", fromState: "QUEUED", toState: "ROASTING", user, key,
      reason: [roasterName ? `roaster: ${roasterName}` : null, slot ? `slot: ${slot.id}` : null, bypass ? "admin: not an assigned operator (never blocked)" : null].filter(Boolean).join(" · ") || null,
    });
    return { claim: toClaimView(claim), replayed: false };
  }, TX_OPTS);
}

/** R7: record a problem. The claim stays with the caller; nothing else changes (D13, W4). */
export async function reportProblem(args: { user: Actor; claimId: string; kind: unknown; reason: unknown; note: unknown; key: string }) {
  const { user, claimId, key } = args;
  if (!PROBLEM_KINDS.includes(args.kind as ProblemKind)) throw AR("اختر نوع المشكلة.", "Choose what kind of problem this is.", 400, "PROBLEM_KIND_REQUIRED");
  if (!PROBLEM_REASONS.includes(args.reason as (typeof PROBLEM_REASONS)[number])) throw AR("اختر ماذا حدث.", "Choose what happened.", 400, "PROBLEM_REASON_REQUIRED");
  const note = typeof args.note === "string" ? args.note.trim().slice(0, 300) : "";
  const kind = args.kind as ProblemKind;
  return prisma.$transaction(async (tx) => {
    const replay = await replayByKey(tx, key, user);
    if (replay) return { log: replay, replayed: true };
    const c = await activeClaim(tx, claimId);
    if (c.claimedById !== user.id) throw AR("هذه المهمة محجوزة لموظف آخر.", "This task is claimed by somebody else.", 403, "NOT_YOUR_CLAIM");
    const prev = (await claimStates(tx, [c.id])).get(c.id)?.state ?? "ROASTING";
    const log = await logAction(tx, { claimId: c.id, action: "FLAG", fromState: prev, toState: PROBLEM_STATE[kind], user, key, reason: [kind, args.reason as string, note || null].filter(Boolean).join(" · ") });
    // feat/notifications: the schedule / roaster managers are told (production.station_problem).
    const KIND_AR: Record<ProblemKind, string> = { PAUSE: "إيقاف مؤقت", MALFUNCTION: "عطل في المحمصة", RELEASE_REQUEST: "طلب تحرير المهمة" };
    const KIND_EN: Record<ProblemKind, string> = { PAUSE: "paused", MALFUNCTION: "roaster malfunction", RELEASE_REQUEST: "release requested" };
    const REASON_AR: Record<string, string> = { BURNER_STOPPED: "توقف الموقد", IRREGULAR_HEAT: "حرارة غير منتظمة", COOLING_PROBLEM: "مشكلة في التبريد", OTHER: "أخرى" };
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, {
      event: "production.station_problem", dedupeKey: key, actorId: user.id, entity: { type: "WorkItemClaim", id: c.id },
      facts: { kindAr: KIND_AR[kind], kindEn: KIND_EN[kind], byName: user.name, reason: [REASON_AR[args.reason as string] ?? String(args.reason), note || null].filter(Boolean).join(" · ") },
    });
    return { log, replayed: false };
  }, TX_OPTS);
}

/** Back to work after a pause (or once a malfunction is cleared by the supervisor). */
export async function resumeClaim(args: { user: Actor; claimId: string; key: string }) {
  const { user, claimId, key } = args;
  return prisma.$transaction(async (tx) => {
    const replay = await replayByKey(tx, key, user);
    if (replay) return { log: replay, replayed: true };
    const c = await activeClaim(tx, claimId);
    if (c.claimedById !== user.id) throw AR("هذه المهمة محجوزة لموظف آخر.", "This task is claimed by somebody else.", 403, "NOT_YOUR_CLAIM");
    const prev = (await claimStates(tx, [c.id])).get(c.id)?.state ?? "ROASTING";
    const log = await logAction(tx, { claimId: c.id, action: "RESUME", fromState: prev, toState: "ROASTING", user, key });
    return { log, replayed: false };
  }, TX_OPTS);
}

/** Give the work back to the queue: the claimer, or an admin (supervision). Never silent. */
export async function releaseClaim(args: { user: Actor; claimId: string; key: string; anyStation?: boolean }) {
  const { user, claimId, key } = args;
  return prisma.$transaction(async (tx) => {
    const replay = await replayByKey(tx, key, user);
    if (replay) return { log: replay, replayed: true };
    // The roasting routes release roasting claims; S5 (endStationSession) releases any station's
    // claim of the outgoing employee (W4: the packaging station's order claims too).
    const c = await activeClaim(tx, claimId, args.anyStation === true);
    const supervising = c.claimedById !== user.id;
    if (supervising && user.role !== "admin") throw AR("يحرر المهمة صاحبها أو المسؤول فقط.", "Only the employee who claimed it, or an administrator, can release this task.", 403, "NOT_YOUR_CLAIM");
    // Releasing somebody else's work is the admin role exercised: the admin-role gate (identity).
    if (supervising) await assertAdminRoleGate(user, "station.release_claim");
    const prev = (await claimStates(tx, [c.id], c.stationType)).get(c.id)?.state ?? (c.stationType === ROASTING_STATION ? "ROASTING" : "PREPARING");
    await tx.workItemClaim.update({ where: { id: c.id }, data: { status: "RELEASED", activeItemRef: null, releasedAt: new Date(), releasedById: user.id, releasedByName: user.name } });
    const log = await logAction(tx, { claimId: c.id, action: "RELEASE", fromState: prev, toState: "QUEUED", user, key, stationType: c.stationType });
    return { log, replayed: false };
  }, TX_OPTS);
}

/**
 * Called by POST /api/roasting-batches inside its transaction when the station records the
 * weights of a claimed roast: the claim ends (released by its owner, with the batch) and the log
 * says so. A loss reason, when the loss was above the boundary, is kept on that row.
 */
export async function completeStationClaim(
  tx: Db,
  args: { claimId: string; user: { id: string; name: string }; batch: { id: string; batchNumber: string }; requestKey: string | null; lossReason: string | null; body: { productId: unknown; productionOrderId: unknown } },
) {
  const c = await tx.workItemClaim.findUnique({ where: { id: args.claimId } });
  if (!c || c.stationType !== ROASTING_STATION) throw AR("المهمة غير موجودة.", "Task not found.", 404, "CLAIM_NOT_FOUND");
  if (c.status !== "ACTIVE") throw AR("هذه المهمة لم تعد محجوزة. عد إلى الطابور.", "This task is no longer claimed. Go back to the queue.", 409, "CLAIM_NOT_ACTIVE");
  if (c.claimedById !== args.user.id) throw AR("هذه المهمة محجوزة لموظف آخر.", "This task is claimed by somebody else.", 403, "NOT_YOUR_CLAIM");
  // The roast must be the work that was claimed.
  const matches = c.itemType === "RoastCoffee" ? args.body.productId === c.itemId : c.itemType === "ProductionOrder" ? args.body.productionOrderId === c.itemId : false;
  if (!matches) throw AR("الدفعة لا تطابق المهمة المحجوزة.", "This roast does not match the claimed task.", 409, "CLAIM_MISMATCH");
  if (args.lossReason && !LOSS_REASONS.includes(args.lossReason as (typeof LOSS_REASONS)[number])) {
    throw AR("سبب الفاقد غير معروف.", "Unknown loss reason.", 400, "LOSS_REASON_INVALID");
  }
  const prev = (await claimStates(tx, [c.id])).get(c.id)?.state ?? "ROASTING";
  await tx.workItemClaim.update({ where: { id: c.id }, data: { status: "RELEASED", activeItemRef: null, releasedAt: new Date(), releasedById: args.user.id, releasedByName: args.user.name } });
  await tx.workstationActionLog.create({
    data: {
      stationType: ROASTING_STATION, itemType: "WorkItemClaim", itemId: c.id, action: "ADVANCE:RECORDED",
      fromState: prev, toState: "RECORDED", employeeId: args.user.id, employeeName: args.user.name,
      // The roast's own key is the batch's (RoastingBatch.requestKey); the log row needs its own.
      idempotencyKey: args.requestKey ? `roast:${args.requestKey}` : `srv-${randomUUID()}`,
      status: "SUCCESS",
      reason: [`batch ${args.batch.batchNumber}`, args.lossReason ? `loss: ${args.lossReason}` : null].filter(Boolean).join(" · "),
      sourceInterface: "STATION",
    },
  });
}
