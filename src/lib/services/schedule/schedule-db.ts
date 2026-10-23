// Roasting schedule «جدول التحميص» — reads and writes (RM6–RM8; ROASTERS.md §4–§6, migration
// 20261026090000_roast_schedule). The rules are planner.ts; this file gathers the facts they need and
// writes slots only after re-checking them inside one transaction under one advisory lock.
//
// One source of truth for the demand: the roast queue (src/lib/services/roast-queue.ts, the same
// requirement the production screen's «جدول التحميص» list and the roast sheet use). Nothing here
// creates a batch, moves stock or changes an order (§5.9).
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { roastQueue, type QueueCoffee } from "@/lib/services/roast-queue";
import { resolveBatchCoffeeIdentity } from "@/lib/services/batch-identity";
import { canOperate } from "@/lib/services/settings/roasters";
import { employeeNames } from "@/lib/services/settings/roasters-db";
import { assignedOperatorIds } from "@/lib/services/roaster-operators";
import {
  addDays, batchWithinLimits, effectiveStatus, findConflicts, hoursOf, insideWorkingHours, isLive, kg2, placeSlots, planQuantities,
  riyadhKey, riyadhMidnight, splitGreen, splitText, workWindow, type Interval, type Limits, type Quantities, type Rule, type SlotLike,
  type SlotStatus, type Split, type WorkingHours,
} from "./planner";

type Db = PrismaClient | Prisma.TransactionClient;
const num = (d: { toString(): string } | number | null | undefined) => (d === null || d === undefined ? 0 : Number(d.toString()));
const LOCK = "production.schedule";
export const HORIZON_DAYS = 14;

/** A refusal: the route answers it as { error (Arabic), errorEn, code, ...extra } with this status. */
export class ScheduleError extends Error {
  constructor(public status: number, public ar: string, public en: string, public code: string, public extra: Record<string, unknown> = {}) {
    super(en);
  }
  body() { return { error: this.ar, errorEn: this.en, code: this.code, ...this.extra }; }
}

// ── Who may do what (§6) ────────────────────────────────────────────────────────────────────

export type ScheduleCan = { view: boolean; manage: boolean; roastToStock: boolean; startBatch: boolean; manageRoasters: boolean };
export function scheduleCan(u: { permissions: Permissions }): ScheduleCan {
  const p = u.permissions;
  return {
    // The administrator's permissions hold every module (role defaults / SIMPLE MODE), so no role check is needed.
    view: hasModuleAccess(p, "production"),
    manage: hasSubPrivilege(p, "production", "manage_schedule"),
    roastToStock: hasSubPrivilege(p, "production", "roast_to_stock"),
    startBatch: hasSubPrivilege(p, "production", "start_batch"),
    // Roaster configuration stays with the admin role (the settings routes); the key is offered for delegation.
    manageRoasters: hasSubPrivilege(p, "production", "manage_roasters"),
  };
}

// ── Facts ───────────────────────────────────────────────────────────────────────────────────

type RoasterRow = Awaited<ReturnType<typeof readRoasters>>[number];

/** Production roasters in service (sample roasters are never offered for production, D7), default first. */
export async function readRoasters(db: Db) {
  return db.roaster.findMany({
    where: { type: "PRODUCTION", status: { not: "RETIRED" } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
}

export function limitsOf(r: { minBatchKg: unknown; defaultTargetKg: unknown; maxBatchKg: unknown; nominalCapacityKg: unknown }): Limits {
  return { minKg: num(r.minBatchKg as never), targetKg: num(r.defaultTargetKg as never), maxKg: num(r.maxBatchKg as never), nominalKg: num(r.nominalCapacityKg as never) };
}

function roasterOut(r: RoasterRow) {
  const l = limitsOf(r);
  return {
    id: r.id, name: r.name, status: r.status, statusReason: r.statusReason, isDefault: r.isDefault, cycleMinutes: r.cycleMinutes,
    nominalKg: kg2(l.nominalKg), targetKg: kg2(l.targetKg), minKg: kg2(l.minKg), maxKg: kg2(l.maxKg),
    workingHours: hoursOf(r.workingHours), workingHoursSet: r.workingHours !== null, defaultOperatorId: r.defaultOperatorId,
  };
}

/**
 * The operators a slot on this roaster may be given: assigned (RoasterOperator — the same source as the
 * roast POST's 403 ROASTER_OPERATOR_REQUIRED, roaster-operators.ts) AND holding production › start_batch now.
 */
export async function eligibleOperators(db: Db, roasterId: string): Promise<{ id: string; name: string }[]> {
  const ids = await assignedOperatorIds(db, roasterId);
  if (ids.length === 0) return [];
  const people = await db.employee.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, role: true, permissions: true, active: true },
    orderBy: { name: "asc" },
  });
  return people.filter(canOperate).map((p) => ({ id: p.id, name: p.name }));
}

type SlotRow = Prisma.ScheduledSlotGetPayload<{ include: { batch: { select: { id: true } } } }>;

const slotLike = (s: { id: string; roasterId: string; operatorId: string; startsAt: Date; endsAt: Date }): SlotLike =>
  ({ id: s.id, roasterId: s.roasterId, operatorId: s.operatorId, start: +s.startsAt, end: +s.endsAt });

/** Slots that may still be live (stored PLANNED / IN_PROGRESS, no batch) overlapping [from, to); then filtered by the derived status. */
export async function liveSlots(db: Db, o: { from: Date; to: Date; roasterId?: string; operatorId?: string; productId?: string; now?: Date }): Promise<SlotRow[]> {
  const rows = await db.scheduledSlot.findMany({
    where: {
      status: { in: ["PLANNED", "IN_PROGRESS"] }, batch: null,
      startsAt: { lt: o.to }, endsAt: { gt: o.from },
      ...(o.roasterId ? { roasterId: o.roasterId } : {}),
      ...(o.operatorId ? { operatorId: o.operatorId } : {}),
      ...(o.productId ? { productId: o.productId } : {}),
    },
    include: { batch: { select: { id: true } } },
    orderBy: { startsAt: "asc" },
  });
  const now = o.now ?? new Date();
  return rows.filter((s) => isLive(effectiveStatus({ status: s.status, endsAt: s.endsAt, hasBatch: !!s.batch }, now)));
}

/** Planned maintenance windows of a roaster overlapping [from, to) — they block slots (§5.4). */
async function maintenanceWindows(db: Db, roasterId: string, from: Date, to: Date): Promise<Interval[]> {
  const rows = await db.roasterMaintenance.findMany({
    where: { roasterId, status: { in: ["PLANNED", "IN_PROGRESS"] }, startsAt: { lt: to }, endsAt: { gt: from } },
    select: { startsAt: true, endsAt: true },
  });
  return rows.map((m) => ({ start: +m.startsAt, end: +m.endsAt }));
}

/**
 * The roaster a recorded batch was roasted on, for the board's lanes: RoastingBatch.roasterId (the
 * column migration 20261025090000_station_w1 adds; the roast POST writes it when a roaster is chosen),
 * then the slot the batch was recorded from, then the only production roaster when there is exactly one.
 * Otherwise null («دفعات بلا محمصة»).
 */
