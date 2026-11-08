/**
 * «تحميص للمخزون» for the roasting station v2 (owner-approved D14, 8 Nov 2026):
 *  · a coffee's «الدفعة الخضراء الافتراضية» (CoffeeProduct.defaultGreenBeanId) — the green lot prep draws from;
 *  · «أمر تحميص للمخزون» — a ProductionOrder with no order item (sourceOrderItemId null), which V2 prep lists under
 *    «مخزون» (roast-v2.ts prepPlan, the fromStock lines); a PENDING one can be cancelled.
 * Who: production › roast_to_stock, or the admin role. Every change is written to AuthAuditLog (the two tables carry no
 * row audit, and SettingsAuditLog's action list is closed).
 */
import { prisma } from "@/lib/db";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { ipHashOf } from "@/lib/accounting/ops/purchase-activity";
import { nextProductionNumber } from "@/lib/services/production-planning";

export type StockActor = { id: string; name: string; role: string; permissions: Permissions };
export class StockError extends Error {
  constructor(public status: number, public code: string, public ar: string, public en: string) { super(en); }
}
const fail = (status: number, code: string, ar: string, en: string) => new StockError(status, code, ar, en);

export const MAX_STOCK_GREEN_KG = 1000;
export const MIN_STOCK_GREEN_KG = 0.1;

export function canRoastToStock(u: { role: string; permissions: Permissions }): boolean {
  return u.role === "admin" || hasSubPrivilege(u.permissions, "production", "roast_to_stock");
}

/** The green lots a default may point to: active, with stock — newest first. */
export async function stockGreenLots() {
  const rows = await prisma.greenBean.findMany({
    where: { isActive: true, quantityKg: { gt: 0 } },
    orderBy: [{ receivedDate: "desc" }, { serialNumber: "desc" }],
    take: 300,
    select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true, country: true, countryAr: true, quantityKg: true },
  });
  return rows.map((r) => ({ ...r, quantityKg: +r.quantityKg.toFixed(3) }));
}

async function audit(actor: StockActor, action: string, metadata: Record<string, unknown>, tx: Pick<typeof prisma, "authAuditLog"> = prisma) {
  await tx.authAuditLog.create({ data: { userId: actor.id, action, result: "SUCCESS", sourceInterface: "WEB", ipHash: await ipHashOf(null), metadata: JSON.parse(JSON.stringify(metadata)) } });
}

type GreenTx = Pick<typeof prisma, "greenBean" | "authAuditLog">;

/** Why a lot cannot be a default (missing / inactive / empty), or null when it can — shared with product create. */
export async function defaultGreenRefusal(tx: Pick<typeof prisma, "greenBean">, greenBeanId: string): Promise<StockError | null> {
  const b = await tx.greenBean.findUnique({ where: { id: greenBeanId }, select: { isActive: true, quantityKg: true } });
  if (!b) return fail(400, "GREEN_NOT_FOUND", "الدفعة الخضراء غير موجودة.", "Green lot not found.");
  if (!b.isActive || b.quantityKg <= 0) return fail(409, "GREEN_NOT_IN_STOCK", "اختر دفعة خضراء نشطة فيها رصيد.", "Choose an active green lot with stock.");
  return null;
}

/** A product created with a default lot: the same PRODUCT_DEFAULT_GREEN audit row (from null). */
export async function auditDefaultGreenOnCreate(actorId: string, productId: string, greenBeanId: string, tx: GreenTx = prisma) {
  await tx.authAuditLog.create({ data: { userId: actorId, action: "PRODUCT_DEFAULT_GREEN", result: "SUCCESS", sourceInterface: "WEB", ipHash: await ipHashOf(null), metadata: { productId, from: null, to: greenBeanId, via: "product_create" } } });
}

