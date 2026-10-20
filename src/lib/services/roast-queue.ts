import { Prisma } from "@/generated/prisma/client";
import { productionGateRefusal } from "@/lib/services/order-operations";

type Db = Prisma.TransactionClient;

/**
 * The roast queue, grouped by coffee (production simplification, Phase C item 2).
 *
 * What the roaster sees is no longer one row per order line but one card per coffee:
 *
 *   demand(coffee) = open order units − shelf free − pipeline
 *
 *   open order units  every non-Blocked SKU line of an order in a preparable status
 *                     («بانتظار التجهيز» / «قيد التجهيز» / «جاهز للشحن»), less what it has
 *                     received (delivered) and what is already promised to it (reserved);
 *   shelf free        units of the SAME SKU on the shelf that nobody holds yet, handed to those
 *                     lines oldest order first (a 250 g bag does not cover a 1 kg order);
 *   pipeline          roasted coffee of this coffee not packed yet: batches in QC (their roasted
 *                     kilograms) and passed batches (what is still unpacked), subtracted from the
 *                     oldest lines first.
 *
 * Everything is in finished (roasted) kilograms. A coffee is a CoffeeProduct; a batch's coffee is
 * its own productId, else its order line's SKU product, else its production order's SKU product
 * (the same sources resolveBatchCoffeeIdentity trusts).
 *
 * `allocateTo` is the line a NEW batch of the coffee is attributed to: the oldest line that still
 * needs roasting after the pipeline and that production may start for (productionGateRefusal).
 * Read-only; the roast route calls it again under its own lock.
 */

export type QueueLine = {
  orderItemId: string;
  orderId: string;
  orderNumber: number;
  customerName: string;
  skuCode: string;
  weightGrams: number;
  /** Finished kilograms this line still needs from the roaster after the pipeline. */
  needKg: number;
  producible: boolean;
};

export type QueueCoffee = {
  productId: string;
  productNameEn: string;
  productNameAr: string | null;
  /** Roasted kilograms still to roast (≥ 0). */
  demandKg: number;
  openKg: number;
  shelfKg: number;
  pipelineKg: number;
  inQcKg: number;
  passedUnpackedKg: number;
  /** Order numbers this coffee's demand serves, oldest first. */
  orders: { orderId: string; orderNumber: number; customerName: string; needKg: number }[];
  /** The line a new batch of this coffee is attributed to, or null (none producible). */
  allocateTo: QueueLine | null;
  lines: QueueLine[];
  green: { id: string; serialNumber: string; quantityKg: number } | null;
  expectedRoastLoss: number;
};

const OPEN_STATUSES = ["Waiting Preparation Review", "Preparing", "Ready for Shipping"];
const r3 = (n: number) => +n.toFixed(3);