export function batchRoasterId(batch: { roasterId: string | null; scheduledSlot?: { roasterId: string } | null }, soleRoasterId: string | null): string | null {
  return batch.roasterId || batch.scheduledSlot?.roasterId || soleRoasterId;
}

const productName = (p: { productNameAr: string | null; productNameEn: string } | null | undefined) => ({ ar: p?.productNameAr || p?.productNameEn || "—", en: p?.productNameEn || "—" });

/** A slot as the API returns it (the board, the tables, the station queue). */
function slotOut(s: SlotRow & { product?: { productNameAr: string | null; productNameEn: string } | null; batchFull?: BatchLite | null }, names: Map<string, string>, now: Date) {
  const st = effectiveStatus({ status: s.status, endsAt: s.endsAt, hasBatch: !!s.batch }, now);
  return {
    id: s.id, planId: s.planId, roasterId: s.roasterId, operatorId: s.operatorId, operatorName: names.get(s.operatorId) ?? null,
    productId: s.productId, product: productName(s.product), purpose: s.purpose,
    startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), plannedGreenKg: kg2(num(s.plannedGreenKg)),
    status: st, storedStatus: s.status, startedAt: s.startedAt?.toISOString() ?? null, cancelReason: s.cancelReason,
    batch: s.batchFull ?? null,
  };
}
export type SlotOut = ReturnType<typeof slotOut>;

type BatchLite = { id: string; batchNumber: string; status: string; greenKg: string; roastedKg: string; recordedAt: string };
const batchLite = (b: { id: string; batchNumber: string; status: string; greenBeanQuantity: number; roastedBeanQuantity: number; createdAt: Date }): BatchLite =>
  ({ id: b.id, batchNumber: b.batchNumber, status: b.status, greenKg: kg2(b.greenBeanQuantity), roastedKg: kg2(b.roastedBeanQuantity), recordedAt: b.createdAt.toISOString() });

async function slotsWithDetails(db: Db, where: Prisma.ScheduledSlotWhereInput, now: Date, take?: number) {
  const rows = await db.scheduledSlot.findMany({
    where, orderBy: { startsAt: "asc" }, take,
    include: {
      batch: { select: { id: true, batchNumber: true, status: true, greenBeanQuantity: true, roastedBeanQuantity: true, createdAt: true } },
      product: { select: { productNameAr: true, productNameEn: true } },
    },
  });
  const names = await employeeNames(db, rows.map((r) => r.operatorId));
  return rows.map((r) => slotOut({ ...r, batch: r.batch ? { id: r.batch.id } : null, batchFull: r.batch ? batchLite(r.batch) : null }, names, now));
}

// ── RM6 · the day ───────────────────────────────────────────────────────────────────────────

/** RM6: every production roaster's lane for one Riyadh day — working window, maintenance, slots and the recorded batches — and the coming slots. */
export async function dayBoard(db: Db, dayKey: string, now = new Date()) {
  const roasters = await readRoasters(db);
  const from = new Date(riyadhMidnight(dayKey)), to = new Date(riyadhMidnight(addDays(dayKey, 1)));
  const slots = await slotsWithDetails(db, { startsAt: { gte: from, lt: to }, status: { not: "CANCELLED" } }, now);
  const sole = roasters.length === 1 ? roasters[0].id : null;
  // Every scalar of the batch (no select): RoastingBatch.roasterId decides the lane (batchRoasterId).
  const batches = await db.roastingBatch.findMany({
    where: { createdAt: { gte: from, lt: to }, isBlend: false, scheduledSlotId: null },
    include: { scheduledSlot: { select: { roasterId: true } }, product: { select: { productNameAr: true, productNameEn: true } }, orderItem: { select: { beanTypeName: true, productSku: { select: { product: { select: { productNameAr: true, productNameEn: true } } } } } } },
    orderBy: { createdAt: "asc" },
  });
  const maint = await db.roasterMaintenance.findMany({
    where: { roasterId: { in: roasters.map((r) => r.id) }, status: { in: ["PLANNED", "IN_PROGRESS"] }, startsAt: { lt: to }, endsAt: { gt: from } },
    select: { id: true, roasterId: true, title: true, startsAt: true, endsAt: true },
  });
  const unslotted = batches.map((b) => ({
    ...batchLite(b),
    roasterId: batchRoasterId(b, sole),
    product: productName(b.product ?? b.orderItem?.productSku?.product ?? (b.orderItem ? { productNameAr: b.orderItem.beanTypeName, productNameEn: b.orderItem.beanTypeName } : null)),
  }));
  // The coming slots: planned ones still ahead, and every started one not recorded yet (its end may have passed).
  const upcomingAll = await slotsWithDetails(db, { batch: null, OR: [{ status: "PLANNED", endsAt: { gt: now } }, { status: "IN_PROGRESS", endsAt: { gt: new Date(+now - 86_400_000) } }] }, now, 200);
  const upcoming = upcomingAll.filter((s) => s.status === "PLANNED" || s.status === "IN_PROGRESS");
  const count = (st: SlotStatus) => slots.filter((s) => s.status === st).length;
  return {
    day: dayKey, today: riyadhKey(now), now: now.toISOString(),
    roasters: roasters.map((r) => {
      const out = roasterOut(r);
      const w = workWindow(dayKey, out.workingHours);
      return {
        ...out,
        window: w ? { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() } : null,
        maintenance: maint.filter((m) => m.roasterId === r.id).map((m) => ({ id: m.id, title: m.title, startsAt: m.startsAt.toISOString(), endsAt: m.endsAt.toISOString() })),
        slots: slots.filter((s) => s.roasterId === r.id),
        batches: unslotted.filter((b) => b.roasterId === r.id),
      };
    }),
    /** Recorded batches of the day that no lane can claim (several roasters, no roaster on the batch). */
    unassignedBatches: unslotted.filter((b) => !b.roasterId || !roasters.some((r) => r.id === b.roasterId)),
    upcoming: upcoming.slice(0, 8),
    upcomingTotal: upcoming.length,
    counts: {
      recorded: count("RECORDED") + unslotted.length, rejected: [...unslotted, ...slots.map((s) => s.batch).filter(Boolean) as BatchLite[]].filter((b) => b.status === "Rejected").length,
      inProgress: count("IN_PROGRESS"), planned: count("PLANNED"), missed: count("MISSED"),
    },
  };
}

/** The live slots of today (Riyadh) for a roaster and / or operator — for the station's R1 queue after the merge. */
export async function todaySlotsFor(db: Db, o: { roasterId?: string; operatorId?: string; now?: Date }) {
  const now = o.now ?? new Date();
  const key = riyadhKey(now);
  const all = await slotsWithDetails(db, {
    startsAt: { gte: new Date(riyadhMidnight(key)), lt: new Date(riyadhMidnight(addDays(key, 1))) },
    status: { in: ["PLANNED", "IN_PROGRESS"] }, batch: null,
    ...(o.roasterId ? { roasterId: o.roasterId } : {}), ...(o.operatorId ? { operatorId: o.operatorId } : {}),
  }, now);
  return all.filter((s) => s.status === "PLANNED" || s.status === "IN_PROGRESS");
}

// ── RM7 · planning ──────────────────────────────────────────────────────────────────────────

