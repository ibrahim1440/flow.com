import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { CUSTOMER_DELIVERY_SELECT } from "@/lib/auth/customer-detail";
import { DELIVERY_ALLOWED_STATUSES } from "@/lib/services/order-operations";
import { lotMatchFilter, roundKg } from "@/lib/services/shelf-allocation";
import { packSizeLabel } from "@/lib/services/finished-products";
import { planDispatch, type PlanCandidate } from "@/lib/services/delivery-lots";

/**
 * GET /api/deliveries/ready — the dispatch screen's «جاهز للتسليم» list (Phase D).
 *
 * One card per order that has something to hand over now, with each line's ready quantity and
 * a read-only preview of the lots it would leave from: the line's reservations first, then free
 * stock, oldest lot first — the same planner POST /api/deliveries runs. The preview is advisory
 * (free stock is shared, and another dispatch may take it first); the POST re-plans under locks.
 *
 * Read gate: the dispatch module, as for GET /api/deliveries; customer name only (owner policy F4).
 * Read-only: no lock, no write.
 */
export async function GET() {
  const { error } = await requireModule("dispatch");
  if (error) return error;

  const orders = await prisma.order.findMany({
    where: { status: { in: DELIVERY_ALLOWED_STATUSES }, items: { some: { deliveryStatus: { not: "Delivered" } } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 300,
    select: {
      id: true, orderNumber: true, status: true, createdAt: true,
      customer: { select: CUSTOMER_DELIVERY_SELECT },
      items: {
        orderBy: { id: "asc" },
        select: {
          id: true, beanTypeName: true, productId: true, productSkuId: true, greenBeanId: true,
          quantityKg: true, deliveredQty: true, quantityUnits: true, deliveredUnits: true,
          deliveryStatus: true, preparationDecision: true,
          product: { select: { productNameEn: true, productNameAr: true } },
          productSku: { select: { id: true, skuCode: true, weightGrams: true, name: true, nameAr: true } },
        },
      },
    },
  });

  const items = orders.flatMap((o) => o.items);
  const unitItems = items.filter((i) => i.quantityUnits !== null && i.productSku);
  const skuIds = [...new Set(unitItems.map((i) => i.productSku!.id))];

  const [unitLots, unitHeld] = await Promise.all([
    skuIds.length
      ? prisma.finishedGoodsLot.findMany({
          where: { productSkuId: { in: skuIds }, isUnitTracked: true, status: "AVAILABLE", unitsAvailable: { gt: 0 } },
          select: { id: true, batchNumber: true, createdAt: true, productSkuId: true, unitsAvailable: true, unitsReserved: true },
        })
      : [],
    unitItems.length
      ? prisma.stockAllocation.groupBy({
          by: ["orderItemId", "finishedGoodsLotId"],
          where: { orderItemId: { in: unitItems.map((i) => i.id) }, status: "RESERVED", quantityUnits: { not: null } },
          _sum: { quantityUnits: true },
        })
      : [],
  ]);
  const batchOf = new Map(unitLots.map((l) => [l.id, l.batchNumber]));
  // Free units are shared by every order. The preview hands them out oldest order first (the
  // order this list is read in), so two cards never both count the same free bag as theirs.
  const freeLeft = new Map(unitLots.map((l) => [l.id, Math.max(0, l.unitsAvailable - l.unitsReserved)]));
  const heldBy = new Map<string, Map<string, number>>();
  for (const h of unitHeld) {
    const m = heldBy.get(h.orderItemId) ?? new Map<string, number>();
    m.set(h.finishedGoodsLotId, h._sum.quantityUnits ?? 0);
    heldBy.set(h.orderItemId, m);
  }

  type Line = {
    orderItemId: string; isUnitLine: boolean; nameEn: string; nameAr: string | null; pack: string | null; skuCode: string | null;
    ordered: number; delivered: number; outstanding: number; reserved: number; ready: number; blocked: boolean;
    sources: { lotId: string; batchNumber: string | null; quantity: number; fromReservation: number }[];
  };

  const lineOf = async (i: (typeof items)[number]): Promise<Line> => {
    const nameEn = i.productSku?.name || i.product?.productNameEn || i.beanTypeName;
    const nameAr = i.productSku?.nameAr || i.product?.productNameAr || null;
    const blocked = i.preparationDecision === "Blocked";
    if (i.quantityUnits !== null && i.productSku) {
      const sku = i.productSku;
      const outstanding = Math.max(0, i.quantityUnits - i.deliveredUnits);
      const held = heldBy.get(i.id) ?? new Map<string, number>();
      const cands: PlanCandidate[] = unitLots
        .filter((l) => l.productSkuId === sku.id)
        .map((l) => ({ lotId: l.id, createdAt: l.createdAt, held: Math.min(held.get(l.id) ?? 0, l.unitsAvailable), free: freeLeft.get(l.id) ?? 0 }));
      const plan = blocked ? { lots: [], covered: 0, ready: 0 } : planDispatch(cands, outstanding);
      for (const l of plan.lots) if (l.fromFree > 0) freeLeft.set(l.lotId, Math.max(0, (freeLeft.get(l.lotId) ?? 0) - l.fromFree));
      return {
        orderItemId: i.id, isUnitLine: true, nameEn, nameAr,
        // A named SKU already says its size («… 1 كغ»); only a product-name fallback needs it added.
        pack: sku.name || sku.nameAr ? null : packSizeLabel(sku.weightGrams), skuCode: sku.skuCode,
        ordered: i.quantityUnits, delivered: i.deliveredUnits, outstanding,
        reserved: [...held.values()].reduce((s, v) => s + v, 0),
        ready: Math.min(outstanding, plan.covered), blocked,
        sources: plan.lots.map((l) => ({ lotId: l.lotId, batchNumber: batchOf.get(l.lotId) ?? null, quantity: l.quantity, fromReservation: l.fromHeld })),
      };
    }
    // Kilogram line (legacy bulk): the same rule on availableQty / reservedQty.
    const outstanding = Math.max(0, roundKg(i.quantityKg - i.deliveredQty));
    const [lots, heldRows] = await Promise.all([
      prisma.finishedGoodsLot.findMany({
        where: { ...lotMatchFilter(i), availableQty: { gt: 0 } },
        select: { id: true, batchNumber: true, createdAt: true, availableQty: true, reservedQty: true },
      }),
      prisma.stockAllocation.groupBy({
        by: ["finishedGoodsLotId"],
        where: { orderItemId: i.id, status: "RESERVED", quantityUnits: null },
        _sum: { quantityKg: true },
      }),
    ]);
    const held = new Map(heldRows.map((h) => [h.finishedGoodsLotId, roundKg(h._sum.quantityKg ?? 0)]));
    const cands: PlanCandidate[] = lots.map((l) => ({
      lotId: l.id, createdAt: l.createdAt, held: roundKg(Math.min(held.get(l.id) ?? 0, l.availableQty)), free: Math.max(0, roundKg(l.availableQty - l.reservedQty)),
    }));
    const plan = blocked ? { lots: [], covered: 0, ready: 0 } : planDispatch(cands, outstanding, true);
    const batch = new Map(lots.map((l) => [l.id, l.batchNumber]));
    return {
      orderItemId: i.id, isUnitLine: false, nameEn, nameAr, pack: null, skuCode: null,
      ordered: i.quantityKg, delivered: i.deliveredQty, outstanding,
      reserved: roundKg([...held.values()].reduce((s, v) => s + v, 0)),
      ready: roundKg(Math.min(outstanding, plan.covered)), blocked,
      sources: plan.lots.map((l) => ({ lotId: l.lotId, batchNumber: batch.get(l.lotId) ?? null, quantity: l.quantity, fromReservation: l.fromHeld })),
    };
  };

  const out = [];
  for (const o of orders) {
    const lines: Line[] = [];
    // Sequential on purpose: the free-unit hand-out above depends on order.
    for (const i of o.items) if (i.deliveryStatus !== "Delivered") lines.push(await lineOf(i));
    const open = lines.filter((l) => l.outstanding > 0);
    if (!open.some((l) => l.ready > 0)) continue;
    out.push({
      id: o.id, orderNumber: o.orderNumber, status: o.status, createdAt: o.createdAt,
      customer: { name: o.customer.name, nameAr: o.customer.nameAr },
      lines: open,
      // The order goes out complete when every open line can be handed over in full now.
      complete: open.every((l) => l.ready >= l.outstanding),
    });
  }
  return NextResponse.json({ orders: out });
}
