// Product catalog — the writes that touch several rows at once (one transaction each).
// Validation lives in ./product-catalog (database-free, unit-tested); this file only checks the
// references the database holds and writes.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import type { Prisma } from "@/generated/prisma/client";
import { parseProductFields, parseSkus, productData, type ProductListFilter } from "./product-catalog";

type Tx = Prisma.TransactionClient;

/** A refusal raised inside a transaction (rolls it back), turned into its response by `respond`. */
class Refusal {
  constructor(public status: number, public body: Record<string, unknown>) {}
}

function respond(err: unknown): NextResponse {
  if (err instanceof Refusal) return NextResponse.json(err.body, { status: err.status });
  return handlePrismaError(err);
}

/**
 * The category a product may be put in: it must exist and not be archived (archived categories
 * keep the products already in them, but take no new ones). null = «بلا تصنيف».
 */
export async function assertAssignableCategory(tx: Tx, categoryId: string | null | undefined): Promise<void> {
  if (!categoryId) return;
  const c = await tx.catalogCategory.findUnique({ where: { id: categoryId }, select: { isActive: true } });
  if (!c) throw new Refusal(400, { error: "Category not found.", field: "categoryId" });
  if (!c.isActive) throw new Refusal(400, { error: "This category is archived; choose an active one.", field: "categoryId" });
}

/** Barcodes already held by another SKU → 409 naming the owner («مستخدم للصنف GUJ-1KG»). */
async function assertBarcodesFree(tx: Tx, barcodes: string[], exceptSkuId?: string): Promise<void> {
  if (barcodes.length === 0) return;
  const owner = await tx.productSKU.findFirst({
    where: { barcode: { in: barcodes }, ...(exceptSkuId ? { id: { not: exceptSkuId } } : {}) },
    select: { skuCode: true, barcode: true },
  });
  if (owner)
    throw new Refusal(409, { error: `Barcode ${owner.barcode} is already used by SKU ${owner.skuCode}.`, field: "barcode", skuCode: owner.skuCode });
}

export async function assertBarcodeFree(barcode: string | null, exceptSkuId?: string): Promise<NextResponse | null> {
  if (!barcode) return null;
  try {
    await assertBarcodesFree(prisma, [barcode], exceptSkuId);
    return null;
  } catch (err) {
    return respond(err);
  }
}

/**
 * POST /api/coffee-products with `skus[]` (the Add Product page). Creates the product, every SKU
 * and every SKU's BOM, or nothing. A ROASTED_COFFEE BOM line without a coffeeProductId means «this
 * product» (the one being created: «بن محمص · هذا المنتج»).
 */
export async function createCatalogProduct(body: Record<string, unknown>): Promise<NextResponse> {
  const fields = parseProductFields(body, false);
  if (!fields.ok) return NextResponse.json({ error: fields.error, field: fields.field }, { status: 400 });
  const skus = parseSkus(body.skus);
  if (!skus.ok) return NextResponse.json({ error: skus.error, field: skus.field }, { status: 400 });

  try {
    const product = await prisma.$transaction(async (tx) => {
      await assertAssignableCategory(tx, fields.value.categoryId);
      if (fields.value.defaultGreenBeanId) {
        const bean = await tx.greenBean.findUnique({ where: { id: fields.value.defaultGreenBeanId }, select: { id: true } });
        if (!bean) throw new Refusal(400, { error: "Default green bean not found.", field: "defaultGreenBeanId" });
      }
      const codes = skus.value.map((s) => s.skuCode);
      const taken = await tx.productSKU.findFirst({ where: { skuCode: { in: codes } }, select: { skuCode: true } });
      if (taken) throw new Refusal(409, { error: `SKU code "${taken.skuCode}" already exists.`, field: "skuCode", skuCode: taken.skuCode });
      await assertBarcodesFree(tx, skus.value.flatMap((s) => (s.barcode ? [s.barcode] : [])));

      const coffeeIds = [...new Set(skus.value.flatMap((s) => s.bom.flatMap((l) => (l.coffeeProductId ? [l.coffeeProductId] : []))))];
      if (coffeeIds.length && (await tx.coffeeProduct.count({ where: { id: { in: coffeeIds } } })) !== coffeeIds.length)
        throw new Refusal(400, { error: "One or more coffee products in the components do not exist.", field: "bom" });
      const materialIds = [...new Set(skus.value.flatMap((s) => s.bom.flatMap((l) => (l.materialItemId ? [l.materialItemId] : []))))];
      if (materialIds.length && (await tx.materialItem.count({ where: { id: { in: materialIds } } })) !== materialIds.length)
        throw new Refusal(400, { error: "One or more packaging materials do not exist.", field: "bom" });

      const created = await tx.coffeeProduct.create({
        data: { ...(productData(fields.value) as Prisma.CoffeeProductUncheckedCreateInput) },
      });
      for (const s of skus.value) {
        await tx.productSKU.create({
          data: {
            productId: created.id,
            skuCode: s.skuCode,
            weightGrams: s.weightGrams,
            price: s.price,
            barcode: s.barcode,
            isActive: s.isActive,
            bomComponents: {
              create: s.bom.map((l) => ({
                type: l.type,
                coffeeProductId: l.type === "ROASTED_COFFEE" ? l.coffeeProductId ?? created.id : null,
                materialItemId: l.materialItemId,
                quantityPerUnit: l.quantityPerUnit,
                unitOfMeasure: l.unitOfMeasure,
              })),
            },
          },
        });
      }
      return tx.coffeeProduct.findUniqueOrThrow({
        where: { id: created.id },
        include: { category: true, productSkus: { include: { bomComponents: true }, orderBy: { weightGrams: "asc" } } },
      });
    });
    return NextResponse.json(product, { status: 201 });
  } catch (err) {
    return respond(err);
  }
}

