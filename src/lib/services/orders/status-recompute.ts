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
 * Idempotent: a second run closes nothing (those orders are Completed) and preparation of an
 * unchanged order changes nothing (`changed: false`, no write).
 */
import { prisma, TX_OPTS } from "@/lib/db";
import { completionRefusal, isLineFullyDelivered, lockOrderLifecycleResources } from "@/lib/services/order-operations";
import { autoCloseAfterDelivery, autoPrepareOrder, AUTO_PREPARATION_STATUSES, type PreparationActor } from "./preparation";

/** The open statuses a fully delivered order can be stuck in. */
export const RECOMPUTE_CLOSE_STATUSES = ["Preparing", "Ready for Shipping"] as const;

export type RecomputeOrder = { id: string; orderNumber: number; status: string };
export type RecomputePlan = {
  /** Orders in «قيد التجهيز» / «جاهز للشحن». */
  open: number;
  /** Of those, delivered in full and passing the completion gate: what step 1 would close. */
  wouldClose: RecomputeOrder[];
  /** Delivered in full but refused by the same gate (a live reservation): left open for a supervisor. */
  wouldStayOpen: RecomputeOrder[];
  /** The orders step 2 would run the automatic preparation on (open after step 1). */
  wouldPrepare: RecomputeOrder[];
};
export type RecomputeResult = {
  closed: RecomputeOrder[];
  /** Delivered in full but refused by the completion gate (a live reservation, an inexact line). */
  leftOpen: RecomputeOrder[];
  /** Orders whose preparation changed something, with the status before and after. */
  prepared: (RecomputeOrder & { from: string | null; to: string | null })[];
  /** Orders preparation ran on. */
  preparedChecked: number;
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
  return { open: open.length, wouldClose, wouldStayOpen, wouldPrepare: preparable.filter((o) => !closing.has(o.id)).map(brief) };
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
  return { closed, leftOpen, prepared, preparedChecked };
}
