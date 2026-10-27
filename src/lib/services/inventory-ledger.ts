/**
 * The movement ledger (Figma 268:5577): filtered, paginated and enriched reads of InventoryMovement,
 * and the same rows for the CSV export. Read-only. The ledger is append-only; nothing here writes.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { LEDGER_EXPORT_MAX, type LedgerFilter } from "@/lib/inventory/ledger-query";

type Movement = Awaited<ReturnType<typeof prisma.inventoryMovement.findMany>>[number];

/** Entities whose name, code or batch number matches a search, by category. */
async function matchingEntityIds(q: string): Promise<string[]> {
  const ci = { contains: q, mode: "insensitive" as const };
  const [beans, mats, lots, batches] = await Promise.all([
    prisma.greenBean.findMany({ where: { OR: [{ beanType: ci }, { beanTypeAr: ci }, { serialNumber: ci }, { country: ci }] }, select: { id: true }, take: 500 }),
    prisma.materialItem.findMany({ where: { OR: [{ name: ci }, { nameAr: ci }, { code: ci }] }, select: { id: true }, take: 500 }),
    prisma.finishedGoodsLot.findMany({ where: { OR: [{ batchNumber: ci }, { product: { productNameEn: ci } }, { product: { productNameAr: ci } }] }, select: { id: true }, take: 500 }),
    prisma.roastingBatch.findMany({ where: { OR: [{ batchNumber: ci }] }, select: { id: true }, take: 500 }),
  ]);
  return [...beans, ...mats, ...lots, ...batches].map((x) => x.id);
}

/** The movements of an item category: green / roasted / finished by their ledger category, materials by item. */
async function itemCategoryWhere(id: string): Promise<Prisma.InventoryMovementWhereInput> {
  const cats = await prisma.itemCategory.findMany({ where: { OR: [{ id }, { parentId: id }] }, select: { id: true, template: true } });
  const or: Prisma.InventoryMovementWhereInput[] = [];
  if (cats.some((c) => c.template === "GREEN_COFFEE")) or.push({ category: "RAW_MATERIAL" });
  if (cats.some((c) => c.template === "ROASTED_COFFEE")) or.push({ category: "ROASTED_COFFEE" });
  if (cats.some((c) => c.template === "FINISHED")) or.push({ category: "FINISHED_GOODS" });
  const matCats = cats.filter((c) => c.template === "PACKAGING" || c.template === "GENERAL").map((c) => c.id);
  if (matCats.length) {
    const mats = await prisma.materialItem.findMany({ where: { categoryId: { in: matCats } }, select: { id: true } });
    if (mats.length) or.push({ category: "PACKAGING_MATERIAL", referenceEntityId: { in: mats.map((m) => m.id) } });
  }
  return or.length ? { OR: or } : { id: "__none__" };
}

export async function ledgerWhere(f: LedgerFilter): Promise<Prisma.InventoryMovementWhereInput> {
  const and: Prisma.InventoryMovementWhereInput[] = [];
  if (f.type) and.push({ type: f.type });
  if (f.category) and.push({ category: f.category });
  if (f.source) and.push({ sourceDocType: f.source });
  if (f.entityId) and.push({ referenceEntityId: f.entityId });
  if (f.sourceDocId) and.push({ sourceDocId: f.sourceDocId });
  if (f.itemCategoryId) and.push(await itemCategoryWhere(f.itemCategoryId));
  if (f.from) and.push({ timestamp: { gte: f.from } });
  if (f.to) and.push({ timestamp: { lte: f.to } });
  if (f.q) {
    const ids = await matchingEntityIds(f.q);
    and.push({ OR: [{ referenceEntityId: { in: ids } }, { sourceDocId: { in: ids } }, { notes: { contains: f.q, mode: "insensitive" } }] });
  }
  return and.length ? { AND: and } : {};
}

