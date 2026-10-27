import { flushPostings } from "@/lib/accounting/ops/cost-ledger";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth, stockChangeGate } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { applyInventoryAdjustment, normalizeAdjustmentReason } from "@/lib/services/inventory-adjustment";
import { activeLocation } from "@/lib/services/stock-locations";

/**
 * Book a counted adjustment against green coffee.
 *
 * The reason is required — see inventory-adjustment.ts for why a manual adjustment is
 * the one movement that cannot be left unexplained.
 *
 * Privileged stock change (owner decision 4): inventory › adjust, a verified individual, a username +
 * PIN credential and a fresh step-up — admins included (stockChangeGate). Judged before any lookup.
 */
export async function POST(request: Request) {
  const { error, user } = await requireAuth();
  if (error) return error;
  const refused = await stockChangeGate(user, "inventory", "adjust");
  if (refused) return refused;

  const body = await request.json();
  const { entityId, newActualQuantity, notes } = body;

  if (!entityId || newActualQuantity === undefined || newActualQuantity === null) {
    return NextResponse.json(
      { error: "entityId and newActualQuantity are required." },
      { status: 400 }
    );
  }
  // JSON 1e309 parses to Infinity, which passes `< 0` and is stored as the coffee's stock; a
  // string is not a count. The UI sends parseFloat(...), a number.
  if (typeof newActualQuantity !== "number" || !Number.isFinite(newActualQuantity)) {
    return NextResponse.json(
      { error: "newActualQuantity must be a finite number." },
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
      // InventoryMovement.referenceEntityId is an untyped string with no foreign key behind it,
      // so the shared adjustment service locks the GreenBean row (FOR UPDATE) BEFORE it reads the
      // balance and writes the movement: either DELETE /api/green-beans/[id] sees the movement and
      // refuses, or this transaction finds the coffee gone and rolls back. The movement, the new
      // balance and the INVENTORY_ADJUSTED person audit (owner decision, inventory Option A) are
      // written by applyInventoryAdjustment in this transaction — the same code a count session
      // posts through (src/lib/services/inventory-adjustment.ts).
      // Phase 3: a count at one location (body.locationId, active) sets that location's quantity.
      const locationId = body.locationId ? (await activeLocation(tx, body.locationId)).id : null;
      const booked = await applyInventoryAdjustment(tx, user, {
        kind: "GREEN_BEAN",
        entityId,
        target: newActualQuantity,
        reason: explained.reason,
        sourceDocId: null,
        locationId,
      });
      if (booked.noChange) return { noChange: true as const, currentQuantity: booked.previousQuantity };
      const updatedBean = await tx.greenBean.findUniqueOrThrow({ where: { id: entityId } });
      await flushPostings(tx);
      return { noChange: false as const, updatedBean, quantityChanged: booked.quantityChanged };
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
