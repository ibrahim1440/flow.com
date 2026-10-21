import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireAuth, requireModule } from "@/lib/auth-server";
import { canEdit } from "@/lib/auth";
import { handlePrismaError } from "@/lib/api-error";
import { availableUnitsBySku, packSizeLabel } from "@/lib/services/finished-products";
import { parseListQuery, productOrderBy, productWhere } from "@/lib/services/product-catalog";
import { createCatalogProduct } from "@/lib/services/product-catalog-db";

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  // The All Products table (Figma 256:3410): one flat, server-filtered, server-sorted, paginated
  // list. Prices and stock make it a catalog read, so it is the Products section's own gate.
  if (sp.get("view") === "catalog") return catalogList(sp);

  // Widened beyond `labels`: the coffee/origin list is the parent of every finished
  // product, so the Products section (gated on `inventory`) and the order and packaging
  // screens all need to read it. Gated on `labels` alone, the origin dropdown came back
  // empty — and therefore unusable — for anyone without the Labels module.
  const { error } = await requireAnyModule("labels", "inventory", "orders", "production", "packaging");
  if (error) return error;

  const products = await prisma.coffeeProduct.findMany({ orderBy: { productNameEn: "asc" } });
  return NextResponse.json(products);
}

async function catalogList(sp: URLSearchParams) {
  const { error } = await requireModule("inventory");
  if (error) return error;
  const parsed = parseListQuery(sp);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  const { sort, page, pageSize, lang, ...filter } = parsed.value;

  try {
    const where = productWhere(filter);
    // The totals describe the whole filtered result, not the page.
    const all = await prisma.coffeeProduct.findMany({
      where,
      select: { id: true, isActive: true, productSkus: { select: { id: true, isActive: true } } },
    });
    const skuIds = all.flatMap((p) => p.productSkus.map((s) => s.id));
    const [free, produced, items] = await Promise.all([
      availableUnitsBySku(prisma, skuIds),
      prisma.finishedGoodsLot.groupBy({ by: ["productSkuId"], where: { productSkuId: { in: skuIds } }, _count: { _all: true } }),
      prisma.coffeeProduct.findMany({
        where,
        orderBy: productOrderBy(sort, lang),
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          category: { select: { id: true, nameAr: true, nameEn: true, isActive: true } },
          productSkus: {
            select: { id: true, skuCode: true, weightGrams: true, price: true, isActive: true, barcode: true },
            orderBy: [{ weightGrams: "asc" }, { skuCode: "asc" }],
          },
        },
      }),
    ]);
    const everProduced = new Set(produced.map((g) => g.productSkuId));
    const freeOf = (ids: string[]) => ids.reduce((s, id) => s + (free.get(id)?.unitsFree ?? 0), 0);

    return NextResponse.json({
      items: items.map((p) => {
        const prices = p.productSkus.map((s) => s.price);
        const ids = p.productSkus.map((s) => s.id);
        return {
          id: p.id,
          productNameAr: p.productNameAr,
          productNameEn: p.productNameEn,
          countryEn: p.countryEn, countryAr: p.countryAr,
          regionEn: p.regionEn, regionAr: p.regionAr,
          processEn: p.processEn, processAr: p.processAr,
          isActive: p.isActive,
          category: p.category,
          updatedAt: p.updatedAt,
          skus: p.productSkus.map((s) => ({ ...s, packSize: packSizeLabel(s.weightGrams) })),
          priceMin: prices.length ? Math.min(...prices) : null,
          priceMax: prices.length ? Math.max(...prices) : null,
          freeUnits: freeOf(ids),
          // «لم يُنتج بعد» (no finished lot ever) versus «لا مخزون» (made before, none free now).
          everProduced: ids.some((id) => everProduced.has(id)),
        };
      }),
      total: all.length,
      page,
      pageSize,
      totals: {
        skuCount: skuIds.length,
        activeProductCount: all.filter((p) => p.isActive).length,
        freeUnits: freeOf(skuIds),
      },
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}

function nullify(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

export async function POST(request: Request) {
  // Creating an origin is a catalog action, so edit rights on EITHER the Labels module
  // (where it used to live) or Inventory (which gates the Products section that now
  // offers it) are accepted. Deliberately not widened to read-only modules.
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canEdit(user.permissions, "labels") && !canEdit(user.permissions, "inventory")) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  try {
    const body = await request.json();

    // The one-page Add Product form (Figma 260:4107): the product, its SKUs (code, pack size,
    // price, barcode, active) and each SKU's BOM in ONE transaction, so the form never leaves a
    // half-created product. Writing SKUs and BOMs is the Products section's edit right.
    if (body && Array.isArray(body.skus)) {
      if (!canEdit(user.permissions, "inventory"))
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      return createCatalogProduct(body);
    }

    if (!body.productNameEn || typeof body.productNameEn !== "string" || !body.productNameEn.trim())
      return NextResponse.json({ error: "productNameEn is required." }, { status: 400 });
    if (!body.countryEn || typeof body.countryEn !== "string" || !body.countryEn.trim())
      return NextResponse.json({ error: "countryEn is required." }, { status: 400 });

    let expectedRoastLoss: number | undefined;
    if (body.expectedRoastLoss !== undefined && body.expectedRoastLoss !== null && body.expectedRoastLoss !== "") {
      expectedRoastLoss = Number(body.expectedRoastLoss);
      if (!Number.isFinite(expectedRoastLoss) || expectedRoastLoss < 0 || expectedRoastLoss > 50)
        return NextResponse.json({ error: "expectedRoastLoss must be a number between 0 and 50." }, { status: 400 });
    }

    if (body.defaultGreenBeanId) {
      const bean = await prisma.greenBean.findUnique({ where: { id: body.defaultGreenBeanId } });
      if (!bean)
        return NextResponse.json({ error: "Default green bean not found." }, { status: 400 });
    }

    const product = await prisma.coffeeProduct.create({
      data: {
        productNameEn:     body.productNameEn.trim(),
        countryEn:         body.countryEn.trim(),
        productNameAr:     nullify(body.productNameAr),
        countryAr:         nullify(body.countryAr),
        regionEn:          nullify(body.regionEn),
        regionAr:          nullify(body.regionAr),
        varietyEn:         nullify(body.varietyEn),
        varietyAr:         nullify(body.varietyAr),
        processEn:         nullify(body.processEn),
        processAr:         nullify(body.processAr),
        altitude:          nullify(body.altitude),
        cupNotesEn:        nullify(body.cupNotesEn),
        cupNotesAr:        nullify(body.cupNotesAr),
        roastPathEn:       nullify(body.roastPathEn),
        roastPathAr:       nullify(body.roastPathAr),
        defaultGreenBeanId: (typeof body.defaultGreenBeanId === "string" && body.defaultGreenBeanId) ? body.defaultGreenBeanId : null,
        ...(expectedRoastLoss !== undefined ? { expectedRoastLoss } : {}),
      },
    });
    return NextResponse.json(product, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
