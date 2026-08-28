import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import {
  availableUnitsBySku,
  skuDisplayName,
  packSizeLabel,
} from "@/lib/services/finished-products";

// Finished Products = ProductSKU. One row is one sellable SKU ("Brazil Coffee – 1 KG").
//
// Gated on the existing `inventory` module rather than a new `products` module on
// purpose: hasModuleAccess returns false for any module key absent from an employee's
// stored permissions JSON, and the live Admin account's JSON predates even `accounting`.
// A new key would have locked every existing user out of the section until someone
// hand-edited permissions. Same precedent as the Preparation workstation, which is a
// section of its own gated on `orders`.

const PRODUCT_CATEGORIES = ["ROASTED_COFFEE", "GREEN_COFFEE", "MERCHANDISE", "OTHER"] as const;
const UNITS_OF_MEASURE = ["UNIT", "KG", "GRAM", "PIECE"] as const;

type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];
type UnitOfMeasure = (typeof UNITS_OF_MEASURE)[number];

const isCategory = (v: unknown): v is ProductCategory =>
  typeof v === "string" && (PRODUCT_CATEGORIES as readonly string[]).includes(v);
const isUom = (v: unknown): v is UnitOfMeasure =>
  typeof v === "string" && (UNITS_OF_MEASURE as readonly string[]).includes(v);

export async function GET(request: Request) {
  // Read access is deliberately wider than write: the sales order screen needs to list
  // sellable products, and sales staff hold `orders`, not `inventory`.
  const { error } = await requireAnyModule("inventory", "orders");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim();
  const activeOnly = searchParams.get("activeOnly") !== "false";

  try {
    const skus = await prisma.productSKU.findMany({
      where: {
        ...(activeOnly ? { isActive: true } : {}),
        ...(q
          ? {
              OR: [
                { skuCode: { contains: q, mode: "insensitive" as const } },
                { name: { contains: q, mode: "insensitive" as const } },
                { nameAr: { contains: q, mode: "insensitive" as const } },
                { product: { productNameEn: { contains: q, mode: "insensitive" as const } } },
                { product: { productNameAr: { contains: q, mode: "insensitive" as const } } },
              ],
            }
          : {}),
      },
      include: {
        product: { select: { id: true, productNameEn: true, productNameAr: true, countryEn: true } },
        _count: { select: { bomComponents: true } },
      },
      orderBy: [{ isActive: "desc" }, { skuCode: "asc" }],
      take: 500,
    });

    const availability = await availableUnitsBySku(
      prisma,
      skus.map((s) => s.id)
    );

    return NextResponse.json(
      skus.map((s) => ({
        id: s.id,
        skuCode: s.skuCode,
        name: skuDisplayName(s),
        nameAr: s.nameAr,
        category: s.category,
        unitOfMeasure: s.unitOfMeasure,
        weightGrams: s.weightGrams,
        packSize: packSizeLabel(s.weightGrams),
        price: s.price,
        isBulk: s.isBulk,
        isActive: s.isActive,
        coffee: s.product,
        bomComponentCount: s._count.bomComponents,
        // A SKU with no BOM can still be sold from existing stock but cannot be produced,
        // so the UI flags it rather than silently failing at production time.
        hasBom: s._count.bomComponents > 0,
        availableUnits: availability.get(s.id)?.unitsFree ?? 0,
        reservedUnits: availability.get(s.id)?.unitsReserved ?? 0,
      }))
    );
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function POST(request: Request) {
  const { error } = await requireEdit("inventory");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;

  if (typeof b.productId !== "string" || !b.productId)
    return NextResponse.json({ error: "productId (coffee / origin) is required." }, { status: 400 });

  const skuCode = typeof b.skuCode === "string" ? b.skuCode.trim() : "";
  if (!skuCode) return NextResponse.json({ error: "skuCode is required." }, { status: 400 });

  const weightGrams = Number(b.weightGrams);
  if (!Number.isFinite(weightGrams) || weightGrams <= 0)
    return NextResponse.json({ error: "weightGrams must be a positive number." }, { status: 400 });

  const price = b.price === undefined || b.price === null ? 0 : Number(b.price);
  if (!Number.isFinite(price) || price < 0)
    return NextResponse.json({ error: "price must be a non-negative number." }, { status: 400 });

  if (b.category !== undefined && !isCategory(b.category))
    return NextResponse.json(
      { error: `category must be one of: ${PRODUCT_CATEGORIES.join(", ")}.` },
      { status: 400 }
    );
  if (b.unitOfMeasure !== undefined && !isUom(b.unitOfMeasure))
    return NextResponse.json(
      { error: `unitOfMeasure must be one of: ${UNITS_OF_MEASURE.join(", ")}.` },
      { status: 400 }
    );

  try {
    const coffee = await prisma.coffeeProduct.findUnique({ where: { id: b.productId } });
    if (!coffee) return NextResponse.json({ error: "Coffee / origin not found." }, { status: 404 });

    const existing = await prisma.productSKU.findUnique({ where: { skuCode } });
    if (existing)
      return NextResponse.json({ error: `SKU code "${skuCode}" already exists.` }, { status: 409 });

    const sku = await prisma.productSKU.create({
      data: {
        productId: b.productId,
        skuCode,
        weightGrams,
        price,
        isBulk: b.isBulk === true,
        name: typeof b.name === "string" && b.name.trim() ? b.name.trim() : null,
        nameAr: typeof b.nameAr === "string" && b.nameAr.trim() ? b.nameAr.trim() : null,
        category: isCategory(b.category) ? b.category : "ROASTED_COFFEE",
        unitOfMeasure: isUom(b.unitOfMeasure) ? b.unitOfMeasure : "UNIT",
        isActive: b.isActive === undefined ? true : b.isActive === true,
      },
      include: { product: { select: { productNameEn: true, productNameAr: true } } },
    });

    return NextResponse.json(
      { ...sku, name: skuDisplayName(sku), packSize: packSizeLabel(sku.weightGrams) },
      { status: 201 }
    );
  } catch (err) {
    return handlePrismaError(err);
  }
}
