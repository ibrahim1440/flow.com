// Workstations W4 — «التعبئة», the packaging tab of the packaging station (Figma PA1–PA3, P5).
//
// The station packs through the ERP's own packaging operation and nothing else:
// GET/POST /api/roasting-batches/[id]/pack (the plan, the server preview, the commit with its
// Idempotency-Key, the BOM material draw, the reservation to the order line the roast was made for,
// the order recompute). This file only READS what the station shows around it:
//
//   · PA1: released batches only — QC «Passed» or «Partially Packaged» with coffee left on them; a
//     batch waiting for QC is listed as «غير متاحة»; a rejected one is never offered (P5).
//   · P5: what blocks packaging — a material short for the planned packages, a rejected batch.
//   · PA2: the order line the packages will be reserved to (the same rule the commit applies) and
//     how far the material shelf goes (`maxPackagesFor`, the «تعبئة 12 الآن» of the shortage frame).
import { QC_HOLD_STATUS } from "@/lib/qc/spec";
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { packagingPlan } from "@/lib/services/packaging-plan";
import { gramsFromKg } from "@/lib/services/unified-packaging";
import { outstandingUnitsForLine, resolvePackagingReservationTarget } from "@/lib/services/batch-identity";
import { maxPackagesFor, firstShortage } from "@/lib/station/prep-rules";

export { maxPackagesFor, firstShortage };

const PACKABLE = ["Passed", "Partially Packaged"];
/** Under 50 g left is «packed out» (the threshold the pack route uses). */
const MIN_GRAMS = 50;

type Db = Prisma.TransactionClient | typeof prisma;

export type PackBatch = {
  id: string; batchNumber: string; status: string; nameEn: string; nameAr: string | null;
  availableKg: number; releasedAt: string;
  order: { orderNumber: number } | null; forStock: boolean;
  /** The plan's first size with packages suggested (largest first), if any. */
  plan: { skuId: string; skuCode: string; suggested: number } | null;
  /** A material short for the planned packages (P5 «مواد ناقصة»). */
  shortage: { material: string; required: number; available: number } | null;
};
export type PackPending = { id: string; batchNumber: string; nameEn: string; nameAr: string | null; status: string; createdAt: string };
export type PackBlocked = { kind: "MATERIAL_SHORT" | "REJECTED" | "QC_HOLD"; id: string; batchNumber: string; nameEn: string; nameAr: string | null; material?: string; required?: number; available?: number };

const BATCH_SELECT = {
  id: true, batchNumber: true, status: true, roastedAvailableKg: true, updatedAt: true, createdAt: true, productId: true, orderItemId: true, productionOrderId: true,
  product: { select: { productNameEn: true, productNameAr: true } },
  orderItem: { select: { order: { select: { orderNumber: true } } } },
  productionOrder: { select: { sourceOrderItem: { select: { order: { select: { orderNumber: true } } } } } },
} satisfies Prisma.RoastingBatchSelect;
type BatchRow = Prisma.RoastingBatchGetPayload<{ select: typeof BATCH_SELECT }>;

/** Material pieces one package of the SKU draws (its BOM), and the shelf. */
async function materialFacts(db: Db, skuIds: string[]) {
  if (skuIds.length === 0) return new Map<string, { materialItemId: string; name: string; perPackage: number; onHand: number }[]>();
  const rows = await db.bomComponent.findMany({
    where: { productSkuId: { in: skuIds }, type: "MATERIAL", materialItemId: { not: null } },
    select: { productSkuId: true, quantityPerUnit: true, materialItem: { select: { id: true, name: true, nameAr: true, quantityOnHand: true } } },
  });
  const out = new Map<string, { materialItemId: string; name: string; perPackage: number; onHand: number }[]>();
  for (const r of rows) {
    if (!r.materialItem) continue;
    const list = out.get(r.productSkuId) ?? [];
    list.push({ materialItemId: r.materialItem.id, name: r.materialItem.nameAr || r.materialItem.name, perPackage: r.quantityPerUnit, onHand: r.materialItem.quantityOnHand });
    out.set(r.productSkuId, list);
  }
  return out;
}

const nameOf = (b: BatchRow) => ({ nameEn: b.product?.productNameEn ?? b.batchNumber, nameAr: b.product?.productNameAr ?? null });
const orderOf = (b: BatchRow) => b.orderItem?.order ?? b.productionOrder?.sourceOrderItem?.order ?? null;