export type PlanRequest = {
  productId: string;
  roasterId?: string | null;
  operatorId?: string | null;
  /** «البديل» (§5.2) instead of the proposal. */
  split?: "PROPOSED" | "ALTERNATIVE";
  /** An authorized planning decision (§5.3): plan this green instead of the computed one. */
  overrideGreenKg?: number | null;
  /** Edited slots («تعديل الخانات»): the start and operator of each, in order. */
  slots?: { startsAt: string; operatorId: string }[] | null;
};

export type PlanPreview = Awaited<ReturnType<typeof planPreview>>;

async function demandOf(db: Db, productId: string): Promise<{ coffee: QueueCoffee | null; product: { id: string; productNameAr: string | null; productNameEn: string; expectedRoastLoss: number; isActive: boolean } | null }> {
  const product = await db.coffeeProduct.findUnique({ where: { id: productId }, select: { id: true, productNameAr: true, productNameEn: true, expectedRoastLoss: true, isActive: true } });
  if (!product) return { coffee: null, product: null };
  const queue = await roastQueue(db as Prisma.TransactionClient, { productId });
  return { coffee: queue.find((c) => c.productId === productId) ?? null, product };
}

/** §5.1 for one coffee: the queue's remaining roasted kg, minus what running and approved slots already cover. */
export async function quantitiesFor(db: Db, productId: string, now = new Date()) {
  const { coffee, product } = await demandOf(db, productId);
  if (!product) return null;
  const live = await liveSlots(db, { from: new Date(+now - 2 * 86_400_000), to: new Date(+now + 400 * 86_400_000), productId, now });
  const st = (s: SlotRow) => effectiveStatus({ status: s.status, endsAt: s.endsAt, hasBatch: !!s.batch }, now);
  const running = live.filter((s) => st(s) === "IN_PROGRESS");
  const approved = live.filter((s) => st(s) === "PLANNED");
  const q = planQuantities({
    remainingKg: coffee?.demandKg ?? 0, expectedLossPct: product.expectedRoastLoss,
    inProgressKg: running.reduce((a, s) => a + num(s.plannedGreenKg), 0),
    approvedKg: approved.reduce((a, s) => a + num(s.plannedGreenKg), 0),
  });
  return {
    product, coffee, q,
    running: running.map((s) => ({ id: s.id, startsAt: s.startsAt.toISOString(), startedAt: s.startedAt?.toISOString() ?? null, kg: kg2(num(s.plannedGreenKg)) })),
    approvedCount: approved.length,
  };
}

/**
 * RM7: the inputs, the target split against the proposed split (and «البديل»), the rules, and the
 * slots the plan would reserve. Read-only; «اعتماد الخطة» (approvePlan) re-runs exactly this inside its
 * transaction and refuses if anything moved.
 */
