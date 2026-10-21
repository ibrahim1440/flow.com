/**
 * One-time recompute of order statuses (Settings › Production & roasting «إعادة حساب حالات الطلبات»,
 * and scripts/release/prod-simplify-recompute.ts).
 *
 * Orders created before the automatic preparation existed sit in «قيد التجهيز» / «جاهز للشحن» and get
 * no recompute until something happens to them; one delivered in full before the release stays
 * open (DEF-04 on old data). This does what the release script does, with the same service
 * functions and nothing re-implemented:
 *
 *   1. close every open order delivered in full — `autoCloseAfterDelivery`, the gate the manual
 *      «complete» uses (every line delivered exactly, no live reservation), each order in its own
 *      transaction under the canonical lock order (`lockOrderLifecycleResources`, then the Order row);
 *   2. then run the automatic preparation (`autoPrepareOrder`) on every order still open, oldest
 *      first.
 *
 *   3. (fix/order-owner) give every open order that has no owner the user who created it, where that
 *      is recorded — the `order.created` automation event's actor, else the quotation link's
 *      `createdById` — and still an active account; the rest are left unowned and counted.
 *
 * Idempotent: a second run closes nothing (those orders are Completed), preparation of an unchanged
 * order changes nothing (`changed: false`, no write), and an order that has an owner is not an
 * unowned one (the assignment is keyed on `ownerId IS NULL`).
 */
import { prisma, TX_OPTS } from "@/lib/db";
import { appendOrderActivity, completionRefusal, isLineFullyDelivered, lockOrderLifecycleResources, TERMINAL_ORDER_STATUSES } from "@/lib/services/order-operations";
import { autoCloseAfterDelivery, autoPrepareOrder, AUTO_PREPARATION_STATUSES, type PreparationActor } from "./preparation";

/** The open statuses a fully delivered order can be stuck in. */
export const RECOMPUTE_CLOSE_STATUSES = ["Preparing", "Ready for Shipping"] as const;

export type RecomputeOrder = { id: string; orderNumber: number; status: string };
/** An unowned open order and the creator the records name for it (null: none recorded, or inactive). */
export type UnownedOrder = RecomputeOrder & { creatorId: string | null; creatorName: string | null; source: "order.created" | "quote_link" | null };
export type RecomputePlan = {
  /** Orders in «قيد التجهيز» / «جاهز للشحن». */
  open: number;
  /** Of those, delivered in full and passing the completion gate: what step 1 would close. */
  wouldClose: RecomputeOrder[];
  /** Delivered in full but refused by the same gate (a live reservation): left open for a supervisor. */
  wouldStayOpen: RecomputeOrder[];
  /** The orders step 2 would run the automatic preparation on (open after step 1). */
  wouldPrepare: RecomputeOrder[];
  /** Step 3: open orders with no owner — those with a recorded creator, and those without. */
  unowned: { open: number; wouldAssign: UnownedOrder[]; noCreator: UnownedOrder[] };
};
export type RecomputeResult = {
  closed: RecomputeOrder[];
  /** Delivered in full but refused by the completion gate (a live reservation, an inexact line). */
  leftOpen: RecomputeOrder[];
  /** Orders whose preparation changed something, with the status before and after. */
  prepared: (RecomputeOrder & { from: string | null; to: string | null })[];
  /** Orders preparation ran on. */
  preparedChecked: number;
  /** Step 3: the unowned open orders given their creator, and the count left unowned. */
  ownersAssigned: UnownedOrder[];
  ownersUnresolved: number;
};

const ORDER_SELECT = {
  id: true, orderNumber: true, status: true,
  items: { select: { quantityUnits: true, deliveredUnits: true, quantityKg: true, deliveredQty: true } },
} as const;

const brief = (o: RecomputeOrder): RecomputeOrder => ({ id: o.id, orderNumber: o.orderNumber, status: o.status });

