import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit, requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { parseCategoryInput } from "@/lib/services/product-catalog";

type Params = { params: Promise<{ id: string }> };

/** One category with its products (the category pane, Figma 258:3751). */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("inventory");
  if (error) return error;
  const { id } = await params;
  try {
    const c = await prisma.catalogCategory.findUnique({
      where: { id },
      include: {
        products: {
          select: {
            id: true, productNameAr: true, productNameEn: true, isActive: true,
            productSkus: { select: { id: true, skuCode: true }, orderBy: { skuCode: "asc" } },
          },
          orderBy: [{ productNameAr: { sort: "asc", nulls: "last" } }, { productNameEn: "asc" }, { id: "asc" }],
        },
      },
    });
    if (!c) return NextResponse.json({ error: "Category not found." }, { status: 404 });
    return NextResponse.json({
      ...c,
      productCount: c.products.length,
      skuCount: c.products.reduce((s, p) => s + p.productSkus.length, 0),
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}

/** Rename, describe, reorder; `isActive: false` archives (sets archivedAt), `true` restores. */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireEdit("inventory");
  if (error) return error;
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = parseCategoryInput(body, true);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  if (Object.keys(parsed.value).length === 0) return NextResponse.json({ error: "No editable fields supplied." }, { status: 400 });

  try {
    const existing = await prisma.catalogCategory.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Category not found." }, { status: 404 });
    if (parsed.value.nameAr && parsed.value.nameAr !== existing.nameAr) {
      const clash = await prisma.catalogCategory.findUnique({ where: { nameAr: parsed.value.nameAr } });
      if (clash) return NextResponse.json({ error: `A category named «${parsed.value.nameAr}» already exists.`, field: "nameAr" }, { status: 409 });
    }
    const { isActive, ...rest } = parsed.value;
    const updated = await prisma.catalogCategory.update({
      where: { id },
      data: {
        ...rest,
        ...(isActive !== undefined && isActive !== existing.isActive ? { isActive, archivedAt: isActive ? null : new Date() } : {}),
        updatedByName: user.name,
      },
    });
    return NextResponse.json(updated);
  } catch (err) {
    return handlePrismaError(err);
  }
}

/**
 * Hard delete, refused (409 with the count) while any product — active or inactive — is in the
 * category. Archive it instead to take it out of the lists. The FK (ON DELETE RESTRICT) backs this.
 */
export async function DELETE(_request: Request, { params }: Params) {
  const { error } = await requireEdit("inventory");
  if (error) return error;
  const { id } = await params;
  try {
    const c = await prisma.catalogCategory.findUnique({ where: { id }, include: { _count: { select: { products: true } } } });
    if (!c) return NextResponse.json({ error: "Category not found." }, { status: 404 });
    if (c._count.products > 0)
      return NextResponse.json(
        { error: "A category that holds products cannot be deleted. Move its products first, or archive it.", productCount: c._count.products },
        { status: 409 }
      );
    await prisma.catalogCategory.delete({ where: { id } });
    return NextResponse.json({ id, deleted: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