export async function planPreview(db: Db, req: PlanRequest, now = new Date()) {
  const facts = await quantitiesFor(db, req.productId, now);
  if (!facts) throw new ScheduleError(404, "القهوة غير موجودة.", "Coffee not found.", "NOT_FOUND");
  const roasters = await readRoasters(db);
  if (roasters.length === 0) throw new ScheduleError(409, "لا توجد محمصة إنتاج مسجّلة. أضفها من الإعدادات أولًا.", "No production roaster is registered. Add one in Settings first.", "NO_ROASTER");
  const roaster = (req.roasterId ? roasters.find((r) => r.id === req.roasterId) : null) ?? (req.roasterId ? null : roasters[0]);
  if (!roaster) throw new ScheduleError(404, "المحمصة غير موجودة.", "Roaster not found.", "NOT_FOUND");
  const limits = limitsOf(roaster);
  const hours = hoursOf(roaster.workingHours);
  const operators = await eligibleOperators(db, roaster.id);
  const operatorId = req.operatorId ?? (operators.some((o) => o.id === roaster.defaultOperatorId) ? roaster.defaultOperatorId : operators[0]?.id ?? null);
  const operatorOk = !!operatorId && operators.some((o) => o.id === operatorId);

  const override = typeof req.overrideGreenKg === "number" && Number.isFinite(req.overrideGreenKg) ? Math.max(0, req.overrideGreenKg) : null;
  const greenKg = override ?? facts.q.greenToPlanKg;
  const split = splitGreen(greenKg, limits);
  const useAlt = req.split === "ALTERNATIVE" && split.ok && !!split.alternative;
  const chosen: Split | null = split.ok ? (useAlt ? split.alternative! : split.proposed) : null;

  // Placement: around the roaster's live slots, its planned maintenance and the operator's live slots on every roaster.
  const horizon = new Date(+now + (HORIZON_DAYS + 1) * 86_400_000);
  const roasterBusy = (await liveSlots(db, { from: now, to: horizon, roasterId: roaster.id, now })).map(slotLike);
  const maint = await maintenanceWindows(db, roaster.id, now, horizon);
  const opBusy = operatorId ? (await liveSlots(db, { from: now, to: horizon, operatorId, now })).filter((s) => s.roasterId !== roaster.id).map(slotLike) : [];
  const available = roaster.status === "AVAILABLE";

  type Draft = { index: number; startsAt: string; endsAt: string; kg: string; operatorId: string | null; conflict: null | "MACHINE" | "OPERATOR" | "HOURS" | "MAINTENANCE" | "PAST" | "OPERATOR_NOT_ASSIGNED" };
  let drafts: Draft[] = [];
  let placed = false;
  if (chosen && available) {
    const len = roaster.cycleMinutes * 60_000;
    if (req.slots && req.slots.length) {
      // Edited slots: the same count as the split; each checked, conflicts named per row.
      if (req.slots.length !== chosen.count) throw new ScheduleError(400, "عدد الخانات لا يطابق التقسيم.", "The number of slots does not match the split.", "SLOT_COUNT");
      const cands: (SlotLike & { key: string })[] = [];
      drafts = req.slots.map((s, i) => {
        const start = Date.parse(s.startsAt);
        if (!Number.isFinite(start)) throw new ScheduleError(400, "وقت خانة غير صالح.", "A slot time is not valid.", "INVALID_TIME");
        const op = typeof s.operatorId === "string" ? s.operatorId : null;
        cands.push({ key: `n${i}`, roasterId: roaster.id, operatorId: op ?? "", start, end: start + len });
        return { index: i + 1, startsAt: new Date(start).toISOString(), endsAt: new Date(start + len).toISOString(), kg: kg2(chosen.batches[i]), operatorId: op, conflict: null };
      });
      const opIds = [...new Set(cands.map((c) => c.operatorId).filter((x) => x && x !== operatorId))];
      const otherOpBusy: SlotLike[] = [];
      for (const id of opIds) otherOpBusy.push(...(await liveSlots(db, { from: now, to: horizon, operatorId: id, now })).filter((s) => s.roasterId !== roaster.id).map(slotLike));
      const conflicts = findConflicts(cands, [...roasterBusy, ...opBusy, ...otherOpBusy]);
      drafts.forEach((d, i) => {
        const c = cands[i];
        if (!d.operatorId || !operators.some((o) => o.id === d.operatorId)) d.conflict = "OPERATOR_NOT_ASSIGNED";
        else if (c.start <= +now) d.conflict = "PAST";
        else if (!insideWorkingHours(c, hours)) d.conflict = "HOURS";
        else if (maint.some((m) => m.start < c.end && c.start < m.end)) d.conflict = "MAINTENANCE";
        else {
          const hit = conflicts.find((x) => x.a.key === c.key || x.b.key === c.key);
          if (hit) d.conflict = hit.kind;
        }
      });
      placed = true;
    } else if (operatorOk) {
      const p = placeSlots({ count: chosen.count, cycleMinutes: roaster.cycleMinutes, from: now, hours, busy: [...roasterBusy, ...maint, ...opBusy], horizonDays: HORIZON_DAYS });
      drafts = p.starts.map((s, i) => ({ index: i + 1, startsAt: new Date(s).toISOString(), endsAt: new Date(s + len).toISOString(), kg: kg2(chosen.batches[i]), operatorId, conflict: null }));
      placed = p.complete;
    }
  }

  const today = riyadhKey(now);
  const days = [...new Set(drafts.map((d) => riyadhKey(Date.parse(d.startsAt))))];
  const nextMaint = await db.roasterMaintenance.findFirst({ where: { roasterId: roaster.id, status: { in: ["PLANNED", "IN_PROGRESS"] }, endsAt: { gt: now } }, orderBy: { startsAt: "asc" }, select: { title: true, startsAt: true, endsAt: true } });
  const lastEnd = drafts.length ? Date.parse(drafts[drafts.length - 1].endsAt) : null;
  const opName = operatorId ? operators.find((o) => o.id === operatorId)?.name ?? (await employeeNames(db, [operatorId])).get(operatorId) ?? null : null;
  const assignedRoasters = operatorId ? await db.roasterOperator.findMany({ where: { employeeId: operatorId }, select: { roaster: { select: { name: true, status: true } } } }) : [];

  const rules: (Rule & { detail: Record<string, unknown> })[] = [];
  if (split.ok && chosen) {
    const lo = Math.min(...chosen.batches), hi = Math.max(...chosen.batches);
    rules.push({ key: "LIMITS", state: chosen.batches.every((b) => batchWithinLimits(b, limits)) ? "ok" : "fail", detail: { min: kg2(limits.minKg), max: kg2(limits.maxKg), lo: kg2(lo), hi: kg2(hi) } });
    rules.push({ key: "LAST_BATCH", state: "ok", detail: { remainder: kg2(split.target.remainderKg), redistributed: split.redistributed, count: chosen.count, alternative: split.alternative ? splitText(split.alternative) : null, alternativeCount: split.alternative?.count ?? null, alternativeKg: split.alternative ? kg2(split.alternative.batches[0]) : null } });
  } else if (!split.ok) {
    rules.push({ key: "LIMITS", state: split.reason === "NOTHING_TO_PLAN" ? "warn" : "fail", detail: { reason: split.reason, green: kg2(split.greenKg), min: kg2(limits.minKg), max: kg2(limits.maxKg) } });
  }
  const maintInPlan = nextMaint && lastEnd ? +nextMaint.startsAt < lastEnd : false;
  rules.push({ key: "ROASTER", state: available ? "ok" : "fail", detail: { status: roaster.status, reason: roaster.statusReason, nextMaintenance: nextMaint ? { title: nextMaint.title, startsAt: nextMaint.startsAt.toISOString(), outsidePlan: !maintInPlan } : null } });
  const opConflict = drafts.some((d) => d.conflict === "OPERATOR" || d.conflict === "OPERATOR_NOT_ASSIGNED");
  rules.push({ key: "OPERATOR", state: !operatorOk || opConflict ? "fail" : "ok", detail: { operatorName: opName, assigned: operatorOk, roasters: assignedRoasters.filter((a) => a.roaster.status !== "RETIRED").map((a) => a.roaster.name), eligible: operators.length } });
  const otherConflict = drafts.some((d) => d.conflict && d.conflict !== "OPERATOR" && d.conflict !== "OPERATOR_NOT_ASSIGNED");
  if (chosen && available && operatorOk) rules.push({ key: "TIME", state: placed && !otherConflict ? "ok" : "fail", detail: { placed: drafts.length, needed: chosen.count, horizonDays: HORIZON_DAYS } });
  if (days.length > 1 || (days.length === 1 && days[0] !== today)) rules.push({ key: "SPANS", state: "warn", detail: { today: drafts.filter((d) => riyadhKey(Date.parse(d.startsAt)) === today).length, later: drafts.filter((d) => riyadhKey(Date.parse(d.startsAt)) !== today).length, days: days.length } });

  const blocked = rules.some((r) => r.state === "fail") || !chosen || drafts.length !== chosen.count || drafts.some((d) => d.conflict);
  const purpose: "DEMAND" | "STOCK" = facts.q.greenToPlanKg > 0 ? "DEMAND" : "STOCK";
  return {
    now: now.toISOString(),
    product: { id: facts.product.id, name: productName(facts.product), expectedLossPct: facts.q.expectedLossPct },
    demand: facts.coffee ? { openKg: kg2(facts.coffee.openKg), shelfKg: kg2(facts.coffee.shelfKg), pipelineKg: kg2(facts.coffee.pipelineKg), orders: facts.coffee.orders.slice(0, 6).map((o) => ({ orderNumber: o.orderNumber, customerName: o.customerName, needKg: kg2(o.needKg) })) } : null,
    quantities: { ...strQ(facts.q), running: facts.running, approvedSlots: facts.approvedCount },
    override: override !== null ? kg2(override) : null,
    greenKg: kg2(greenKg),
    purpose,
    roasters: roasters.map(roasterOut),
    roaster: roasterOut(roaster),
    operators,
    operatorId,
    split: split.ok
      ? {
          ok: true as const,
          target: { ...split.target, remainderKg: kg2(split.target.remainderKg), targetKg: kg2(limits.targetKg) },
          proposed: splitOut(split.proposed), alternative: split.alternative ? splitOut(split.alternative) : null,
          redistributed: split.redistributed, chosen: useAlt ? ("ALTERNATIVE" as const) : ("PROPOSED" as const),
        }
      : { ok: false as const, reason: split.reason, greenKg: kg2(split.greenKg), minKg: kg2(split.minKg), maxKg: kg2(split.maxKg) },
    slots: drafts.map((d) => ({ ...d, operatorName: d.operatorId ? operators.find((o) => o.id === d.operatorId)?.name ?? null : null })),
    expectedRoastedKg: chosen ? kg2(chosen.batches.reduce((a, b) => a + b, 0) * (1 - facts.q.expectedLossPct / 100)) : null,
    rules,
    blocked,
  };
}

const strQ = (q: Quantities) => ({
  remainingKg: kg2(q.remainingKg), requiredGreenKg: kg2(q.requiredGreenKg), inProgressKg: kg2(q.inProgressKg), approvedKg: kg2(q.approvedKg), greenToPlanKg: kg2(q.greenToPlanKg), expectedLossPct: q.expectedLossPct,
});
const splitOut = (s: Split) => ({ count: s.count, text: splitText(s), groups: s.groups.map((g) => ({ kg: kg2(g.kg), n: g.n })), batches: s.batches.map(kg2) });