/** Names, codes, the source document's reference and the user, per movement. */
export async function enrichMovements(movements: Movement[]) {
  const ids = (cat: string) => [...new Set(movements.filter((m) => m.category === cat && m.referenceEntityId).map((m) => m.referenceEntityId!))];
  const docIds = [...new Set(movements.map((m) => m.sourceDocId).filter((x): x is string => !!x))];
  const empIds = [...new Set(movements.map((m) => m.userId).filter((x): x is string => !!x))];
  const [beans, lots, mats, batches, docBatches, counts, emps] = await Promise.all([
    ids("RAW_MATERIAL").length ? prisma.greenBean.findMany({ where: { id: { in: ids("RAW_MATERIAL") } }, select: { id: true, beanType: true, beanTypeAr: true, serialNumber: true } }) : [],
    ids("FINISHED_GOODS").length ? prisma.finishedGoodsLot.findMany({ where: { id: { in: ids("FINISHED_GOODS") } }, select: { id: true, batchNumber: true, product: { select: { productNameEn: true, productNameAr: true } }, productSku: { select: { skuCode: true, name: true, nameAr: true } } } }) : [],
    ids("PACKAGING_MATERIAL").length ? prisma.materialItem.findMany({ where: { id: { in: ids("PACKAGING_MATERIAL") } }, select: { id: true, name: true, nameAr: true, code: true, unitOfMeasure: true } }) : [],
    ids("ROASTED_COFFEE").length ? prisma.roastingBatch.findMany({ where: { id: { in: ids("ROASTED_COFFEE") } }, select: { id: true, batchNumber: true, product: { select: { productNameEn: true, productNameAr: true } }, greenBean: { select: { beanType: true, beanTypeAr: true } } } }) : [],
    docIds.length ? prisma.roastingBatch.findMany({ where: { id: { in: docIds } }, select: { id: true, batchNumber: true } }) : [],
    docIds.length ? prisma.inventoryCountSession.findMany({ where: { id: { in: docIds } }, select: { id: true, number: true } }) : [],
    empIds.length ? prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true } }) : [],
  ]);
  const bean = new Map(beans.map((b) => [b.id, b]));
  const lot = new Map(lots.map((l) => [l.id, l]));
  const mat = new Map(mats.map((m) => [m.id, m]));
  const batch = new Map(batches.map((b) => [b.id, b]));
  const docBatch = new Map(docBatches.map((b) => [b.id, b.batchNumber]));
  const count = new Map(counts.map((c) => [c.id, c.number]));
  const emp = new Map(emps.map((e) => [e.id, e.name]));

  return movements.map((m) => {
    let entityLabel: string | null = null, entityLabelAr: string | null = null, entityCode: string | null = null, unit: string | null = null;
    const r = m.referenceEntityId;
    if (r && m.category === "RAW_MATERIAL") { const b = bean.get(r); entityLabel = b?.beanType ?? null; entityLabelAr = b?.beanTypeAr ?? null; entityCode = b?.serialNumber ?? null; unit = "KG"; }
    if (r && m.category === "FINISHED_GOODS") { const l = lot.get(r); entityLabel = l?.productSku?.name ?? l?.product.productNameEn ?? null; entityLabelAr = l?.productSku?.nameAr ?? l?.product.productNameAr ?? null; entityCode = l?.batchNumber ?? null; unit = "KG"; }
    if (r && m.category === "PACKAGING_MATERIAL") { const x = mat.get(r); entityLabel = x?.name ?? null; entityLabelAr = x?.nameAr ?? null; entityCode = x?.code ?? null; unit = x?.unitOfMeasure ?? "PIECE"; }
    if (r && m.category === "ROASTED_COFFEE") { const b = batch.get(r); entityLabel = b?.product?.productNameEn ?? b?.greenBean?.beanType ?? null; entityLabelAr = b?.product?.productNameAr ?? b?.greenBean?.beanTypeAr ?? null; entityCode = b?.batchNumber ?? null; unit = "KG"; }
    const doc = m.sourceDocId;
    const countNumber = doc ? count.get(doc) ?? null : null;
    const sourceRef = doc ? (countNumber !== null ? `#${countNumber}` : docBatch.get(doc) ?? null) : null;
    return { ...m, entityLabel, entityLabelAr, entityCode, unit, sourceRef, countNumber, userName: m.userId ? emp.get(m.userId) ?? null : null };
  });
}

export async function ledgerPage(f: LedgerFilter) {
  const where = await ledgerWhere(f);
  const [total, rows] = await Promise.all([
    prisma.inventoryMovement.count({ where }),
    prisma.inventoryMovement.findMany({ where, orderBy: [{ timestamp: "desc" }, { id: "desc" }], skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
  ]);
  return { total, page: f.page, pageSize: f.pageSize, rows: await enrichMovements(rows) };
}

export async function ledgerExportRows(f: LedgerFilter) {
  const where = await ledgerWhere(f);
  const [total, rows] = await Promise.all([
    prisma.inventoryMovement.count({ where }),
    prisma.inventoryMovement.findMany({ where, orderBy: [{ timestamp: "desc" }, { id: "desc" }], take: LEDGER_EXPORT_MAX }),
  ]);
  return { total, truncated: total > rows.length, rows: await enrichMovements(rows) };
}
