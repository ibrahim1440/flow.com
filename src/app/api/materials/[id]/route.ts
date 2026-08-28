import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

const MATERIAL_CATEGORIES = ["PACKAGING", "LABEL", "CONSUMABLE", "OTHER"] as const;
const isCategory = (v: unknown): v is (typeof MATERIAL_CATEGORIES)[number] =>
  typeof v === "string" && (MATERIAL_CATEGORIES as readonly string[]).includes(v);

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireAnyModule("inventory", "packaging", "production");
  if (error) return error;

  const { id } = await params;
  try {
    const item = await prisma.materialItem.findUnique({
      where: { id },
      include: {
        bomComponents: {
          include: { productSku: { select: { id: true, skuCode: true, name: true } } },
        },
      },
    });
    if (!item) return NextResponse.json({ error: "Material not found." }, { status: 404 });
    return NextResponse.json(item);
  } catch (err) {
    return handlePrismaError(err);
  }
}

/**
 * Edit a material.
 *
 * `quantityOnHand` is NOT settable here. Stock is a balance, and a balance moves through
 * the inventory ledger so the change is attributable and reversible — the same rule the
 * green-bean adjust route follows. Use PATCH with `newActualQuantity` to book a counted
 * adjustment; it writes an InventoryMovement and then moves the balance.
 */
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
  const b = (body ?? {}) as Record<string, unknown>;

  if (b.quantityOnHand !== undefined)
    return NextResponse.json(
      {
        error:
          "quantityOnHand cannot be set directly. Send newActualQuantity to book a counted adjustment through the inventory ledger.",
      },
      { status: 400 }
    );

  const data: Record<string, unknown> = {};
  if (b.name !== undefined) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name cannot be empty." }, { status: 400 });
    data.name = name;
  }
  if (b.nameAr !== undefined)
    data.nameAr = typeof b.nameAr === "string" && b.nameAr.trim() ? b.nameAr.trim() : null;
  if (b.notes !== undefined)
    data.notes = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null;
  if (b.isActive !== undefined) data.isActive = b.isActive === true;
  if (b.category !== undefined) {
    if (!isCategory(b.category))
      return NextResponse.json(
        { error: `category must be one of: ${MATERIAL_CATEGORIES.join(", ")}.` },
        { status: 400 }
      );
    data.category = b.category;
  }
  if (b.reorderPoint !== undefined) {
    const rp = Number(b.reorderPoint);
    if (!Number.isFinite(rp) || rp < 0)
      return NextResponse.json({ error: "reorderPoint must be zero or more." }, { status: 400 });
    data.reorderPoint = rp;
  }

  const adjusting = b.newActualQuantity !== undefined;
  let newActualQuantity = 0;
  if (adjusting) {
    newActualQuantity = Number(b.newActualQuantity);
    if (!Number.isFinite(newActualQuantity) || newActualQuantity < 0)
      return NextResponse.json(
        { error: "newActualQuantity must be zero or more." },
        { status: 400 }
      );
  }

  if (!adjusting && Object.keys(data).length === 0)
    return NextResponse.json({ error: "No editable fields supplied." }, { status: 400 });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.materialItem.findUnique({
        where: { id },
        select: { id: true, quantityOnHand: true },
      });
      if (!item) throw { _appCode: 404, message: "Material not found." };

      if (adjusting) {
        const previousQuantity = item.quantityOnHand;
        const quantityChanged = Number((newActualQuantity - previousQuantity).toFixed(4));

        // 0.001 no-op threshold, matching the green-bean adjust route.
        if (Math.abs(quantityChanged) >= 0.001) {
          await tx.inventoryMovement.create({
            data: {
              type: "ADJUSTMENT",
              category: "PACKAGING_MATERIAL",
              referenceEntityId: id,
              quantityChanged,
              previousQuantity,
              newQuantity: newActualQuantity,
              sourceDocType: "MANUAL_ADJUSTMENT",
              sourceDocId: null,
              userId: user.id,
              notes: typeof b.notes === "string" ? b.notes.trim() || null : null,
            },
          });
          data.quantityOnHand = newActualQuantity;
        }
      }

      return tx.materialItem.update({ where: { id }, data });
    });

    return NextResponse.json(result);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