async function event(db: Db, e: { action: string; planId?: string | null; slotId?: string | null; before?: unknown; after?: unknown; reason?: string | null; actor: { id: string; name?: string | null } }) {
  await db.scheduleEvent.create({
    data: {
      action: e.action, planId: e.planId ?? null, slotId: e.slotId ?? null,
      before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined, after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined,
      reason: e.reason ?? null, actorId: e.actor.id, actorName: e.actor.name ?? null,
    },
  });
}

export async function lockSchedule(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
}

/**
 * «اعتماد الخطة» (§5.9): reserve the previewed slots — nothing else. Inside the caller's transaction:
 * the schedule lock, the preview recomputed, and a refusal if the green to plan moved since the
 * planner saw it (409 PLAN_STALE), if anything is blocked or in conflict (409 PLAN_BLOCKED /
 * SLOT_CONFLICT), or if the decision needs a privilege or reason the caller lacks.
 */
export async function approvePlan(tx: Prisma.TransactionClient, req: PlanRequest & { expectedGreenKg: string; reason?: string | null }, actor: { id: string; name?: string | null; can: ScheduleCan }, now = new Date()) {
  await lockSchedule(tx);
  const p = await planPreview(tx, req, now);
  const computed = p.quantities.greenToPlanKg;
  if (p.override === null && req.expectedGreenKg !== computed) {
    throw new ScheduleError(409, `تغيّر الأخضر للتخطيط منذ فتح الخطة (${req.expectedGreenKg} ← ${computed} كغ). راجع الخطة واعتمدها من جديد.`, `The green to plan changed since the plan was opened (${req.expectedGreenKg} → ${computed} kg). Review and approve again.`, "PLAN_STALE", { greenToPlanKg: computed });
  }
  const reason = typeof req.reason === "string" ? req.reason.trim() : "";
  if (p.override !== null) {
    if (p.override === computed) { /* same as computed: not a decision */ }
    else if (!reason) throw new ScheduleError(400, "قرار التخطيط يحتاج سببًا مكتوبًا.", "A planning decision needs a written reason.", "REASON_REQUIRED");
    if (Number(p.override) > Number(computed) && !actor.can.roastToStock) {
      throw new ScheduleError(403, "التخطيط فوق الاحتياج تحميص للمخزون ويحتاج صلاحية «تحميص للمخزون دون طلب».", "Planning above the requirement is roasting to stock and needs the «Roast to stock» permission.", "ROAST_TO_STOCK_REQUIRED");
    }
  }
  if (p.purpose === "STOCK" && !actor.can.roastToStock) {
    throw new ScheduleError(403, "لا احتياج مفتوح لهذه القهوة؛ التخطيط لها تحميص للمخزون ويحتاج صلاحية «تحميص للمخزون دون طلب».", "This coffee has no open requirement; planning it is roasting to stock and needs the «Roast to stock» permission.", "ROAST_TO_STOCK_REQUIRED");
  }
  const conflict = p.slots.find((s) => s.conflict);
  if (conflict) {
    const c = conflict.conflict!;
    const msg: Record<string, [string, string, string]> = {
      MACHINE: ["تعارض محمصة: الخانة تتداخل مع خانة أخرى على المحمصة نفسها.", "Roaster conflict: the slot overlaps another slot on the same roaster.", "SLOT_CONFLICT"],
      OPERATOR: ["تعارض مشغّل: المشغّل مسند إلى خانة أخرى في الوقت نفسه.", "Operator conflict: the operator is on another slot at the same time.", "SLOT_CONFLICT"],
      OPERATOR_NOT_ASSIGNED: ["المشغّل غير مسند إلى هذه المحمصة أو لا يملك صلاحية بدء التحميص.", "The operator is not assigned to this roaster or cannot start roasting.", "OPERATOR_NOT_ASSIGNED"],
      HOURS: ["الخانة خارج ساعات عمل المحمصة.", "The slot is outside the roaster's working hours.", "OUTSIDE_HOURS"],
      MAINTENANCE: ["الخانة داخل فترة صيانة مخططة.", "The slot is inside a planned maintenance window.", "MAINTENANCE"],
      PAST: ["وقت الخانة مضى.", "The slot time has passed.", "SLOT_IN_PAST"],
    };
    const [ar, en, code] = msg[c];
    throw new ScheduleError(c === "OPERATOR_NOT_ASSIGNED" ? 422 : 409, ar, en, code, { conflict: { kind: c, index: conflict.index, startsAt: conflict.startsAt } });
  }
  if (p.blocked || p.split.ok === false) {
    const failing = p.rules.filter((r) => r.state === "fail").map((r) => r.key);
    if (failing.includes("OPERATOR")) throw new ScheduleError(422, "اختر مشغّلًا مسندًا إلى هذه المحمصة ويملك صلاحية بدء التحميص.", "Choose an operator assigned to this roaster who can start roasting.", "OPERATOR_NOT_ASSIGNED");
    throw new ScheduleError(409, "لا يمكن اعتماد الخطة: قاعدة تحقق غير مستوفاة.", "The plan cannot be approved: a rule is not met.", "PLAN_BLOCKED", { failing, split: p.split });
  }
  const split = p.split;
  const plan = await tx.roastPlan.create({
    data: {
      productId: p.product.id, roasterId: p.roaster.id, operatorId: p.operatorId!, purpose: p.purpose, split: split.chosen,
      batchCount: p.slots.length, greenKg: p.greenKg, computedGreenKg: computed, overrideReason: p.override !== null && p.override !== computed ? reason : null,
      inputs: { ...p.quantities, override: p.override, expectedLossPct: p.product.expectedLossPct, split: split.chosen === "ALTERNATIVE" ? split.alternative?.text : split.proposed.text } as Prisma.InputJsonValue,
      approvedById: actor.id, approvedByName: actor.name ?? null,
    },
  });
  const createdSlots: { id: string; operatorId: string; startsAt: Date }[] = [];
  for (const s of p.slots) {
    createdSlots.push(await tx.scheduledSlot.create({
      data: {
        planId: plan.id, roasterId: p.roaster.id, operatorId: s.operatorId!, productId: p.product.id, purpose: p.purpose,
        startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt), plannedGreenKg: s.kg, createdById: actor.id, updatedById: actor.id,
      },
      select: { id: true, operatorId: true, startsAt: true },
    }));
  }
  await notifyOperators(tx, "production.slot_assigned", `plan:${plan.id}`, createdSlots, { actorId: actor.id, roasterName: p.roaster.name, productName: p.product.name.ar });
  await event(tx, { action: "PLAN_APPROVED", planId: plan.id, after: { productId: p.product.id, roasterId: p.roaster.id, operatorId: p.operatorId, greenKg: p.greenKg, computedGreenKg: computed, slots: p.slots.map((s) => ({ startsAt: s.startsAt, kg: s.kg, operatorId: s.operatorId })) }, reason: reason || null, actor });
  return { planId: plan.id, slots: p.slots.length, greenKg: p.greenKg };
}

// ── feat/notifications: the operators of the slots, and the managers of a roaster's status ─────────
const hhmm = (d: Date) => new Date(+d + 3 * 3_600_000).toISOString().slice(11, 16);
const whenText = (d: Date) => `${riyadhKey(d)} ${hhmm(d)}`;

