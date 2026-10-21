import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { parseIds } from "@/lib/services/product-catalog";

type Params = { params: Promise<{ id: string }> };

/**
 * «إضافة منتجات» in the category pane: moves the listed products into this category, in one
 * transaction. A product is in one category only, so it leaves its current one. 400 if the
 * category is archived. Stock is untouched (no movement is written).
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireEdit("inventory");
  if (error) return error;
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const ids = parseIds((body as Record<string, unknown>)?.productIds);
  if (!ids.ok) return NextResponse.json({ error: ids.error, field: ids.field }, { status: 400 });
  if (ids.value.length === 0) return NextResponse.json({ error: "Select at least one product.", field: "productIds" }, { status: 400 });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const c = await tx.catalogCategory.findUnique({ where: { id } });
      if (!c) return { status: 404, body: { error: "Category not found." } };
      if (!c.isActive) return { status: 400, body: { error: "This category is archived; restore it before adding products." } };
      const found = await tx.coffeeProduct.count({ where: { id: { in: ids.value } } });
      if (found !== ids.value.length) return { status: 400, body: { error: "One or more products do not exist." } };
      const r = await tx.coffeeProduct.updateMany({ where: { id: { in: ids.value } }, data: { categoryId: id } });
      await tx.catalogCategory.update({ where: { id }, data: { updatedByName: user.name } });
      return { status: 200, body: { categoryId: id, moved: r.count } };
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return handlePrismaError(err);
  }
}
