import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireEdit, stockChangeGate } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { applyInventoryAdjustment, normalizeAdjustmentReason } from "@/lib/services/inventory-adjustment";

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

  // A counted adjustment changes the on-hand quantity and writes an ADJUSTMENT movement: it is an
  // inventory adjustment (orchestrator ruling within the owner's Option A, SOD.md §20), so it needs
  // inventory › adjust, a verified individual and a recent step-up. Judged before any lookup.
  // Editing the material's name, category, reorder point or notes stays on inventory edit access.
  // Owner decision 4: also a username + PIN credential and a fresh step-up, admins included.
  if (adjusting) {
    const refused = await stockChangeGate(user, "inventory", "adjust");
    if (refused) return refused;
  }

  if (!adjusting && Object.keys(data).length === 0)
    return NextResponse.json({ error: "No editable fields supplied." }, { status: 400 });

  // Counting packaging material is the same act as counting coffee, and carries the same
  // obligation. Only when a quantity is actually being booked: editing a material's name
  // is not an adjustment and needs no justification.
  // The count's reason is `reason`. Older clients sent it as `notes`; that is still accepted as the
  // reason, but then it is NOT also written over the material's own notes (review P3-4).
  const reasonFromNotes = adjusting && b.reason === undefined;
  const explained = adjusting ? normalizeAdjustmentReason(reasonFromNotes ? b.notes : b.reason) : null;
  if (explained && !explained.ok)
    return NextResponse.json({ error: explained.message }, { status: 400 });
  if (reasonFromNotes) delete data.notes;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Re-review P3-A: lock the row before reading the balance. A receipt (POST …/receive) or a
      // packaging draw committing between the read and the write would otherwise vanish inside the
      // count, and the audited delta would be wrong. Every writer of quantityOnHand serialises on
      // this row lock (receive and count take it explicitly; packaging draws update atomically).
      const locked = await tx.$queryRaw<{ id: string; quantityOnHand: number; unitOfMeasure: string }[]>`
        SELECT "id", "quantityOnHand", "unitOfMeasure"::text AS "unitOfMeasure" FROM "MaterialItem" WHERE "id" = ${id} FOR UPDATE`;
      const item = locked[0];
      if (!item) throw { _appCode: 404, message: "Material not found." };

      if (adjusting) {
        // The shared adjustment service (src/lib/services/inventory-adjustment.ts) — the same code a
        // count session posts through: it re-takes this row lock, books the ADJUSTMENT movement
        // (0.001 no-op threshold, matching the green-bean adjust route), sets quantityOnHand and
        // writes the INVENTORY_ADJUSTED person audit, all in this transaction.
        await applyInventoryAdjustment(tx, user, {
          kind: "MATERIAL",
          entityId: id,
          target: newActualQuantity,
          reason: explained && explained.ok ? explained.reason : "",
          sourceDocId: null,
        });
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