/** One notification per operator: the slots assigned / cancelled for them (aggregated). */
async function notifyOperators(tx: Prisma.TransactionClient, event: "production.slot_assigned" | "production.slot_cancelled", key: string,
  slots: { id: string; operatorId: string; startsAt: Date }[], o: { actorId: string; roasterName: string; productName?: string | null; reason?: string | null }) {
  const by = new Map<string, Date[]>();
  for (const sl of slots) by.set(sl.operatorId, [...(by.get(sl.operatorId) ?? []), sl.startsAt]);
  const { notify } = await import("@/lib/notifications/notify");
  for (const [operatorId, starts] of by) {
    const first = starts.sort((a, b) => +a - +b)[0];
    await notify(tx, {
      event, dedupeKey: `${key}:${operatorId}`, actorId: o.actorId, entity: { type: "ScheduledSlot", id: slots[0].id },
      facts: { count: starts.length, roasterName: o.roasterName, productName: o.productName ?? null, when: whenText(first), day: riyadhKey(first), reason: o.reason ?? null },
      people: { operator: operatorId },
    });
  }
}

// ── Slot actions ────────────────────────────────────────────────────────────────────────────

async function lockedSlot(tx: Prisma.TransactionClient, id: string) {
  const s = await tx.scheduledSlot.findUnique({ where: { id }, include: { batch: { select: { id: true } }, roaster: true } });
  if (!s) throw new ScheduleError(404, "الخانة غير موجودة.", "Slot not found.", "NOT_FOUND");
  return s;
}
const audit = (s: { startsAt: Date; endsAt: Date; operatorId: string; status: string }) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), operatorId: s.operatorId, status: s.status });

/** «نقل» / «إسناد إلى …» (RM8 conflict resolutions): a planned (or missed) slot to a new start and / or operator, re-checked like a new slot. */
export async function moveSlot(tx: Prisma.TransactionClient, id: string, body: { startsAt?: string; operatorId?: string }, actor: { id: string; name?: string | null }, now = new Date()) {
  await lockSchedule(tx);
  const s = await lockedSlot(tx, id);
  const st = effectiveStatus({ status: s.status, endsAt: s.endsAt, hasBatch: !!s.batch }, now);
  if (s.status !== "PLANNED" || (st !== "PLANNED" && st !== "MISSED")) throw new ScheduleError(409, "تُنقل الخانة المخططة فقط (لا الجارية ولا المسجّلة ولا الملغاة).", "Only a planned slot can be moved (not one in progress, recorded or cancelled).", "SLOT_NOT_PLANNED");
  const len = +s.endsAt - +s.startsAt;
  const start = body.startsAt !== undefined ? Date.parse(body.startsAt) : +s.startsAt;
  if (!Number.isFinite(start)) throw new ScheduleError(400, "وقت غير صالح.", "Invalid time.", "INVALID_TIME");
  const operatorId = body.operatorId ?? s.operatorId;
  const cand = { id: s.id, roasterId: s.roasterId, operatorId, start, end: start + len };
  if (start <= +now) throw new ScheduleError(409, "اختر وقتًا قادمًا.", "Choose a time in the future.", "SLOT_IN_PAST");
  if (s.roaster.status !== "AVAILABLE") throw new ScheduleError(409, "المحمصة غير متاحة.", "The roaster is not available.", "ROASTER_UNAVAILABLE");
  if (!insideWorkingHours(cand, hoursOf(s.roaster.workingHours))) throw new ScheduleError(409, "الخانة خارج ساعات عمل المحمصة.", "The slot is outside the roaster's working hours.", "OUTSIDE_HOURS");
  const maint = await maintenanceWindows(tx, s.roasterId, new Date(start), new Date(start + len));
  if (maint.length) throw new ScheduleError(409, "الخانة داخل فترة صيانة مخططة.", "The slot is inside a planned maintenance window.", "MAINTENANCE");
  if (operatorId !== s.operatorId && !(await eligibleOperators(tx, s.roasterId)).some((o) => o.id === operatorId)) {
    throw new ScheduleError(422, "المشغّل غير مسند إلى هذه المحمصة أو لا يملك صلاحية بدء التحميص.", "The operator is not assigned to this roaster or cannot start roasting.", "OPERATOR_NOT_ASSIGNED");
  }
  const around = [
    ...(await liveSlots(tx, { from: new Date(start), to: new Date(start + len), roasterId: s.roasterId, now })),
    ...(await liveSlots(tx, { from: new Date(start), to: new Date(start + len), operatorId, now })),
  ].map(slotLike);
  const c = findConflicts([cand], around)[0];
  if (c) {
    const other = c.b;
    throw new ScheduleError(409, c.kind === "MACHINE" ? "تعارض محمصة: خانة أخرى على المحمصة نفسها في هذا الوقت." : "تعارض مشغّل: المشغّل في خانة أخرى في هذا الوقت.",
      c.kind === "MACHINE" ? "Roaster conflict: another slot on the same roaster at this time." : "Operator conflict: the operator is on another slot at this time.",
      "SLOT_CONFLICT", { conflict: { kind: c.kind, slotId: other.id, startsAt: new Date(other.start).toISOString(), endsAt: new Date(other.end).toISOString() } });
  }
  const before = audit(s);
  const row = await tx.scheduledSlot.update({ where: { id }, data: { startsAt: new Date(start), endsAt: new Date(start + len), operatorId, updatedById: actor.id } });
  await event(tx, { action: operatorId !== s.operatorId && start === +s.startsAt ? "SLOT_REASSIGNED" : "SLOT_MOVED", planId: s.planId, slotId: id, before, after: audit(row), actor });
  // feat/notifications: the operator who had it (moved, or given to someone else) and the one who has it now.
  const { notify } = await import("@/lib/notifications/notify");
  const stamp = `${id}:${row.updatedAt.toISOString()}`;
  if (operatorId !== s.operatorId) {
    const other = (await tx.employee.findUnique({ where: { id: operatorId }, select: { name: true } }))?.name ?? null;
    await notify(tx, { event: "production.slot_changed", dedupeKey: `${stamp}:removed`, actorId: actor.id, entity: { type: "ScheduledSlot", id },
      facts: { change: "REMOVED", roasterName: s.roaster.name, otherName: other, when: whenText(s.startsAt), day: riyadhKey(s.startsAt) }, people: { operator: s.operatorId } });
    await notifyOperators(tx, "production.slot_assigned", `move:${stamp}`, [{ id, operatorId, startsAt: row.startsAt }], { actorId: actor.id, roasterName: s.roaster.name });
  } else if (start !== +s.startsAt) {
    await notify(tx, { event: "production.slot_changed", dedupeKey: `${stamp}:moved`, actorId: actor.id, entity: { type: "ScheduledSlot", id },
      facts: { change: "MOVED", roasterName: s.roaster.name, when: `${whenText(s.startsAt)} → ${whenText(row.startsAt)}`, whenAr: `من ${whenText(s.startsAt)} إلى ${whenText(row.startsAt)}`, day: riyadhKey(row.startsAt) }, people: { operator: operatorId } });
  }
  return row;
}

