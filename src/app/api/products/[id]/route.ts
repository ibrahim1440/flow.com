import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import {
  availableUnitsBySku,
  explodeBom,
  skuDisplayName,
  packSizeLabel,
} from "@/lib/services/finished-products";

type Params = { params: Promise<{ id: string }> };

const PRODUCT_CATEGORIES = ["ROASTED_COFFEE", "GREEN_COFFEE", "MERCHANDISE", "OTHER"] as const;
const UNITS_OF_MEASURE = ["UNIT", "KG", "GRAM", "PIECE"] as const;

const isCategory = (v: unknown): v is (typeof PRODUCT_CATEGORIES)[number] =>
  typeof v === "string" && (PRODUCT_CATEGORIES as readonly string[]).includes(v);
const isUom = (v: unknown): v is (typeof UNITS_OF_MEASURE)[number] =>
  typeof v === "string" && (UNITS_OF_MEASURE as readonly string[]).includes(v);

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireAnyModule("inventory", "orders");
  if (error) return error;

  const { id } = await params;

  try {
    const sku = await prisma.productSKU.findUnique({
      where: { id },
      include: {
        product: { select: { id: true, productNameEn: true, productNameAr: true, countryEn: true } },
        bomComponents: {
          include: {
            coffeeProduct: { select: { id: true, productNameEn: true } },
            materialItem: { select: { id: true, code: true, name: true, quantityOnHand: true, unitOfMeasure: true } },
          },
          orderBy: [{ type: "asc" }, { createdAt: "asc" }],
        },
      },
    });
    if (!sku) return NextResponse.json({ error: "Product not found." }, { status: 404 });

    const availability = await availableUnitsBySku(prisma, [sku.id]);
    // Requirement for a single unit — the natural way to show a BOM alongside stock.
    const perUnit = await explodeBom(prisma, sku.id, 1);

    return NextResponse.json({
      id: sku.id,
      skuCode: sku.skuCode,
      name: skuDisplayName(sku),
      nameAr: sku.nameAr,
      rawName: sku.name,
      category: sku.category,
      unitOfMeasure: sku.unitOfMeasure,
      weightGrams: sku.weightGrams,
      packSize: packSizeLabel(sku.weightGrams),
      price: sku.price,
      isBulk: sku.isBulk,
      isActive: sku.isActive,
      coffee: sku.product,
      availableUnits: availability.get(sku.id)?.unitsFree ?? 0,
      reservedUnits: availability.get(sku.id)?.unitsReserved ?? 0,
      bom: sku.bomComponents,
      bomPerUnit: perUnit,
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const { error } = await requireEdit("inventory");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const data: Record<string, unknown> = {};

  if (b.name !== undefined)
    data.name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;
  if (b.nameAr !== undefined)
    data.nameAr = typeof b.nameAr === "string" && b.nameAr.trim() ? b.nameAr.trim() : null;

  if (b.category !== undefined) {
    if (!isCategory(b.category))
      return NextResponse.json(
        { error: `category must be one of: ${PRODUCT_CATEGORIES.join(", ")}.` },
        { status: 400 }
      );
    data.category = b.category;
  }

  if (b.unitOfMeasure !== undefined) {
    if (!isUom(b.unitOfMeasure))
      return NextResponse.json(
        { error: `unitOfMeasure must be one of: ${UNITS_OF_MEASURE.join(", ")}.` },
        { status: 400 }
      );
    data.unitOfMeasure = b.unitOfMeasure;
  }

  if (b.price !== undefined) {
    const price = Number(b.price);
    if (!Number.isFinite(price) || price < 0)
      return NextResponse.json({ error: "price must be a non-negative number." }, { status: 400 });
    data.price = price;
  }

  if (b.isActive !== undefined) data.isActive = b.isActive === true;
  if (b.isBulk !== undefined) data.isBulk = b.isBulk === true;

  if (b.skuCode !== undefined) {
    const skuCode = typeof b.skuCode === "string" ? b.skuCode.trim() : "";
    if (!skuCode) return NextResponse.json({ error: "skuCode cannot be empty." }, { status: 400 });
    data.skuCode = skuCode;
  }

  // weightGrams is deliberately NOT editable here. It is the divisor behind every unit
  // balance already on the shelf and every kg figure derived from one; changing it would
  // silently restate the meaning of existing FinishedGoodsLot.unitsAvailable and
  // OrderItem.quantityKg rows. Retire the SKU and create a new one instead.
  if (b.weightGrams !== undefined) {
    return NextResponse.json(
      {
        error:
          "weightGrams cannot be changed: existing stock and order lines were measured against it. Deactivate this SKU and create a new one.",
      },
      { status: 409 }
    );
  }

  if (Object.keys(data).length === 0)
    return NextResponse.json({ error: "No editable fields supplied." }, { status: 400 });

  try {
    const existing = await prisma.productSKU.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Product not found." }, { status: 404 });

    if (typeof data.skuCode === "string" && data.skuCode !== existing.skuCode) {
      const clash = await prisma.productSKU.findUnique({ where: { skuCode: data.skuCode } });
      if (clash)
        return NextResponse.json({ error: `SKU code "${data.skuCode}" already exists.` }, { status: 409 });
    }

    const sku = await prisma.productSKU.update({
      where: { id },
      data,
      include: { product: { select: { productNameEn: true, productNameAr: true } } },
    });

    return NextResponse.json({
      ...sku,
      name: skuDisplayName(sku),
      packSize: packSizeLabel(sku.weightGrams),
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}

/**
 * Deactivate, never delete.
 *
 * A SKU is referenced by finished-goods lots, order lines and production orders; removing
 * the row would break that traceability, and section 9 of the redesign requires it be
 * kept. Deactivating takes it out of the sales catalog while every historical reference
 * still resolves.
 */
export async function DELETE(_request: Request, { params }: Params) {
  const { error } = await requireEdit("inventory");
  if (error) return error;

  const { id } = await params;

  try {
    const sku = await prisma.productSKU.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });
    if (!sku) return NextResponse.json({ error: "Product not found." }, { status: 404 });

    const updated = await prisma.productSKU.update({
      where: { id },
      data: { isActive: false },
      select: { id: true, skuCode: true, isActive: true },
    });
    return NextResponse.json({ ...updated, deactivated: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
