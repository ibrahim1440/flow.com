/**
 * Lot traceability (Figma 217:2 «سلسلة التتبع»): one finished-goods lot's full chain, read from the
 * relations that already exist — nothing here is stored or inferred beyond them:
 *
 *   purchase ─────────── PurchaseRecord (type GREEN_BEAN, itemId = the green lot), the latest one on
 *                        or before the roast (else the latest one); none → the lot's opening balance
 *   green lot ────────── GreenBean (RoastingBatch.greenBeanId)
 *   roasting batch ───── RoastingBatch (FinishedGoodsLot.packedFromBatchId, or the legacy 1:1
 *                        roastingBatchId), its QC records
 *   packaging ────────── the lot itself, PackagingSource (grams per contributing roast),
 *                        PackagingOperation
 *   orders / dispatch ── StockAllocation (RESERVED / CONSUMED / RELEASED) → OrderItem → Order,
 *                        Delivery rows of those order items
 *
 * «Where each gram went» reconciles the roast: roasted = packed (ROASTED_COFFEE OUT · PACKING) +
 * declared loss (ROASTED_COFFEE LOSS) + blended out (BlendIngredient as source) + still unpacked
 * (roastedAvailableKg). `gapKg` is what the ledger does not explain (0 → «مطابقة كاملة»).
 */
import { prisma } from "@/lib/db";

const r3 = (n: number) => Number(n.toFixed(3));