export async function cancelSlot(tx: Prisma.TransactionClient, id: string, reason: string, actor: { id: string; name?: string | null }) {
  await lockSchedule(tx);
  const s = await lockedSlot(tx, id);
  if (s.batch || s.status === "RECORDED") throw new ScheduleError(409, "الخانة مسجّلة بدفعة ولا تُلغى.", "The slot is recorded with a batch and cannot be cancelled.", "SLOT_RECORDED");
  if (s.status === "CANCELLED") throw new ScheduleError(409, "الخانة ملغاة.", "The slot is already cancelled.", "SLOT_CANCELLED");
  const row = await tx.scheduledSlot.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: actor.id, cancelReason: reason, updatedById: actor.id } });
  await event(tx, { action: "SLOT_CANCELLED", planId: s.planId, slotId: id, before: audit(s), after: audit(row), reason, actor });
  await notifyOperators(tx, "production.slot_cancelled", `cancel:${id}`, [{ id, operatorId: s.operatorId, startsAt: s.startsAt }], { actorId: actor.id, roasterName: s.roaster.name, reason });
  return row;
}

/** «بدء» (§4): the slot becomes IN_PROGRESS. No stock moves and no batch is created — the batch is recorded after the roast. */
export async function startSlot(tx: Prisma.TransactionClient, id: string, actor: { id: string; name?: string | null; can: ScheduleCan }, now = new Date()) {
  await lockSchedule(tx);
  const s = await lockedSlot(tx, id);
  if (!actor.can.manage && !(actor.can.startBatch && s.operatorId === actor.id)) {
    throw new ScheduleError(403, "يبدأ الخانة مشغّلها أو من يدير الجدول.", "A slot is started by its operator or by a schedule manager.", "FORBIDDEN");
  }
  const st = effectiveStatus({ status: s.status, endsAt: s.endsAt, hasBatch: !!s.batch }, now);
  if (s.status !== "PLANNED" || st === "CANCELLED" || st === "RECORDED") throw new ScheduleError(409, "الخانة ليست مخططة.", "The slot is not planned.", "SLOT_NOT_PLANNED");
  if (riyadhKey(s.startsAt) !== riyadhKey(now)) throw new ScheduleError(409, "تبدأ خانات اليوم فقط.", "Only today's slots can be started.", "SLOT_NOT_TODAY");
  const row = await tx.scheduledSlot.update({ where: { id }, data: { status: "IN_PROGRESS", startedAt: now, startedById: actor.id, updatedById: actor.id } });
  await event(tx, { action: "SLOT_STARTED", planId: s.planId, slotId: id, before: audit(s), after: audit(row), actor });
  return row;
}

/**
 * Link a recorded batch to its slot: the slot becomes RECORDED and leaves «in progress»; its planned
 * green stays on the slot, the measured weights stay on the batch (§5.1 — each kilogram counted once).
 *
 * POST-MERGE HOOK for the station branch: POST /api/roasting-batches (feat/station-w1) calls this inside
 * its own transaction, right after it creates the batch, when the request names a scheduledSlotId:
 *     await linkBatchToSlot(tx, { slotId, batchId: batch.id, actor: { id: user.id, name: user.name } });
 * The checks are the same as for the manual link (the coffee must match, one batch per slot).
 */
export async function linkBatchToSlot(tx: Prisma.TransactionClient, o: { slotId: string; batchId: string; actor: { id: string; name?: string | null }; now?: Date }) {
  await lockSchedule(tx);
  const s = await lockedSlot(tx, o.slotId);
  if (s.status === "CANCELLED") throw new ScheduleError(409, "الخانة ملغاة.", "The slot is cancelled.", "SLOT_CANCELLED");
  if (s.batch || s.status === "RECORDED") throw new ScheduleError(409, "الخانة مرتبطة بدفعة مسبقًا.", "The slot is already linked to a batch.", "SLOT_RECORDED");
  const b = await tx.roastingBatch.findUnique({ where: { id: o.batchId }, select: { id: true, batchNumber: true, isBlend: true, productId: true, orderItemId: true, productionOrderId: true, scheduledSlotId: true, status: true, greenBeanQuantity: true, roastedBeanQuantity: true, createdAt: true } });
  if (!b) throw new ScheduleError(404, "الدفعة غير موجودة.", "Batch not found.", "NOT_FOUND");
  if (b.isBlend) throw new ScheduleError(409, "دفعة الخلط ليست تحميصًا ولا تُربط بخانة.", "A blend is not a roast and is not linked to a slot.", "BATCH_IS_BLEND");
  if (b.scheduledSlotId) throw new ScheduleError(409, "الدفعة مرتبطة بخانة أخرى.", "The batch is linked to another slot.", "BATCH_LINKED");
  const id = await resolveBatchCoffeeIdentity(tx, b);
  if (!id.ok || id.productId !== s.productId) throw new ScheduleError(409, "قهوة الدفعة غير قهوة الخانة.", "The batch's coffee is not the slot's coffee.", "COFFEE_MISMATCH");
  await tx.roastingBatch.update({ where: { id: b.id }, data: { scheduledSlotId: s.id } });
  const row = await tx.scheduledSlot.update({ where: { id: s.id }, data: { status: "RECORDED", recordedAt: o.now ?? new Date(), updatedById: o.actor.id } });
  await event(tx, { action: "SLOT_LINKED", planId: s.planId, slotId: s.id, before: audit(s), after: { ...audit(row), batchId: b.id, batchNumber: b.batchNumber, greenKg: b.greenBeanQuantity, roastedKg: b.roastedBeanQuantity }, actor: o.actor });
  return { slot: row, batch: b };
}

/** Today's recorded, unlinked batches of the slot's coffee — the choices of «ربط بدفعة». */
export async function linkCandidates(db: Db, slotId: string, now = new Date()) {
  const s = await db.scheduledSlot.findUnique({ where: { id: slotId }, select: { productId: true, startsAt: true } });
  if (!s) return [];
  const from = new Date(riyadhMidnight(riyadhKey(s.startsAt)));
  const to = new Date(Math.max(+now, riyadhMidnight(addDays(riyadhKey(s.startsAt), 1))));
  const rows = await db.roastingBatch.findMany({
    where: {
      createdAt: { gte: from, lt: to }, isBlend: false, scheduledSlotId: null,
      OR: [{ productId: s.productId }, { productId: null, orderItem: { productSku: { productId: s.productId } } }, { productId: null, orderItemId: null, productionOrder: { productSku: { productId: s.productId } } }],
    },
    orderBy: { createdAt: "desc" }, take: 20,
    select: { id: true, batchNumber: true, status: true, greenBeanQuantity: true, roastedBeanQuantity: true, createdAt: true },
  });
  return rows.map(batchLite);
}

// ── Roaster status and maintenance (§5.10, §4 RoasterMaintenance) ───────────────────────────

/** The live planned slots a status change from now would return to the work queue (RM4b «N خانات مخططة تتأثر»). */
export async function affectedSlots(db: Db, roasterId: string, now = new Date()) {
  const rows = (await liveSlots(db, { from: now, to: new Date(+now + 400 * 86_400_000), roasterId, now }))
    .filter((s) => s.status === "PLANNED" && +s.startsAt >= +now);
  const today = riyadhKey(now);
  return { count: rows.length, today: rows.filter((s) => riyadhKey(s.startsAt) === today).length, first: rows.slice(0, 3).map((s) => ({ id: s.id, startsAt: s.startsAt.toISOString(), plannedGreenKg: kg2(num(s.plannedGreenKg)) })) };
}

