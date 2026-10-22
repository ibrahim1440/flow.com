import { prisma } from "@/lib/db";
import { countsAsDelivered, riyadhDay, stageCardOf, stageOf, TERMINAL_ORDER_STATUSES, type PipelineStage, type Stage } from "@/lib/order-stage";

/**
 * «اليوم» — the operations dashboard (Figma Direction 2.1, `20:236` / `24:842` / `34:1405`).
 *
 * READ-ONLY. Customer identity only for callers with the customer-detail permission (F4). Every figure below is computed from rows that already exist; nothing is written,
 * nothing is estimated from a constant, and a block of the frame whose source the application
 * does not have (sales and collections money, supplier lead time, the roaster schedule, the
 * order delivery date) is not produced here at all: those are open gaps for an owner decision,
 * not values to approximate.
 *
 * The working day is the Riyadh calendar day (UTC+3, no daylight saving), the same day the
 * shell's date line shows.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days of roasting history the green-coffee consumption rate is averaged over. */
export const COVER_WINDOW_DAYS = 28;
/** The coverage bar's scale (Figma 20:455 «المقياس حتى 35 يومًا»). */
export const COVER_SCALE_DAYS = 35;
/** Orders listed under a selected pipeline card; the card links to the full filtered Orders page. */
export const STAGE_LIST_LIMIT = 8;

const TERMINAL = TERMINAL_ORDER_STATUSES;

// The stage rule and the Riyadh day are shared with the Orders page's `?stage=` filter.
export { stageOf, riyadhDay };
export type { Stage };

/** One order under a pipeline card (customer-detail view) — the «تحتاج إجراء» row shape. */
export type StageOrderRow = { id: string; orderNumber: number; customer: { name: string; nameAr: string | null }; kg: number; status: string; stage: Stage | "hold" | "delivered" };
/** One status under a pipeline card (aggregate view, F4): no order number, no customer. */
export type StageGroupRow = { status: string; stage: Stage | "hold" | "delivered"; orders: number; kg: number };