/** PATCH /api/coffee-products/[id]: edit, single «نقل», activate / deactivate. */
export async function updateCatalogProduct(id: string, body: Record<string, unknown>): Promise<NextResponse> {
  const fields = parseProductFields(body, true);
  if (!fields.ok) return NextResponse.json({ error: fields.error, field: fields.field }, { status: 400 });
  if (Object.keys(fields.value).length === 0) return NextResponse.json({ error: "No editable fields supplied." }, { status: 400 });
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.coffeeProduct.findUnique({ where: { id }, select: { categoryId: true } });
      if (!existing) throw new Refusal(404, { error: "Product not found." });
      // Keeping the archived category a product is already in is not an assignment.
      if (fields.value.categoryId !== undefined && fields.value.categoryId !== existing.categoryId)
        await assertAssignableCategory(tx, fields.value.categoryId);
      if (fields.value.defaultGreenBeanId) {
        const bean = await tx.greenBean.findUnique({ where: { id: fields.value.defaultGreenBeanId }, select: { id: true } });
        if (!bean) throw new Refusal(400, { error: "Default green bean not found.", field: "defaultGreenBeanId" });
      }
      return tx.coffeeProduct.update({ where: { id }, data: productData(fields.value), include: { category: true } });
    });
    return NextResponse.json(updated);
  } catch (err) {
    return respond(err);
  }
}

export type Selection = { ids: string[] } | { filter: ProductListFilter; excludeIds: string[] };

/**
 * Bulk «نقل إلى تصنيف» / «تفعيل» in ONE transaction. A list of ids must all exist (else nothing
 * changes); the filter form applies to everything the filter matches. Returns per-item results.
 */
export async function bulkUpdate(
  where: Prisma.CoffeeProductWhereInput,
  sel: Selection,
  data: { categoryId: string | null } | { isActive: boolean },
): Promise<NextResponse> {
  try {
    const out = await prisma.$transaction(async (tx) => {
      if ("categoryId" in data) await assertAssignableCategory(tx, data.categoryId);
      const rows = await tx.coffeeProduct.findMany({ where, select: { id: true, categoryId: true, isActive: true } });
      if ("ids" in sel && rows.length !== sel.ids.length) {
        const have = new Set(rows.map((r) => r.id));
        throw new Refusal(400, { error: "One or more products do not exist.", skipped: sel.ids.filter((i) => !have.has(i)).map((i) => ({ id: i, reason: "not_found" })) });
      }
      const already = rows.filter((r) => ("categoryId" in data ? r.categoryId === data.categoryId : r.isActive === data.isActive));
      const change = rows.filter((r) => !already.includes(r)).map((r) => r.id);
      if (change.length) await tx.coffeeProduct.updateMany({ where: { id: { in: change } }, data });
      return {
        updated: change.length,
        ids: change,
        skipped: already.map((r) => ({ id: r.id, reason: "unchanged" })),
      };
    });
    return NextResponse.json(out);
  } catch (err) {
    return respond(err);
  }
}