export async function lotTrace(id: string) {
  const lot = await prisma.finishedGoodsLot.findUnique({
    where: { id },
    include: {
      product: { select: { productNameEn: true, productNameAr: true, expectedRoastLoss: true } },
      productSku: { select: { id: true, skuCode: true, name: true, nameAr: true, weightGrams: true } },
      sources: { orderBy: { createdAt: "asc" }, select: { roastingBatchId: true, gramsContributed: true, createdAt: true } },
      packagingOperations: { orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true, quantityUnits: true, quantityKg: true, userId: true, method: true } },
      allocations: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true, status: true, quantityUnits: true, quantityKg: true, createdAt: true, updatedAt: true, createdById: true,
          orderItem: { select: { id: true, quantityUnits: true, deliveredUnits: true, deliveryStatus: true, order: { select: { id: true, orderNumber: true, status: true, customer: { select: { name: true, nameAr: true } } } }, deliveries: { orderBy: { date: "asc" }, select: { id: true, date: true, quantityUnits: true, quantityKg: true } } } },
        },
      },
    },
  });
  if (!lot) return null;

  const batchId = lot.packedFromBatchId ?? lot.roastingBatchId ?? lot.sources[0]?.roastingBatchId ?? null;
  const batch = batchId ? await prisma.roastingBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true, batchNumber: true, date: true, status: true, greenBeanQuantity: true, roastedBeanQuantity: true, wasteQuantity: true, roastedAvailableKg: true, roastProfile: true, isBlend: true,
      greenBean: { select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true, process: true, processAr: true, country: true, countryAr: true, location: true, quantityKg: true, receivedDate: true } },
      qcRecords: { orderBy: { date: "asc" }, select: { id: true, date: true, decision: true, onProfile: true, colorWhole: true, colorGround: true, testerName: true, employeeId: true } },
      blendOutputs: { select: { quantityUsed: true } },
    },
  }) : null;

  const [movements, purchase, siblingSources] = await Promise.all([
    batch ? prisma.inventoryMovement.findMany({ where: { OR: [{ category: "ROASTED_COFFEE", referenceEntityId: batch.id }, { sourceDocType: "ROASTING_BATCH", sourceDocId: batch.id }, { category: "FINISHED_GOODS", referenceEntityId: lot.id }] }, orderBy: { timestamp: "asc" } }) : prisma.inventoryMovement.findMany({ where: { category: "FINISHED_GOODS", referenceEntityId: lot.id }, orderBy: { timestamp: "asc" } }),
    batch?.greenBean ? (async () => {
      const where = { type: "GREEN_BEAN" as const, itemId: batch.greenBean!.id };
      return (await prisma.purchaseRecord.findFirst({ where: { ...where, purchaseDate: { lte: batch.date } }, orderBy: { purchaseDate: "desc" }, include: { supplier: { select: { name: true } } } }))
        ?? prisma.purchaseRecord.findFirst({ where, orderBy: { purchaseDate: "desc" }, include: { supplier: { select: { name: true } } } });
    })() : null,
    batch ? prisma.packagingSource.findMany({ where: { roastingBatchId: batch.id }, select: { gramsContributed: true, finishedGoodsLot: { select: { id: true, status: true, unitsProduced: true, productSku: { select: { skuCode: true, weightGrams: true } } } } } }) : [],
  ]);

  const userIds = [...new Set([...movements.map((m) => m.userId), ...lot.packagingOperations.map((o) => o.userId), ...lot.allocations.map((a) => a.createdById), ...(batch?.qcRecords.map((q) => q.employeeId) ?? []), purchase?.userId].filter((x): x is string => !!x))];
  const emps = userIds.length ? await prisma.employee.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const who = (uid: string | null | undefined) => (uid ? emps.find((e) => e.id === uid)?.name ?? null : null);

  // Where each gram of the roast went.
  let gramsFlow = null;
  if (batch) {
    const roastMv = movements.filter((m) => m.category === "ROASTED_COFFEE" && m.referenceEntityId === batch.id);
    const packed = r3(-roastMv.filter((m) => m.type === "OUT" && m.sourceDocType === "PACKING").reduce((s, m) => s + m.quantityChanged, 0));
    const loss = r3(-roastMv.filter((m) => m.type === "LOSS").reduce((s, m) => s + m.quantityChanged, 0));
    const blended = r3(batch.blendOutputs.reduce((s, b) => s + b.quantityUsed, 0));
    const unpacked = r3(batch.roastedAvailableKg);
    const roasted = r3(batch.roastedBeanQuantity);
    // Packed, by SKU: whole packages vs partial ones, from the grams each lot took from this roast.
    const bySku = new Map<string, { skuCode: string; weightGrams: number; grams: number; partialGrams: number }>();
    for (const s of siblingSources) {
      const k = s.finishedGoodsLot.productSku?.skuCode ?? "—";
      const e = bySku.get(k) ?? { skuCode: k, weightGrams: s.finishedGoodsLot.productSku?.weightGrams ?? 0, grams: 0, partialGrams: 0 };
      if (s.finishedGoodsLot.status === "PARTIAL") e.partialGrams += s.gramsContributed; else e.grams += s.gramsContributed;
      bySku.set(k, e);
    }
    gramsFlow = {
      roastedKg: roasted, packedKg: packed, lossKg: loss, blendedKg: blended, unpackedKg: unpacked,
      gapKg: r3(roasted - packed - loss - blended - unpacked),
      packedBySku: [...bySku.values()].map((e) => ({ ...e, kg: r3(e.grams / 1000), partialKg: r3(e.partialGrams / 1000) })),
      roastLossPct: batch.greenBeanQuantity > 0 ? Number((((batch.greenBeanQuantity - batch.roastedBeanQuantity) / batch.greenBeanQuantity) * 100).toFixed(1)) : null,
    };
  }

  const fromBatchGrams = batch ? lot.sources.filter((s) => s.roastingBatchId === batch.id).reduce((s, x) => s + x.gramsContributed, 0) : 0;
  const reservedOrders = lot.allocations.filter((a) => a.status === "RESERVED");

  // The lot's log, newest first: reservations, deliveries, packing, QC, roast, purchase.
  type Ev = { at: Date; kind: string; text: Record<string, unknown>; by: string | null };
  const events: Ev[] = [];
  for (const a of lot.allocations) {
    events.push({ at: a.createdAt, kind: "RESERVED", text: { units: a.quantityUnits, kg: a.quantityKg, order: a.orderItem.order.orderNumber }, by: who(a.createdById) });
    if (a.status === "RELEASED") events.push({ at: a.updatedAt, kind: "RELEASED", text: { units: a.quantityUnits, order: a.orderItem.order.orderNumber }, by: null });
  }
  for (const m of movements.filter((x) => x.category === "FINISHED_GOODS" && x.sourceDocType === "DELIVERY")) {
    events.push({ at: m.timestamp, kind: "DELIVERED", text: { kg: -m.quantityChanged, note: m.notes }, by: who(m.userId) });
  }
  for (const o of lot.packagingOperations) events.push({ at: o.createdAt, kind: "PACKED", text: { units: o.quantityUnits, kg: o.quantityKg, sku: lot.productSku?.skuCode ?? null }, by: who(o.userId) });
  if (!lot.packagingOperations.length) events.push({ at: lot.createdAt, kind: "PACKED", text: { units: lot.unitsProduced, kg: lot.quantityKg, sku: lot.productSku?.skuCode ?? null }, by: null });
  for (const q of batch?.qcRecords ?? []) events.push({ at: q.date, kind: "QC", text: { decision: q.decision, batch: batch!.batchNumber }, by: q.testerName ?? who(q.employeeId) });
  if (batch) {
    const draw = movements.find((m) => m.sourceDocType === "ROASTING_BATCH" && m.sourceDocId === batch.id && m.type === "OUT");
    events.push({ at: batch.date, kind: "ROASTED", text: { batch: batch.batchNumber, greenKg: batch.greenBeanQuantity, serial: batch.greenBean?.serialNumber ?? null }, by: who(draw?.userId) });
  }
  if (purchase) events.push({ at: purchase.purchaseDate, kind: "PURCHASED", text: { kg: purchase.quantity, supplier: purchase.supplier.name }, by: who(purchase.userId) });
  events.sort((a, b) => b.at.getTime() - a.at.getTime());

  return {
    lot: {
      id: lot.id, batchNumber: lot.batchNumber, status: lot.status, createdAt: lot.createdAt, isUnitTracked: lot.isUnitTracked,
      unitsProduced: lot.unitsProduced, unitsAvailable: lot.unitsAvailable, unitsReserved: lot.unitsReserved,
      unitsFree: Math.max(0, lot.unitsAvailable - lot.unitsReserved),
      quantityKg: lot.quantityKg, availableQty: lot.availableQty, reservedQty: lot.reservedQty,
      actualContentGrams: lot.actualContentGrams, nominalContentGrams: lot.nominalContentGrams,
      fromBatchKg: r3(fromBatchGrams / 1000),
      product: lot.product, sku: lot.productSku,
      reservedFor: [...new Set(reservedOrders.map((a) => a.orderItem.order.orderNumber))],
    },
    purchase: purchase ? { id: purchase.id, date: purchase.purchaseDate, supplier: purchase.supplier.name, quantity: purchase.quantity, costPerUnit: purchase.costPerUnit, totalCost: purchase.totalCost } : null,
    greenLot: batch?.greenBean ?? null,
    batch: batch ? {
      id: batch.id, batchNumber: batch.batchNumber, date: batch.date, status: batch.status, greenKg: batch.greenBeanQuantity, roastedKg: batch.roastedBeanQuantity,
      roastProfile: batch.roastProfile, qc: batch.qcRecords.map((q) => ({ date: q.date, decision: q.decision, onProfile: q.onProfile, colorWhole: q.colorWhole, colorGround: q.colorGround, by: q.testerName ?? who(q.employeeId) })),
    } : null,
    gramsFlow,
    orders: lot.allocations.map((a) => ({
      id: a.id, status: a.status, units: a.quantityUnits, kg: a.quantityKg, createdAt: a.createdAt,
      order: { id: a.orderItem.order.id, number: a.orderItem.order.orderNumber, status: a.orderItem.order.status, customer: a.orderItem.order.customer.name, customerAr: a.orderItem.order.customer.nameAr },
      deliveredUnits: a.orderItem.deliveredUnits, deliveryStatus: a.orderItem.deliveryStatus,
      lastDelivery: a.orderItem.deliveries.at(-1)?.date ?? null,
    })),
    events: events.map((e) => ({ ...e, at: e.at.toISOString() })),
  };
}
