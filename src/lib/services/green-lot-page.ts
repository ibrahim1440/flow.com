/**
 * A green-coffee lot's page (20261114090000_green_lot_labels): what its QR code opens. Existing relations only —
 * PurchaseRecord (GREEN_BEAN, itemId) → the receipt / invoice, RoastingBatch.greenBeanId → the roasts drawn, posted
 * InventoryCountLine (RAW_MATERIAL) → the counts, PrintAuditLog (PRINT_JOB items naming the lot) → the label prints.
 * Read-only. No price leaves this function.
 */
import { prisma } from "@/lib/db";
import { parseScan } from "@/lib/scan/codes";
import { greenLotReceipts } from "./green-lot-receipts";

export async function greenLotPage(ref: string) {
  const p = parseScan(ref);
  const lot = await prisma.greenBean.findFirst({ where: p.kind === "GREEN_LOT" ? { labelCode: p.code } : { id: ref } });
  if (!lot) return null;
  const [receipts, roasts, counts, prints] = await Promise.all([
    greenLotReceipts([lot.id]),
    prisma.roastingBatch.findMany({
      where: { greenBeanId: lot.id }, orderBy: { date: "desc" }, take: 50,
      select: { id: true, batchNumber: true, date: true, greenBeanQuantity: true, status: true, product: { select: { productNameEn: true, productNameAr: true } } },
    }),
    prisma.inventoryCountLine.findMany({
      where: { category: "RAW_MATERIAL", entityId: lot.id }, orderBy: { createdAt: "desc" }, take: 20,
      select: { id: true, systemQty: true, countedQty: true, postedVariance: true, session: { select: { id: true, number: true, status: true, postedAt: true, createdAt: true } } },
    }),
    prisma.printAuditLog.findMany({
      where: { action: "PRINT_JOB", templateKey: "GREEN_LOT", items: { array_contains: [{ greenBeanId: lot.id }] } },
      orderBy: { createdAt: "desc" }, take: 30,
      select: { id: true, createdAt: true, actorName: true, totalLabels: true, profileName: true, language: true, items: true },
    }),
  ]);
  const r = receipts.get(lot.id)!;
  return {
    lot: {
      id: lot.id, code: lot.labelCode, serialNumber: lot.serialNumber, beanType: lot.beanType, beanTypeAr: lot.beanTypeAr,
      country: lot.country, countryAr: lot.countryAr, region: lot.region, regionAr: lot.regionAr, variety: lot.variety,
      process: lot.process, processAr: lot.processAr, altitude: lot.altitude, location: lot.location,
      quantityKg: lot.quantityKg, isActive: lot.isActive, receivedDate: lot.receivedDate, sackCount: lot.sackCount, sackWeightKg: lot.sackWeightKg,
    },
    supplier: r.supplier, invoiceRef: r.invoiceRef, receivedKg: r.receivedKg,
    receipts: r.receipts.map((x) => ({ date: x.date, supplier: x.supplier, quantityKg: x.quantityKg, invoiceId: x.invoiceId, invoiceNumber: x.invoiceNumber, invoiceRef: x.invoiceRef })),
    roasts: roasts.map((b) => ({ id: b.id, batchNumber: b.batchNumber, date: b.date, greenKg: b.greenBeanQuantity, status: b.status, product: b.product })),
    roastedKg: Math.round(roasts.reduce((a, b) => a + b.greenBeanQuantity, 0) * 1000) / 1000,
    counts: counts.map((c) => ({ id: c.id, sessionId: c.session.id, number: c.session.number, status: c.session.status, at: c.session.postedAt ?? c.session.createdAt, systemQty: c.systemQty, countedQty: c.countedQty, variance: c.postedVariance })),
    prints: prints.map((j) => {
      const items = (Array.isArray(j.items) ? j.items : []) as { greenBeanId?: string; sackNo?: number | null; copies?: number }[];
      const mine = items.filter((i) => i.greenBeanId === lot.id);
      const sacks = mine.map((i) => i.sackNo).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
      return { id: j.id, at: j.createdAt, by: j.actorName, labels: mine.reduce((a, i) => a + (i.copies ?? 1), 0), totalLabels: j.totalLabels, profile: j.profileName, language: j.language, sacks: sacks.length ? { from: sacks[0], to: sacks[sacks.length - 1], n: sacks.length } : null };
    }),
  };
}