/** «الدفعة الخضراء الافتراضية»: set (an active lot with stock) or clear (null). */
export async function setDefaultGreen(actor: StockActor, productId: string, greenBeanId: string | null) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.coffeeProduct.findUnique({ where: { id: productId }, select: { id: true, defaultGreenBeanId: true } });
    if (!p) throw fail(404, "PRODUCT_NOT_FOUND", "المنتج غير موجود.", "Product not found.");
    if (greenBeanId) {
      const refused = await defaultGreenRefusal(tx, greenBeanId);
      if (refused) throw refused;
    }
    if (p.defaultGreenBeanId === greenBeanId) return { id: p.id, defaultGreenBeanId: greenBeanId, changed: false };
    await tx.coffeeProduct.update({ where: { id: productId }, data: { defaultGreenBeanId: greenBeanId } });
    await audit(actor, "PRODUCT_DEFAULT_GREEN", { productId, from: p.defaultGreenBeanId, to: greenBeanId }, tx);
    return { id: p.id, defaultGreenBeanId: greenBeanId, changed: true };
  });
}

/** The coffees with their active SKUs and default green lot — the dialog's pickers. */
export async function stockProducts() {
  const rows = await prisma.coffeeProduct.findMany({
    where: { isActive: true },
    orderBy: { productNameEn: "asc" },
    select: {
      id: true, productNameAr: true, productNameEn: true, expectedRoastLoss: true, defaultGreenBeanId: true,
      defaultGreenBean: { select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true, quantityKg: true, isActive: true } },
      productSkus: { where: { isActive: true }, orderBy: { weightGrams: "asc" }, select: { id: true, skuCode: true, weightGrams: true, isBulk: true } },
    },
  });
  return rows.filter((r) => r.productSkus.length > 0);
}

/** Open stock orders (no order item), newest first. */
export async function openStockOrders() {
  const rows = await prisma.productionOrder.findMany({
    where: { sourceOrderItemId: null, status: { in: ["PENDING", "IN_PRODUCTION"] } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, productionNumber: true, status: true, expectedGreenBeanKg: true, targetWeightKg: true, targetUnits: true, createdAt: true,
      productSku: { select: { skuCode: true, weightGrams: true, product: { select: { id: true, productNameAr: true, productNameEn: true } } } },
      greenBean: { select: { serialNumber: true } },
    },
  });
  return rows;
}

/**
 * «أمر تحميص للمخزون»: green kg of a coffee's SKU → a PENDING ProductionOrder with no order item. The green lot is the
 * product's default (refused without one: 409 NO_DEFAULT_GREEN); the roasted target is green × (1 − expected loss).
 */
