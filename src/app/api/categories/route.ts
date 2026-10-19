import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireEdit, requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { availableUnitsBySku } from "@/lib/services/finished-products";
import { parseCategoryInput, parseIds } from "@/lib/services/product-catalog";

// User-defined product categories (Figma 258:3751 «تصنيفات المنتجات», 276:4776 «إضافة تصنيف»;
// CATALOG-BACKEND.md). Gated on the `inventory` module like the rest of the Products section
// (see src/app/api/products/route.ts for why no new module key): view to read, edit to write.

/**
 * Categories in manual order, each with its computed counts (never stored): products, active
 * products, SKUs, free units. `?includeArchived=1` adds the archived ones. `uncategorised`
 * describes «بلا تصنيف», which is a virtual row, not a database record.
 */
export async function GET(request: Request) {
  const { error } = await requireModule("inventory");
  if (error) return error;
  const includeArchived = ["1", "true"].includes(new URL(request.url).searchParams.get("includeArchived") ?? "");

  try {
    const [categories, products] = await Promise.all([
      prisma.catalogCategory.findMany({
        where: includeArchived ? {} : { isActive: true },
        orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { nameAr: "asc" }],
      }),
      prisma.coffeeProduct.findMany({
        select: { id: true, categoryId: true, isActive: true, productSkus: { select: { id: true } } },
      }),
    ]);
    const free = await availableUnitsBySku(prisma, products.flatMap((p) => p.productSkus.map((s) => s.id)));
    type Agg = { productCount: number; activeProductCount: number; skuCount: number; freeUnits: number };
    const by = new Map<string | null, Agg>();
    for (const p of products) {
      const a = by.get(p.categoryId) ?? { productCount: 0, activeProductCount: 0, skuCount: 0, freeUnits: 0 };
      a.productCount += 1;
      if (p.isActive) a.activeProductCount += 1;
      a.skuCount += p.productSkus.length;
      if (p.isActive) for (const s of p.productSkus) a.freeUnits += free.get(s.id)?.unitsFree ?? 0;
      by.set(p.categoryId, a);
    }
    const empty: Agg = { productCount: 0, activeProductCount: 0, skuCount: 0, freeUnits: 0 };
    return NextResponse.json({
      items: categories.map((c) => ({ ...c, ...(by.get(c.id) ?? empty) })),
      uncategorised: by.get(null) ?? empty,
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}

/**
 * Create a category. Any `productIds` are moved into it in the same transaction («المنتجات
 * المحددة تُنقل من تصنيفها الحالي»); moving writes no stock movement. 409 on a duplicate nameAr.
 */
export async function POST(request: Request) {
  const { user, error } = await requireEdit("inventory");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = parseCategoryInput(body, false);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  const rawIds = (body as Record<string, unknown>)?.productIds;
  const ids = rawIds === undefined ? { ok: true as const, value: [] as string[] } : parseIds(rawIds);
  if (!ids.ok) return NextResponse.json({ error: ids.error, field: ids.field }, { status: 400 });

  try {
    const clash = await prisma.catalogCategory.findUnique({ where: { nameAr: parsed.value.nameAr! } });
    if (clash) return NextResponse.json({ error: `A category named «${parsed.value.nameAr}» already exists.`, field: "nameAr" }, { status: 409 });

    const created = await prisma.$transaction(async (tx) => {
      if (ids.value.length) {
        const found = await tx.coffeeProduct.count({ where: { id: { in: ids.value } } });
        if (found !== ids.value.length) throw { _status: 400, message: "One or more products do not exist." };
      }
      const max = await tx.catalogCategory.aggregate({ _max: { sortOrder: true } });
      const c = await tx.catalogCategory.create({
        data: {
          nameAr: parsed.value.nameAr!,
          nameEn: parsed.value.nameEn ?? null,
          description: parsed.value.description ?? null,
          sortOrder: parsed.value.sortOrder ?? (max._max.sortOrder ?? -1) + 1,
          updatedByName: user.name,
        },
      });
      if (ids.value.length) await tx.coffeeProduct.updateMany({ where: { id: { in: ids.value } }, data: { categoryId: c.id } });
      return c;
    });
    return NextResponse.json({ ...created, moved: ids.value.length }, { status: 201 });
  } catch (err) {
    if (err && typeof err === "object" && "_status" in err) {
      const e = err as { _status: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._status });
    }
    return handlePrismaError(err);
  }
}
