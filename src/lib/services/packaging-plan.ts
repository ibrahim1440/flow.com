import type { Prisma } from "@/generated/prisma/client";
import type { prisma } from "@/lib/db";
import { outstandingUnitsForLine, resolveBatchCoffeeIdentity, resolvePackagingReservationTarget, type IdentifiableBatch } from "@/lib/services/batch-identity";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * The packaging plan a roast opens with (production simplification item 6).
 *
 *   · Only the SKUs of the batch's own coffee — resolveBatchCoffeeIdentity, the same proof the
 *     commit applies — so a size of another coffee is never offered (the screen used to list every
 *     active SKU and the commit then refused «not made from the coffee on this roast»).
 *   · Counts pre-filled from open demand: the line the roast was made for first (the commit reserves
 *     its packages to that line), then each open order line of those SKUs, oldest order first, takes
 *     min(outstandingUnitsForLine, what the roast still holds); the rest is left for the shelf.
 *   · Weight is the SKU's nominal weight; a partial package is the operator's deliberate exception.
 *
 * A suggestion only: the operator changes the counts, and previewPackaging / commitPackaging (and
 * their idempotency key) decide exactly as before. `suggestPlan` is pure (unit-tested).
 */
export const OPEN_DEMAND_STATUSES = ["Waiting Approval", "Waiting Preparation Review", "Preparing", "Ready for Shipping"] as const;

export type PlanSku = { id: string; skuCode: string; name: string; weightGrams: number; hasBom: boolean };
export type DemandLine = { orderItemId: string; orderNumber: number; orderCreatedAt: string | Date; productSkuId: string; outstandingUnits: number };
export type PlanRow = PlanSku & { suggested: number; outstandingUnits: number; forOrders: number[] };

export function suggestPlan(skus: PlanSku[], demand: DemandLine[], availableGrams: number, ownerOrderItemId: string | null = null): PlanRow[] {
  const rows = new Map<string, PlanRow>(skus.map((s) => [s.id, { ...s, suggested: 0, outstandingUnits: 0, forOrders: [] }]));
  let left = Math.max(0, Math.floor(availableGrams));
  const ordered = [...demand].sort((a, b) =>
    Number(b.orderItemId === ownerOrderItemId) - Number(a.orderItemId === ownerOrderItemId)
    || new Date(a.orderCreatedAt).getTime() - new Date(b.orderCreatedAt).getTime() || a.orderNumber - b.orderNumber);
  for (const d of ordered) {
    const row = rows.get(d.productSkuId);
    if (!row || d.outstandingUnits <= 0) continue;
    row.outstandingUnits += d.outstandingUnits;
    if (!row.hasBom || row.weightGrams <= 0) continue;
    const n = Math.min(d.outstandingUnits, Math.floor(left / row.weightGrams));
    if (n > 0) {
      row.suggested += n;
      left -= n * row.weightGrams;
      if (!row.forOrders.includes(d.orderNumber)) row.forOrders.push(d.orderNumber);
    }
  }
  // Largest size first: the bench fills the big bags before the small ones.
  return [...rows.values()].sort((a, b) => b.weightGrams - a.weightGrams || a.skuCode.localeCompare(b.skuCode));
}

export type PackagingPlan =
  | { ok: true; productId: string; productNameEn: string; productNameAr: string | null; rows: PlanRow[] }
  | { ok: false; error: string };

export async function packagingPlan(db: Db, batch: IdentifiableBatch, availableGrams: number): Promise<PackagingPlan> {
  const identity = await resolveBatchCoffeeIdentity(db as Prisma.TransactionClient, batch);
  if (!identity.ok) return { ok: false, error: identity.message };
  const product = await db.coffeeProduct.findUnique({ where: { id: identity.productId }, select: { id: true, productNameEn: true, productNameAr: true } });
  const skuRows = await db.productSKU.findMany({
    where: { productId: identity.productId, isActive: true },
    select: { id: true, skuCode: true, name: true, nameAr: true, weightGrams: true, _count: { select: { bomComponents: true } } },
  });
  const skus: PlanSku[] = skuRows.map((s) => ({ id: s.id, skuCode: s.skuCode, name: s.nameAr || s.name || s.skuCode, weightGrams: Math.round(s.weightGrams), hasBom: s._count.bomComponents > 0 }));
  const lines = skus.length
    ? await db.orderItem.findMany({
        where: {
          productSkuId: { in: skus.map((s) => s.id) },
          quantityUnits: { not: null },
          OR: [{ preparationDecision: null }, { preparationDecision: { not: "Blocked" } }],
          order: { status: { in: [...OPEN_DEMAND_STATUSES] } },
        },
        select: { id: true, productSkuId: true, quantityUnits: true, deliveredUnits: true, order: { select: { orderNumber: true, createdAt: true } } },
        orderBy: [{ order: { createdAt: "asc" } }],
        take: 200,
      })
    : [];
  const demand: DemandLine[] = [];
  for (const l of lines) {
    const outstanding = await outstandingUnitsForLine(db as Prisma.TransactionClient, { id: l.id, quantityUnits: l.quantityUnits!, deliveredUnits: l.deliveredUnits });
    if (outstanding > 0) demand.push({ orderItemId: l.id, orderNumber: l.order.orderNumber, orderCreatedAt: l.order.createdAt, productSkuId: l.productSkuId!, outstandingUnits: outstanding });
  }
  return {
    ok: true,
    productId: identity.productId,
    productNameEn: product?.productNameEn ?? "",
    productNameAr: product?.productNameAr ?? null,
    rows: suggestPlan(skus, demand, availableGrams, await resolvePackagingReservationTarget(db as Prisma.TransactionClient, batch)),
  };
}
