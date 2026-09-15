import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { normalizeAdjustmentReason } from "@/lib/services/inventory-adjustment";

/**
 * Book a counted adjustment against green coffee.
 *
 * The reason is required — see inventory-adjustment.ts for why a manual adjustment is
 * the one movement that cannot be left unexplained.
 */
export async function POST(request: Request) {
  const { error, user } = await requireSub("inventory", "adjust");
  if (error) return error;

  const body = await request.json();
  const { entityId, newActualQuantity, notes } = body;

  if (!entityId || newActualQuantity === undefined || newActualQuantity === null) {
    return NextResponse.json(
      { error: "entityId and newActualQuantity are required." },
      { status: 400 }
    );
  }
  if (newActualQuantity < 0) {
    return NextResponse.json(
      { error: "newActualQuantity cannot be negative." },
      { status: 400 }
    );
  }

  const explained = normalizeAdjustmentReason(notes);
  if (!explained.ok) {
    return NextResponse.json({ error: explained.message }, { status: 400 });
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // ── Serialise against a concurrent delete of this coffee ────────────────
      // InventoryMovement.referenceEntityId is an untyped string
      // with no foreign key behind it, so inserting one takes no lock on the coffee it
      // names, and the database will not stop it naming one that is being deleted. Reading
      // the row first proves only that it existed a moment ago.
      //
      // Locking it is what makes the guard in DELETE /api/green-beans/[id] mean anything: that
      // route locks this same row, counts the references, and refuses if any exist. Taking the
      // lock BEFORE the loose rows are written puts the two transactions in a queue — either
      // the delete sees these rows and refuses, or this transaction finds the coffee gone and
      // rolls back. Without it the delete can count zero, commit, and leave a
      // ledger entry describing a correction to a coffee that no longer exists.
      //
      // FOR UPDATE rather than FOR KEY SHARE because this transaction goes on to update the
      // row anyway; it is the same lock, taken earlier, and it introduces no new ordering —
      // GreenBean is still the first thing this transaction acquires.
      const locked = await tx.$queryRaw<{ id: string; quantityKg: number }[]>`
        SELECT "id", "quantityKg" FROM "GreenBean" WHERE "id" = ${entityId} FOR UPDATE`;
      const bean = locked[0];
      if (!bean) throw { _appCode: 404, message: "Green bean not found." };

      const previousQuantity = bean.quantityKg;
      const quantityChanged = +( newActualQuantity - previousQuantity).toFixed(4);

      // No-op: floating-point safe threshold of 1g
      if (Math.abs(quantityChanged) < 0.001) {
        return { noChange: true as const, currentQuantity: previousQuantity };
      }

      await tx.inventoryMovement.create({
        data: {
          type: "ADJUSTMENT",
          category: "RAW_MATERIAL",
          referenceEntityId: entityId,
          quantityChanged,
          previousQuantity,
          newQuantity: newActualQuantity,
          sourceDocType: "MANUAL_ADJUSTMENT",
          sourceDocId: null,
          userId: user.id,
          notes: explained.reason,
        },
      });

      const updatedBean = await tx.greenBean.update({
        where: { id: entityId },
        data: { quantityKg: newActualQuantity },
      });

      return { noChange: false as const, updatedBean, quantityChanged };
    });

    if (outcome.noChange) {
      return NextResponse.json({
        message: "No change recorded. Quantity already matches the system value.",
        currentQuantity: outcome.currentQuantity,
      });
    }

    return NextResponse.json(outcome, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