export type TodayData = {
  generatedAt: string;
  /** Today's roasting (non-blend batches dated today). */
  roasted: { kg: number; batches: number; lossPct: number | null };
  pipeline: {
    approval: number; roasting: number; qc: number; packing: number; ready: number;
    deliveredToday: number;
    /** Open orders counted in the five stages (not terminal, not on hold). */
    open: number;
    onHold: number;
    /** Hours the oldest batch of a «بانتظار الجودة» order has waited; null when none waits. */
    qcLongestHours: number | null;
    /** True when one of those batches is past its QC deadline. */
    qcOverdue: boolean;
  };
  /**
   * Orders waiting on an operator, oldest first. `detail` (owner decision F4): with the
   * customer-detail permission, one row per order with its number and customer; without it, one
   * row per status with the number of orders and their kg — no customer, no order number, no id.
   */
  needsAction:
    | { detail: true; rows: { id: string; orderNumber: number; customer: { name: string; nameAr: string | null }; kg: number; status: string; stage: Stage | "hold" }[]; total: number }
    | { detail: false; rows: { status: string; stage: Stage | "hold"; orders: number; kg: number }[]; total: number };
  /**
   * What is in each pipeline card (owner, 20 Oct 2026: the cards are selectable and list their
   * orders below). Same F4 rule as `needsAction`: per order with the customer-detail permission,
   * otherwise one row per status. `total` is the card's count; at most STAGE_LIST_LIMIT rows,
   * oldest first («سُلّم اليوم»: the kilograms delivered today).
   */
  stages:
    | { detail: true; byStage: Record<PipelineStage, { total: number; rows: StageOrderRow[] }> }
    | { detail: false; byStage: Record<PipelineStage, { total: number; rows: StageGroupRow[] }> };
  /** Green coffee by days of cover at the recent consumption rate, lowest first. */
  green: { rows: { id: string; name: string; nameAr: string | null; kg: number; days: number }[]; windowDays: number; scaleDays: number };
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function loadToday(now = new Date(), opts: { customerDetail: boolean } = { customerDetail: false }): Promise<TodayData> {
  const { start, end } = riyadhDay(now);
  const windowStart = new Date(now.getTime() - COVER_WINDOW_DAYS * DAY_MS);

  const [openOrders, deliveries, batchesToday, beans, usage] = await Promise.all([
    prisma.order.findMany({
      where: { status: { notIn: TERMINAL } },
      select: {
        id: true, orderNumber: true, status: true, createdAt: true,
        customer: { select: { name: true, nameAr: true } },
        items: {
          select: {
            quantityKg: true, productionStatus: true, preparationDecision: true, productionRequiredQuantity: true,
            roastingBatches: { where: { status: "Pending QC" }, select: { createdAt: true, qcDeadline: true } },
          },
        },
      },
      orderBy: [{ createdAt: "asc" }, { orderNumber: "asc" }],
    }),
    prisma.delivery.findMany({
      where: { date: { gte: start, lt: end } },
      select: { quantityKg: true, orderItem: { select: { orderId: true, order: { select: { id: true, orderNumber: true, status: true, createdAt: true, customer: { select: { name: true, nameAr: true } } } } } } },
    }),
    prisma.roastingBatch.findMany({ where: { isBlend: false, date: { gte: start, lt: end } }, select: { greenBeanQuantity: true, roastedBeanQuantity: true } }),
    prisma.greenBean.findMany({ where: { isActive: true }, select: { id: true, beanType: true, beanTypeAr: true, quantityKg: true } }),
    prisma.roastingBatch.groupBy({
      by: ["greenBeanId"],
      where: { isBlend: false, date: { gte: windowStart, lte: now }, greenBeanId: { not: null } },
      _sum: { greenBeanQuantity: true },
    }),
  ]);

  // ── Roasted today ──
  const kg = batchesToday.reduce((s, b) => s + b.roastedBeanQuantity, 0);
  const measured = batchesToday.filter((b) => b.greenBeanQuantity > 0 && b.roastedBeanQuantity > 0);
  const g = measured.reduce((s, b) => s + b.greenBeanQuantity, 0);
  const r = measured.reduce((s, b) => s + b.roastedBeanQuantity, 0);
  const roasted = { kg: round1(kg), batches: batchesToday.length, lossPct: g > 0 ? round1(((g - r) / g) * 100) : null };

  // ── Pipeline ──
  const counts = { approval: 0, roasting: 0, qc: 0, packing: 0, ready: 0 };
  let onHold = 0;
  let qcOldest: Date | null = null;
  let qcOverdue = false;
  // The shared card rule (lib/order-stage stageCardOf): held orders only in «معلّق مؤقتاً»; the query
  // already leaves completed, cancelled and rejected orders out, and the rule would too.
  const staged = openOrders.flatMap((o) => { const stage = stageCardOf(o); return stage ? [{ o, stage }] : []; });
  for (const { o, stage } of staged) {
    if (stage === "hold") { onHold++; continue; }
    counts[stage]++;
    if (stage === "qc") {
      for (const i of o.items) for (const b of i.roastingBatches) {
        if (!qcOldest || b.createdAt < qcOldest) qcOldest = b.createdAt;
        if (b.qcDeadline && b.qcDeadline < now) qcOverdue = true;
      }
    }
  }
  const deliveredToday = new Set(deliveries.map((d) => d.orderItem.orderId)).size;
  const open = counts.approval + counts.roasting + counts.qc + counts.packing + counts.ready;
  const qcLongestHours = qcOldest ? Math.max(0, Math.floor((now.getTime() - (qcOldest as Date).getTime()) / 3_600_000)) : null;

  // ── Needs action: what an operator must move next (review, ship, resume), oldest first ──
  const actionable = staged.filter(({ stage }) => stage === "approval" || stage === "ready" || stage === "hold");
  const kgOf = (o: (typeof openOrders)[number]) => o.items.reduce((s, i) => s + i.quantityKg, 0);
  let needsAction: TodayData["needsAction"];
  if (opts.customerDetail) {
    needsAction = {
      detail: true,
      rows: actionable.slice(0, 5).map(({ o, stage }) => ({
        id: o.id, orderNumber: o.orderNumber, customer: o.customer, status: o.status, stage, kg: round1(kgOf(o)),
      })),
      total: actionable.length,
    };
  } else {
    // Aggregates only: one row per status, in the order its oldest order arrived.
    const groups = new Map<string, { status: string; stage: Stage | "hold"; orders: number; kg: number }>();
    for (const { o, stage } of actionable) {
      const g = groups.get(o.status) ?? { status: o.status, stage, orders: 0, kg: 0 };
      g.orders += 1; g.kg += kgOf(o);
      groups.set(o.status, g);
    }
    needsAction = { detail: false, rows: [...groups.values()].map((g) => ({ ...g, kg: round1(g.kg) })), total: actionable.length };
  }

  // ── What each pipeline card holds (oldest first; delivered: today's kilograms per order) ──
  type Item = { id: string; orderNumber: number; status: string; createdAt: Date; customer: { name: string; nameAr: string | null }; kg: number; stage: Stage | "hold" | "delivered" };
  // fix/order-progress-ui: «معلّق مؤقتاً» is a card of its own; «سُلّم اليوم» leaves out an order that
  // was cancelled or rejected since (countsAsDelivered) — the same rule as the Orders `?stage=`.
  const lists: Record<PipelineStage, Item[]> = { approval: [], roasting: [], qc: [], packing: [], ready: [], delivered: [], hold: [] };
  for (const { o, stage } of staged) lists[stage].push({ ...o, kg: kgOf(o), stage });
  const deliveredBy = new Map<string, Item>();
  for (const d of deliveries) {
    const o = d.orderItem.order;
    if (!countsAsDelivered(o.status)) continue;
    const it = deliveredBy.get(o.id) ?? { id: o.id, orderNumber: o.orderNumber, status: o.status, createdAt: o.createdAt, customer: o.customer, kg: 0, stage: "delivered" as const };
    it.kg += d.quantityKg;
    deliveredBy.set(o.id, it);
  }
  lists.delivered = [...deliveredBy.values()].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.orderNumber - y.orderNumber);
  const keys = Object.keys(lists) as PipelineStage[];
  let stages: TodayData["stages"];
  if (opts.customerDetail) {
    const byStage = {} as Record<PipelineStage, { total: number; rows: StageOrderRow[] }>;
    for (const k of keys) byStage[k] = {
      total: lists[k].length,
      rows: lists[k].slice(0, STAGE_LIST_LIMIT).map((x) => ({ id: x.id, orderNumber: x.orderNumber, customer: x.customer, status: x.status, stage: x.stage, kg: round1(x.kg) })),
    };
    stages = { detail: true, byStage };
  } else {
    const byStage = {} as Record<PipelineStage, { total: number; rows: StageGroupRow[] }>;
    for (const k of keys) {
      const groups = new Map<string, StageGroupRow>();
      for (const x of lists[k]) {
        const g = groups.get(x.status) ?? { status: x.status, stage: x.stage, orders: 0, kg: 0 };
        g.orders += 1; g.kg += x.kg;
        groups.set(x.status, g);
      }
      byStage[k] = { total: lists[k].length, rows: [...groups.values()].map((g) => ({ ...g, kg: round1(g.kg) })) };
    }
    stages = { detail: false, byStage };
  }

  // ── Green coffee: days of cover at the last 28 days' consumption ──
  const used = new Map(usage.map((u) => [u.greenBeanId as string, u._sum.greenBeanQuantity ?? 0]));
  const green = {
    rows: beans
      .map((b) => {
        const perDay = (used.get(b.id) ?? 0) / COVER_WINDOW_DAYS;
        return perDay > 0 ? { id: b.id, name: b.beanType, nameAr: b.beanTypeAr, kg: round1(Math.max(0, b.quantityKg)), days: Math.floor(Math.max(0, b.quantityKg) / perDay) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.days - b.days || a.kg - b.kg)
      .slice(0, 5),
    windowDays: COVER_WINDOW_DAYS,
    scaleDays: COVER_SCALE_DAYS,
  };

  return {
    generatedAt: now.toISOString(),
    roasted,
    pipeline: { ...counts, deliveredToday, open, onHold, qcLongestHours, qcOverdue },
    needsAction,
    stages,
    green,
  };
}