/**
 * §5.10: a roaster set to MAINTENANCE or STOPPED returns its coming PLANNED slots (today's from now, and
 * every later day's) to the unscheduled work queue — CANCELLED with the reason. Never cancels an order,
 * consumes green or touches a recorded batch; a slot already started is left for its operator.
 */
export async function cancelSlotsForRoasterStatus(tx: Prisma.TransactionClient, roasterId: string, status: string, reason: string | null, actor: { id: string; name?: string | null }, now = new Date()): Promise<number> {
  if (status !== "MAINTENANCE" && status !== "STOPPED") return 0;
  const n = await cancelSlotsForRoasterStatusInner(tx, roasterId, status, reason, actor, now);
  // feat/notifications: the schedule / roaster managers and the roaster's operators; each operator
  // whose slots were returned to the queue also gets those slots.
  const roaster = await tx.roaster.findUnique({ where: { id: roasterId }, select: { name: true, operators: { select: { employeeId: true } } } });
  if (roaster) {
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, {
      event: "production.roaster_status", dedupeKey: `${roasterId}:${status}:${now.toISOString()}`, actorId: actor.id, entity: { type: "Roaster", id: roasterId },
      facts: { roasterName: roaster.name, status, reason, cancelled: n.length },
      people: { operators: roaster.operators.map((o) => o.employeeId) },
    });
    await notifyOperators(tx, "production.slot_cancelled", `roaster:${roasterId}:${now.toISOString()}`, n, { actorId: actor.id, roasterName: roaster.name, reason: `${status === "MAINTENANCE" ? "المحمصة في الصيانة" : "المحمصة متوقفة"}${reason ? `: ${reason}` : ""}` });
  }
  return n.length;
}

async function cancelSlotsForRoasterStatusInner(tx: Prisma.TransactionClient, roasterId: string, status: string, reason: string | null, actor: { id: string; name?: string | null }, now: Date): Promise<{ id: string; operatorId: string; startsAt: Date }[]> {
  await lockSchedule(tx);
  const rows = (await liveSlots(tx, { from: now, to: new Date(+now + 400 * 86_400_000), roasterId, now })).filter((s) => s.status === "PLANNED" && +s.startsAt >= +now);
  const why = `${status === "MAINTENANCE" ? "المحمصة في الصيانة" : "المحمصة متوقفة"}${reason ? `: ${reason}` : ""}`;
  for (const s of rows) {
    const row = await tx.scheduledSlot.update({ where: { id: s.id }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.id, cancelReason: why, updatedById: actor.id } });
    await event(tx, { action: "SLOT_CANCELLED", planId: s.planId, slotId: s.id, before: audit(s), after: audit(row), reason: why, actor });
  }
  return rows.map((r) => ({ id: r.id, operatorId: r.operatorId, startsAt: r.startsAt }));
}

/** Live slots of a roaster inside a window — a planned maintenance window may not be saved over them (§4). */
export async function slotsInWindow(db: Db, roasterId: string, start: Date, end: Date, now = new Date()) {
  return (await liveSlots(db, { from: start, to: end, roasterId, now })).map((s) => ({ id: s.id, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() }));
}

// ── RM8 · roasters and week ─────────────────────────────────────────────────────────────────

/**
 * RM8: the load of each production roaster on each of `days` days from `fromKey` (booked / available
 * slots at its cycle inside its working hours), every lane of one day, the operator conflicts among
 * live slots, and the green distribution per coffee (the roaster that finishes earliest, and the other).
 */
export async function weekView(db: Db, fromKey: string, days: number, laneDay: string, now = new Date()) {
  const roasters = await readRoasters(db);
  const keys = Array.from({ length: days }, (_, i) => addDays(fromKey, i));
  const from = new Date(riyadhMidnight(fromKey)), to = new Date(riyadhMidnight(addDays(fromKey, days)));
  const rows = await db.scheduledSlot.findMany({ where: { startsAt: { gte: from, lt: to }, status: { not: "CANCELLED" } }, include: { batch: { select: { id: true } } } });
  const live = rows.filter((s) => isLive(effectiveStatus({ status: s.status, endsAt: s.endsAt, hasBatch: !!s.batch }, now)));
  const load = roasters.map((r) => {
    const h: WorkingHours = hoursOf(r.workingHours);
    return {
      roasterId: r.id,
      days: keys.map((k) => {
        const w = workWindow(k, h);
        const available = w && r.status === "AVAILABLE" ? Math.floor((w.end - w.start) / (r.cycleMinutes * 60_000)) : 0;
        const booked = rows.filter((s) => s.roasterId === r.id && riyadhKey(s.startsAt) === k && effectiveStatus({ status: s.status, endsAt: s.endsAt, hasBatch: !!s.batch }, now) !== "MISSED").length;
        return { day: k, booked, available, off: !w };
      }),
    };
  });
  const lanes = await dayBoard(db, laneDay, now);
  const conflicts = findConflicts(live.map(slotLike), []).filter((c) => c.kind === "OPERATOR");
  const names = await employeeNames(db, conflicts.flatMap((c) => [c.a.operatorId]));
  const queue = (await roastQueue(db as Prisma.TransactionClient)).filter((c) => c.demandKg > 0);
  const distribution = [];
  for (const c of queue.slice(0, 12)) {
    const facts = await quantitiesFor(db, c.productId, now);
    if (!facts) continue;
    const g = facts.q.greenToPlanKg;
    const options = roasters.filter((r) => r.status === "AVAILABLE").map((r) => {
      const s = splitGreen(g, limitsOf(r));
      return { roasterId: r.id, roasterName: r.name, ok: s.ok, count: s.ok ? s.proposed.count : 0, text: s.ok ? splitText(s.proposed) : null, minutes: s.ok ? s.proposed.count * r.cycleMinutes : null };
    }).filter((o) => o.ok).sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
    distribution.push({ productId: c.productId, product: productName(c as unknown as { productNameAr: string | null; productNameEn: string }), orders: c.orders.slice(0, 3).map((o) => o.orderNumber), greenToPlanKg: kg2(g), approvedSlots: facts.approvedCount, proposed: options[0] ?? null, alternative: options[1] ?? null });
  }
  return {
    from: fromKey, days: keys, laneDay, now: now.toISOString(),
    roasters: roasters.map(roasterOut), load, lanes: lanes.roasters,
    conflicts: conflicts.map((c) => ({ operatorId: c.a.operatorId, operatorName: names.get(c.a.operatorId) ?? null, a: { id: c.a.id, roasterId: c.a.roasterId, startsAt: new Date(c.a.start).toISOString(), endsAt: new Date(c.a.end).toISOString() }, b: { id: c.b.id, roasterId: c.b.roasterId, startsAt: new Date(c.b.start).toISOString(), endsAt: new Date(c.b.end).toISOString() } })),
    distribution,
  };
}

export { riyadhKey };
