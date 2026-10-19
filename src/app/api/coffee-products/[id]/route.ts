import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireEdit, requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import {
  PACKABLE_BATCH_STATUSES,
  availableUnitsBySku,
  explodeBom,
  packSizeLabel,
  partialPackagesBySku,
} from "@/lib/services/finished-products";
import { updateCatalogProduct } from "@/lib/services/product-catalog-db";

type Params = { params: Promise<{ id: string }> };

/**
 * The product page (Figma 262:4570): the product, its category, every SKU with its barcode and
 * stock (free / reserved / available, read from FinishedGoodsLot — never stored here), each SKU's
 * components for one unit with the stock they draw on, and the product's metric strip.
 */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("inventory");
  if (error) return error;
  const { id } = await params;

  try {
    const p = await prisma.coffeeProduct.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, nameAr: true, nameEn: true, isActive: true } },
        defaultGreenBean: { select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true } },
        productSkus: {
          orderBy: [{ weightGrams: "desc" }, { skuCode: "asc" }],
          include: { _count: { select: { bomComponents: true } } },
        },
      },
    });
    if (!p) return NextResponse.json({ error: "Product not found." }, { status: 404 });

    const skuIds = p.productSkus.map((s) => s.id);
    const [avail, partials, lots, roasted, awaitingQc, reservations, boms] = await Promise.all([
      availableUnitsBySku(prisma, skuIds),
      partialPackagesBySku(prisma, skuIds),
      prisma.finishedGoodsLot.count({ where: { productSkuId: { in: skuIds }, isUnitTracked: true, status: "AVAILABLE", unitsAvailable: { gt: 0 } } }),
      prisma.roastingBatch.aggregate({
        where: { productId: id, status: { in: [...PACKABLE_BATCH_STATUSES] }, roastedAvailableKg: { gt: 0 } },
        _sum: { roastedAvailableKg: true },
      }),
      prisma.roastingBatch.aggregate({ where: { productId: id, status: "Pending QC" }, _sum: { roastedBeanQuantity: true } }),
      prisma.stockAllocation.findMany({
        where: { status: "RESERVED", finishedGoodsLot: { productSkuId: { in: skuIds }, isUnitTracked: true } },
        select: { orderItem: { select: { order: { select: { id: true, orderNumber: true } } } } },
      }),
      Promise.all(skuIds.map((sid) => explodeBom(prisma, sid, 1))),
    ]);
    const orders = new Map<string, number>();
    for (const r of reservations) orders.set(r.orderItem.order.id, r.orderItem.order.orderNumber);

    const skus = p.productSkus.map((s, i) => {
      const a = avail.get(s.id) ?? { unitsAvailable: 0, unitsReserved: 0, unitsFree: 0 };
      return {
        id: s.id,
        skuCode: s.skuCode,
        name: s.name,
        nameAr: s.nameAr,
        barcode: s.barcode,
        weightGrams: s.weightGrams,
        packSize: packSizeLabel(s.weightGrams),
        price: s.price,
        isActive: s.isActive,
        availableUnits: a.unitsAvailable,
        reservedUnits: a.unitsReserved,
        freeUnits: a.unitsFree,
        // Real stock that is NOT free to promise: shown beside the free figure, never added to it.
        partialPackages: partials.get(s.id)?.packages ?? 0,
        partialGrams: partials.get(s.id)?.grams ?? 0,
        bomComponentCount: s._count.bomComponents,
        bomPerUnit: boms[i],
      };
    });

    const { productSkus: _skus, ...product } = p;
    void _skus;
    return NextResponse.json({
      ...product,
      skus,
      metrics: {
        skuCount: skus.length,
        activeSkuCount: skus.filter((s) => s.isActive).length,
        freeUnits: skus.reduce((t, s) => t + s.freeUnits, 0),
        availableUnits: skus.reduce((t, s) => t + s.availableUnits, 0),
        reservedUnits: skus.reduce((t, s) => t + s.reservedUnits, 0),
        reservedOrders: [...orders.values()].sort((a, b) => a - b),
        lotCount: lots,
        roastedUnpackedKg: Number((roasted._sum.roastedAvailableKg ?? 0).toFixed(3)),
        awaitingQcKg: Number((awaitingQc._sum.roastedBeanQuantity ?? 0).toFixed(3)),
      },
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}

/**
 * Edit the product: names, origin fields, roast loss, default green bean, `categoryId` (single
 * «نقل»; null = «بلا تصنيف») and `isActive` (an inactive product leaves the new-order pickers;
 * existing orders are untouched). The Arabic name, once set, cannot be cleared (D3).
 */
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
  return updateCatalogProduct(id, (body ?? {}) as Record<string, unknown>);
}