/** PA1 + P5. */
export async function packagingQueue() {
  const [ready, pending, rejected, held] = await Promise.all([
    prisma.roastingBatch.findMany({ where: { status: { in: PACKABLE }, roastedAvailableKg: { gte: MIN_GRAMS / 1000 } }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: 60, select: BATCH_SELECT }),
    prisma.roastingBatch.findMany({ where: { status: "Pending QC", roastedAvailableKg: { gte: MIN_GRAMS / 1000 } }, orderBy: [{ createdAt: "asc" }], take: 20, select: BATCH_SELECT }),
    prisma.roastingBatch.findMany({ where: { status: "Rejected", roastedAvailableKg: { gte: MIN_GRAMS / 1000 }, updatedAt: { gte: new Date(Date.now() - 14 * 24 * 3600_000) } }, orderBy: [{ updatedAt: "desc" }], take: 10, select: BATCH_SELECT }),
    // QC W3: held batches («محجوزة») are never packed; P5 says so, and who releases them.
    prisma.roastingBatch.findMany({ where: { status: QC_HOLD_STATUS }, orderBy: [{ updatedAt: "desc" }], take: 20, select: BATCH_SELECT }),
  ]);
  const plans = await Promise.all(ready.map((b) => packagingPlan(prisma, b, gramsFromKg(b.roastedAvailableKg))));
  // The plan's first size with packages suggested from open demand; a roast for the shelf: the
  // first size with components, as many packages as the coffee fills.
  const firstRows = plans.map((p, i) => {
    if (!p.ok) return null;
    const r = p.rows.find((x) => x.suggested > 0 && x.hasBom) ?? p.rows.find((x) => x.hasBom && x.weightGrams > 0) ?? null;
    return r ? { ...r, suggested: r.suggested || Math.floor(gramsFromKg(ready[i].roastedAvailableKg) / r.weightGrams) } : null;
  });
  const mats = await materialFacts(prisma, [...new Set(firstRows.filter(Boolean).map((r) => r!.id))]);
  const batches: PackBatch[] = ready.map((b, i) => {
    const row = firstRows[i];
    let shortage: PackBatch["shortage"] = null;
    if (row) {
      for (const m of mats.get(row.id) ?? []) {
        const required = Math.ceil(m.perPackage * row.suggested);
        if (m.onHand < required) { shortage = { material: m.name, required, available: Math.max(0, Math.floor(m.onHand)) }; break; }
      }
    }
    const o = orderOf(b);
    return {
      id: b.id, batchNumber: b.batchNumber, status: b.status, ...nameOf(b), availableKg: +b.roastedAvailableKg.toFixed(3), releasedAt: b.updatedAt.toISOString(),
      order: o ? { orderNumber: o.orderNumber } : null, forStock: !o, plan: row ? { skuId: row.id, skuCode: row.skuCode, suggested: row.suggested } : null, shortage,
    };
  });
  const blocked: PackBlocked[] = [
    ...batches.filter((b) => b.shortage).map((b) => ({ kind: "MATERIAL_SHORT" as const, id: b.id, batchNumber: b.batchNumber, nameEn: b.nameEn, nameAr: b.nameAr, material: b.shortage!.material, required: b.shortage!.required, available: b.shortage!.available })),
    ...rejected.map((b) => ({ kind: "REJECTED" as const, id: b.id, batchNumber: b.batchNumber, ...nameOf(b) })),
    ...held.map((b) => ({ kind: "QC_HOLD" as const, id: b.id, batchNumber: b.batchNumber, ...nameOf(b) })),
  ];
  const pendingOut: PackPending[] = pending.map((b) => ({ id: b.id, batchNumber: b.batchNumber, status: b.status, ...nameOf(b), createdAt: b.createdAt.toISOString() }));
  const version = createHash("sha256").update(JSON.stringify([batches, pendingOut, blocked])).digest("hex").slice(0, 16);
  return { batches, pending: pendingOut, blocked, serverTime: new Date().toISOString(), version };
}

/**
 * PA2 around the pack route's own GET: the batch, the order line the packages will be reserved to
 * (the commit's rule: resolvePackagingReservationTarget, one owning line of that SKU) with how many
 * it still needs, and each size's materials per package and on the shelf.
 */
export async function packagingTaskFacts(batchId: string) {
  const b = await prisma.roastingBatch.findUnique({ where: { id: batchId }, select: BATCH_SELECT });
  if (!b) return null;
  const ownerId = await resolvePackagingReservationTarget(prisma as unknown as Prisma.TransactionClient, b);
  let owner: { orderItemId: string; orderNumber: number; productSkuId: string | null; outstandingUnits: number } | null = null;
  if (ownerId) {
    const l = await prisma.orderItem.findUnique({ where: { id: ownerId }, select: { id: true, productSkuId: true, quantityUnits: true, deliveredUnits: true, order: { select: { orderNumber: true } } } });
    if (l && l.quantityUnits !== null) {
      owner = { orderItemId: l.id, orderNumber: l.order.orderNumber, productSkuId: l.productSkuId, outstandingUnits: await outstandingUnitsForLine(prisma as unknown as Prisma.TransactionClient, { id: l.id, quantityUnits: l.quantityUnits, deliveredUnits: l.deliveredUnits }) };
    }
  }
  return { batch: { id: b.id, batchNumber: b.batchNumber, status: b.status, productId: b.productId, ...nameOf(b), availableKg: +b.roastedAvailableKg.toFixed(3), order: orderOf(b), releasedAt: b.updatedAt.toISOString() }, owner };
}