/** The dry run: what would change, read only. */
export async function planOrderStatusRecompute(): Promise<RecomputePlan> {
  const open = await prisma.order.findMany({
    where: { status: { in: [...RECOMPUTE_CLOSE_STATUSES] } },
    select: ORDER_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const delivered = open.filter((o) => o.items.length > 0 && o.items.every(isLineFullyDelivered));
  // The live reservations of those orders, summarised as autoCloseAfterDelivery does, so the dry run
  // applies the very gate (completionRefusal) the apply step will meet.
  const held = delivered.length === 0 ? [] : await prisma.stockAllocation.findMany({
    where: { status: "RESERVED", orderItem: { orderId: { in: delivered.map((o) => o.id) } } },
    select: { quantityUnits: true, quantityKg: true, orderItem: { select: { orderId: true } } },
  });
  const summary = (orderId: string) => {
    const rows = held.filter((h) => h.orderItem.orderId === orderId);
    return { rows: rows.length, units: rows.reduce((t, r) => t + (r.quantityUnits ?? 0), 0), kg: rows.reduce((t, r) => t + r.quantityKg, 0) };
  };
  const wouldClose: RecomputeOrder[] = [];
  const wouldStayOpen: RecomputeOrder[] = [];
  for (const o of delivered) (completionRefusal(o.items, summary(o.id)) ? wouldStayOpen : wouldClose).push(brief(o));
  const closing = new Set(wouldClose.map((o) => o.id));
  const preparable = await prisma.order.findMany({
    where: { status: { in: [...AUTO_PREPARATION_STATUSES] } },
    select: { id: true, orderNumber: true, status: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const unowned = await planUnownedOrders(closing);
  return { open: open.length, wouldClose, wouldStayOpen, wouldPrepare: preparable.filter((o) => !closing.has(o.id)).map(brief), unowned };
}

/**
 * Step 3's read: every open order (not Completed / Cancelled / Rejected) with no owner, and the
 * creator the records name for it. The `order.created` automation event is written in the same
 * transaction as every order the application creates (POST /api/orders and the quotation
 * conversion both emit it with the acting user); the quotation link's `createdById` is the second
 * source. An inactive or deleted creator is not assigned: a revoked account must not become
 * responsible for anything. Orders about to close in step 1 are left out — nothing is left to own.
 */
async function planUnownedOrders(closing: ReadonlySet<string>): Promise<RecomputePlan["unowned"]> {
  const rows = await prisma.order.findMany({
    where: { ownerId: null, status: { notIn: [...TERMINAL_ORDER_STATUSES] } },
    select: { id: true, orderNumber: true, status: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const open = rows.filter((o) => !closing.has(o.id));
  if (open.length === 0) return { open: 0, wouldAssign: [], noCreator: [] };
  const ids = open.map((o) => o.id);
  const events = await prisma.automationEvent.findMany({
    where: { eventType: "order.created", subjectType: "Order", subjectId: { in: ids }, actorId: { not: null } },
    select: { subjectId: true, actorId: true },
    orderBy: [{ occurredAt: "asc" }],
  });
  const links = await prisma.opportunityOrder.findMany({
    where: { orderId: { in: ids }, createdById: { not: null } },
    select: { orderId: true, createdById: true },
  });
  const byEvent = new Map<string, string>();
  for (const e of events) if (e.actorId && !byEvent.has(e.subjectId)) byEvent.set(e.subjectId, e.actorId);
  const byLink = new Map<string, string>();
  for (const l of links) if (l.createdById && !byLink.has(l.orderId)) byLink.set(l.orderId, l.createdById);
  const candidateIds = [...new Set([...byEvent.values(), ...byLink.values()])];
  const active = new Map(
    (candidateIds.length ? await prisma.employee.findMany({ where: { id: { in: candidateIds }, active: true }, select: { id: true, name: true } }) : [])
      .map((e) => [e.id, e.name] as const),
  );
  const wouldAssign: UnownedOrder[] = [];
  const noCreator: UnownedOrder[] = [];
  for (const o of open) {
    const fromEvent = byEvent.get(o.id);
    const fromLink = byLink.get(o.id);
    const pick = fromEvent && active.has(fromEvent) ? { id: fromEvent, source: "order.created" as const }
      : fromLink && active.has(fromLink) ? { id: fromLink, source: "quote_link" as const } : null;
    if (pick) wouldAssign.push({ ...brief(o), creatorId: pick.id, creatorName: active.get(pick.id) ?? null, source: pick.source });
    else noCreator.push({ ...brief(o), creatorId: null, creatorName: null, source: null });
  }
  return { open: open.length, wouldAssign, noCreator };
}

/** Apply: close what is delivered in full, then prepare what is still open (when `prepare`). */
export async function applyOrderStatusRecompute(actor: PreparationActor, opts: { prepare: boolean }): Promise<RecomputeResult> {
  const plan = await planOrderStatusRecompute();
  const closed: RecomputeOrder[] = [];
  const leftOpen: RecomputeOrder[] = [];
  // Every order delivered in full goes through the gate itself, including the ones the dry run
  // expects it to refuse: the decision is autoCloseAfterDelivery's, under the locks, not the plan's.
  for (const o of [...plan.wouldClose, ...plan.wouldStayOpen]) {
    const ok = await prisma.$transaction(async (tx) => {
      await lockOrderLifecycleResources(tx, o.id);
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${o.id} FOR UPDATE`;
      return autoCloseAfterDelivery(tx, o.id, actor, "release_recompute");
    }, TX_OPTS);
    (ok ? closed : leftOpen).push(o);
  }

  // Step 3: ownership for the orders still open. Keyed on `ownerId IS NULL`, so an order that got an
  // owner in the meantime (a manager's «تغيير المسؤول», a concurrent run) is left exactly as it is.
  const ownersAssigned: UnownedOrder[] = [];
  const unowned = await planUnownedOrders(new Set(closed.map((o) => o.id)));
  for (const o of unowned.wouldAssign) {
    if (!o.creatorId) continue;
    const done = await prisma.$transaction(async (tx) => {
      const r = await tx.order.updateMany({ where: { id: o.id, ownerId: null }, data: { ownerId: o.creatorId } });
      if (r.count === 0) return false;
      const message = `Order owner set to ${o.creatorName ?? o.creatorId} (the creating user) by the one-time recompute.`;
      await appendOrderActivity(tx, {
        orderId: o.id, type: "OWNER_CHANGED", message,
        authorId: actor.id ?? null, authorName: actor.name,
        metadata: { trigger: "release_recompute", fromOwnerId: null, fromOwnerName: null, toOwnerId: o.creatorId, toOwnerName: o.creatorName, source: o.source },
      });
      return true;
    }, TX_OPTS);
    if (done) ownersAssigned.push(o);
  }
  const ownersUnresolved = unowned.noCreator.length;

  const prepared: RecomputeResult["prepared"] = [];
  let preparedChecked = 0;
  if (opts.prepare) {
    const toPrepare = await prisma.order.findMany({
      where: { status: { in: [...AUTO_PREPARATION_STATUSES] } },
      select: { id: true, orderNumber: true, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const o of toPrepare) {
      preparedChecked++;
      const r = await autoPrepareOrder(o.id, "review", actor);
      if (r?.changed) prepared.push({ ...brief(o), from: r.from, to: r.to });
    }
  }
  return { closed, leftOpen, prepared, preparedChecked, ownersAssigned, ownersUnresolved };
}