export async function createStockOrder(actor: StockActor, body: { productSkuId?: unknown; greenKg?: unknown }) {
  const skuId = typeof body.productSkuId === "string" ? body.productSkuId : "";
  const greenKg = typeof body.greenKg === "number" ? body.greenKg : Number(body.greenKg);
  if (!skuId) throw fail(400, "SKU_REQUIRED", "اختر صنف البيع.", "Choose the SKU.");
  if (!Number.isFinite(greenKg) || greenKg <= 0) throw fail(400, "GREEN_KG_REQUIRED", "اكتب كمية البن الأخضر بالكيلو.", "Enter the green coffee in kg.");
  if (greenKg > MAX_STOCK_GREEN_KG) throw fail(400, "GREEN_KG_TOO_LARGE", `الحد ${MAX_STOCK_GREEN_KG} كغ أخضر للأمر الواحد.`, `At most ${MAX_STOCK_GREEN_KG} kg of green per order.`);
  const green = +greenKg.toFixed(3);
  if (green < MIN_STOCK_GREEN_KG) throw fail(400, "GREEN_KG_TOO_SMALL", `أقل كمية ${MIN_STOCK_GREEN_KG} كغ أخضر.`, `At least ${MIN_STOCK_GREEN_KG} kg of green.`);
  return prisma.$transaction(async (tx) => {
    const sku = await tx.productSKU.findUnique({
      where: { id: skuId },
      select: { id: true, skuCode: true, weightGrams: true, isBulk: true, product: { select: { id: true, isActive: true, expectedRoastLoss: true, defaultGreenBeanId: true } } },
    });
    if (!sku) throw fail(404, "SKU_NOT_FOUND", "صنف البيع غير موجود.", "SKU not found.");
    if (!sku.product.isActive) throw fail(409, "PRODUCT_INACTIVE", "القهوة موقوفة.", "The coffee is inactive.");
    if (!sku.product.defaultGreenBeanId) throw fail(409, "NO_DEFAULT_GREEN", "ما لهذه القهوة دفعة خضراء افتراضية. حدّدها أولًا.", "This coffee has no default green lot. Set it first.");
    // The default lot may have run out or been retired since it was chosen.
    const lot = await tx.greenBean.findUnique({ where: { id: sku.product.defaultGreenBeanId }, select: { isActive: true, quantityKg: true } });
    if (!lot || !lot.isActive || lot.quantityKg <= 0) throw fail(409, "GREEN_NOT_IN_STOCK", "الدفعة الخضراء الافتراضية نفدت أو أُوقفت. اختر دفعة أخرى.", "The default green lot ran out or was retired. Choose another lot.");
    if (!sku.isBulk && !(sku.weightGrams > 0)) throw fail(409, "SKU_WEIGHT_MISSING", "وزن صنف البيع غير محدد. حدّده في المنتج أولًا.", "The SKU has no weight. Set it on the product first.");
    const loss = Math.min(Math.max(sku.product.expectedRoastLoss ?? 15, 0), 99.9);
    const targetWeightKg = +(green * (1 - loss / 100)).toFixed(3);
    const targetUnits = sku.isBulk ? 1 : Math.max(1, Math.floor((targetWeightKg * 1000) / sku.weightGrams));
    const productionNumber = await nextProductionNumber(tx);
    const po = await tx.productionOrder.create({
      data: { productionNumber, productSkuId: sku.id, targetUnits, targetWeightKg, expectedGreenBeanKg: green, status: "PENDING", sourceOrderItemId: null, greenBeanId: sku.product.defaultGreenBeanId },
    });
    await audit(actor, "STOCK_PO_CREATED", { productionOrderId: po.id, productionNumber, productSkuId: sku.id, greenKg: green, targetWeightKg, greenBeanId: sku.product.defaultGreenBeanId }, tx);
    return po;
  });
}

/** Cancel a stock order that has not started (PENDING, no order item, nothing roasted against it). */
export async function cancelStockOrder(actor: StockActor, id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ProductionOrder" WHERE "id" = ${id} FOR UPDATE`;
    const po = await tx.productionOrder.findUnique({ where: { id }, select: { id: true, productionNumber: true, status: true, sourceOrderItemId: true, _count: { select: { roastingBatches: true, roastLotAllocations: true } } } });
    if (!po) throw fail(404, "PO_NOT_FOUND", "الأمر غير موجود.", "Order not found.");
    if (po.sourceOrderItemId) throw fail(409, "NOT_A_STOCK_ORDER", "هذا أمر لطلب عميل، لا يُلغى من هنا.", "This order belongs to a customer order; it is not cancelled here.");
    if (po.status === "CANCELLED") return { id: po.id, status: po.status, changed: false };
    if (po.status !== "PENDING" || po._count.roastingBatches > 0 || po._count.roastLotAllocations > 0) {
      throw fail(409, "PO_STARTED", "بدأ تحميص هذا الأمر، فلا يُلغى.", "Roasting has started on this order; it cannot be cancelled.");
    }
    const out = await tx.productionOrder.update({ where: { id }, data: { status: "CANCELLED" } });
    await audit(actor, "STOCK_PO_CANCELLED", { productionOrderId: id, productionNumber: po.productionNumber }, tx);
    return { id: out.id, status: out.status, changed: true };
  });
}