export async function roastQueue(db: Db, opts: { productId?: string } = {}): Promise<QueueCoffee[]> {
  const lines = await db.orderItem.findMany({
    where: {
      quantityUnits: { not: null },
      productSkuId: { not: null },
      OR: [{ preparationDecision: null }, { preparationDecision: { not: "Blocked" } }],
      order: { status: { in: OPEN_STATUSES } },
      ...(opts.productId ? { productSku: { productId: opts.productId } } : {}),
    },
    select: {
      id: true, orderId: true, quantityUnits: true, deliveredUnits: true, preparationDecision: true, productSkuId: true,
      productSku: { select: { skuCode: true, weightGrams: true, productId: true } },
      order: { select: { orderNumber: true, createdAt: true, status: true, approvalStatus: true, customer: { select: { name: true } } } },
    },
    orderBy: [{ order: { createdAt: "asc" } }, { order: { orderNumber: "asc" } }, { id: "asc" }],
  });

  const lineIds = lines.map((l) => l.id);
  const reserved = lineIds.length === 0 ? [] : await db.stockAllocation.groupBy({
    by: ["orderItemId"],
    where: { orderItemId: { in: lineIds }, status: "RESERVED", quantityUnits: { not: null } },
    _sum: { quantityUnits: true },
  });
  const reservedBy = new Map(reserved.map((r) => [r.orderItemId, r._sum.quantityUnits ?? 0]));

  const skuIds = [...new Set(lines.map((l) => l.productSkuId!))];
  const shelf = skuIds.length === 0 ? [] : await db.finishedGoodsLot.findMany({
    where: { productSkuId: { in: skuIds }, isUnitTracked: true, status: "AVAILABLE" },
    select: { productSkuId: true, unitsAvailable: true, unitsReserved: true },
  });
  const freeBySku = new Map<string, number>();
  for (const l of shelf) {
    if (!l.productSkuId) continue;
    freeBySku.set(l.productSkuId, (freeBySku.get(l.productSkuId) ?? 0) + Math.max(0, l.unitsAvailable - l.unitsReserved));
  }

  const productIds = [...new Set(lines.map((l) => l.productSku!.productId))];
  if (opts.productId && !productIds.includes(opts.productId)) productIds.push(opts.productId);

  // Pipeline: roasted, not yet packed, not rejected, not a blend source already moved.
  const batches = productIds.length === 0 ? [] : await db.roastingBatch.findMany({
    where: {
      status: { in: ["Pending QC", "Passed", "Partially Packaged"] },
      OR: [
        { productId: { in: productIds } },
        { productId: null, orderItem: { productSku: { productId: { in: productIds } } } },
        { productId: null, orderItemId: null, productionOrder: { productSku: { productId: { in: productIds } } } },
      ],
    },
    select: {
      status: true, roastedBeanQuantity: true, roastedAvailableKg: true, productId: true,
      orderItem: { select: { productSku: { select: { productId: true } } } },
      productionOrder: { select: { productSku: { select: { productId: true } } } },
    },
  });
  const inQc = new Map<string, number>();
  const passed = new Map<string, number>();
  for (const b of batches) {
    const pid = b.productId ?? b.orderItem?.productSku?.productId ?? b.productionOrder?.productSku?.productId ?? null;
    if (!pid) continue;
    if (b.status === "Pending QC") inQc.set(pid, (inQc.get(pid) ?? 0) + b.roastedBeanQuantity);
    else passed.set(pid, (passed.get(pid) ?? 0) + Math.max(0, b.roastedAvailableKg ?? 0));
  }

  const products = productIds.length === 0 ? [] : await db.coffeeProduct.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true, productNameEn: true, productNameAr: true, expectedRoastLoss: true,
      defaultGreenBean: { select: { id: true, serialNumber: true, quantityKg: true } },
    },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  const byProduct = new Map<string, typeof lines>();
  for (const l of lines) {
    const pid = l.productSku!.productId;
    const list = byProduct.get(pid) ?? [];
    list.push(l);
    byProduct.set(pid, list);
  }

  const out: QueueCoffee[] = [];
  for (const pid of productIds) {
    const p = productById.get(pid);
    if (!p) continue;
    const pLines = byProduct.get(pid) ?? [];
    let openKg = 0, shelfKg = 0;
    const queueLines: QueueLine[] = [];
    for (const l of pLines) {
      const w = l.productSku!.weightGrams;
      const open = Math.max(0, (l.quantityUnits ?? 0) - l.deliveredUnits - (reservedBy.get(l.id) ?? 0));
      const free = freeBySku.get(l.productSkuId!) ?? 0;
      const fromShelf = Math.min(open, free);
      freeBySku.set(l.productSkuId!, free - fromShelf);
      openKg += (open * w) / 1000;
      shelfKg += (fromShelf * w) / 1000;
      queueLines.push({
        orderItemId: l.id, orderId: l.orderId, orderNumber: l.order.orderNumber, customerName: l.order.customer.name,
        skuCode: l.productSku!.skuCode, weightGrams: w,
        needKg: ((open - fromShelf) * w) / 1000,
        producible: productionGateRefusal({ preparationDecision: l.preparationDecision, order: l.order }, "start") === null,
      });
    }
    const inQcKg = inQc.get(pid) ?? 0;
    const passedKg = passed.get(pid) ?? 0;
    // The pipeline covers the oldest lines first.
    let pipe = inQcKg + passedKg;
    for (const q of queueLines) {
      const take = Math.min(q.needKg, pipe);
      q.needKg = r3(q.needKg - take);
      pipe -= take;
    }
    const needing = queueLines.filter((q) => q.needKg > 0.0005);
    const demandKg = r3(needing.reduce((s, q) => s + q.needKg, 0));
    const orders: QueueCoffee["orders"] = [];
    for (const q of needing) {
      const o = orders.find((x) => x.orderId === q.orderId);
      if (o) o.needKg = r3(o.needKg + q.needKg);
      else orders.push({ orderId: q.orderId, orderNumber: q.orderNumber, customerName: q.customerName, needKg: q.needKg });
    }
    out.push({
      productId: pid,
      productNameEn: p.productNameEn,
      productNameAr: p.productNameAr,
      demandKg,
      openKg: r3(openKg),
      shelfKg: r3(shelfKg),
      pipelineKg: r3(inQcKg + passedKg),
      inQcKg: r3(inQcKg),
      passedUnpackedKg: r3(passedKg),
      orders,
      allocateTo: needing.find((q) => q.producible) ?? null,
      lines: queueLines,
      green: p.defaultGreenBean ? { id: p.defaultGreenBean.id, serialNumber: p.defaultGreenBean.serialNumber, quantityKg: p.defaultGreenBean.quantityKg } : null,
      expectedRoastLoss: p.expectedRoastLoss,
    });
  }
  // Most needed first, then the oldest order.
  out.sort((a, b) => (b.demandKg > 0 ? 1 : 0) - (a.demandKg > 0 ? 1 : 0) || (a.orders[0]?.orderNumber ?? Infinity) - (b.orders[0]?.orderNumber ?? Infinity));
  return out;
}
