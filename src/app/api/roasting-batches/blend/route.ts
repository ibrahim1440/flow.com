import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";
import {
  normalizeBlendSources,
  lockBlendSources,
  validateBlendSources,
  consumeBlendSources,
  recordBlendMovements,
} from "@/lib/services/blend-transformation";

/**
 * Blend several roasted batches into one.
 *
 * This layer does authorization, request shape, transaction orchestration and error mapping.
 * What a blend MEANS lives in blend-transformation.ts, because the previous version had all
 * of it inline and got the central fact wrong: it never moved any coffee. Sources kept their
 * roastedAvailableKg and the output was created without one, so the same kilograms were
 * counted in two places and the blend itself could never be packed.
 *
 * Accepts either request shape. `batchIds` blends whole batches, which is what the production
 * screen sends; `sources: [{ batchId, quantityKg }]` takes a stated amount from each. Both
 * normalise to the same plan.
 */
export async function POST(request: Request) {
  const { error, user } = await requireSub("production", "blend");
  if (error) return error;

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { body = {}; }
  const orderItemId =
    typeof body.orderItemId === "string" && body.orderItemId ? body.orderItemId : null;

  try {
    const requested = normalizeBlendSources(body);

    const result = await prisma.$transaction(async (tx) => {
      // ── 1. Every source, locked, in one canonical order ────────────────────
      // Ordered by id inside the query, not by the order the operator ticked boxes in. Two
      // blends sharing sources therefore queue behind each other instead of each holding
      // what the other is waiting for.
      const locked = await lockBlendSources(tx, requested.map((r) => r.batchId));

      // ── 2. What may be taken, decided from the locked balances ─────────────
      const { plan, totalKg, commonStatus } = validateBlendSources(requested, locked);

      if (!isValidTransition(commonStatus, "Blended")) {
        throw {
          _appCode: 400,
          message: `Cannot blend batches with status "${commonStatus}". Only "Pending QC" or "Passed" batches can be blended.`,
        };
      }
      const blendTiming = commonStatus === "Pending QC" ? "Before QC" : "After QC";

      // ── 3. Whose coffee the blend is ───────────────────────────────────────
      // Derived from the sources, never supplied. The earlier version let a caller pass
      // orderItemId and then skipped both ambiguity guards and used it directly, which meant
      // a request could CREATE ownership the records did not support — attaching a blend of
      // two different customers' coffee, or of stock coffee, to whichever order the caller
      // named. A client may assert who owns this coffee; it may not decide.
      //
      // Ownership is proven only when every single source is owned and they all name the same
      // line. Anything else is ambiguous, and ambiguity is refused rather than resolved:
      // attaching the blend to one of the candidates would claim another order's coffee, and
      // attaching it to none would quietly orphan production that an order is still waiting
      // for. Neither is a choice this route can make on the operator's behalf.
      const ownedInputs = locked.filter((b) => b.orderItemId !== null);
      const distinctOwners = [...new Set(ownedInputs.map((b) => b.orderItemId as string))];

      const provenOwnerId: string | null =
        ownedInputs.length === locked.length && distinctOwners.length === 1
          ? distinctOwners[0]
          : null;

      if (provenOwnerId === null && ownedInputs.length > 0) {
        throw {
          _appCode: 409,
          message:
            ownedInputs.length !== locked.length
              ? "These batches belong to different owners — some to an order, some to stock — so the blend cannot be attributed to either. Blend coffee belonging to the same order, or blend stock coffee on its own."
              : "These batches belong to different order items, so the blend cannot be attributed to one of them. Blend coffee belonging to the same order line.",
        };
      }

      // A supplied orderItemId is checked against what the records prove, and nothing more.
      if (orderItemId !== null && orderItemId !== provenOwnerId) {
        throw {
          _appCode: 409,
          message:
            provenOwnerId === null
              ? "These batches do not belong to that order, so this blend cannot be recorded against it."
              : "The order sent with this request is not the order these batches belong to.",
        };
      }

      const targetOrderItemId: string | null = provenOwnerId;

      // A stock blend must name the coffee it is, for the same reason a stock roast must:
      // packaging has no order line to inherit an identity from, and R2.3's resolver
      // deliberately does not walk BlendIngredient to work one out. Inherited only when every
      // input agrees — never from "the first source".
      const distinctProducts = [
        ...new Set(locked.map((b) => b.productId).filter((id): id is string => id !== null)),
      ];
      const blendProductId = distinctProducts.length === 1 ? distinctProducts[0] : null;
      if (targetOrderItemId === null && blendProductId === null) {
        throw {
          _appCode: 400,
          message:
            "A stock blend must resolve to a single product. Blend batches of the same product, or blend onto an order item.",
        };
      }

      // ── 4. The output ──────────────────────────────────────────────────────
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const blendedBatchNumber = `${today}${locked.map((b) => b.batchNumber.slice(-2)).sort().join("")}`;

      const blendedBatch = await tx.roastingBatch.create({
        data: {
          orderItemId: targetOrderItemId,
          productId: blendProductId,
          batchNumber: blendedBatchNumber,
          // A blend is not a roasting event, and its "input" is already-roasted coffee. The
          // column is NOT NULL with a CHECK of greenBeanQuantity > 0, so zero cannot be
          // stored; the smallest true statement that fits is that a transformation loses
          // nothing, so the mass in equals the mass out and there is no waste.
          //
          // Deliberately NOT the sum of the sources' green input, which is what this used to
          // be. That figure belongs to the roasts that already happened, and repeating it
          // here would count the same green coffee as production twice — the green-versus-
          // finished mixing R2.4 removed. Safe because every aggregation that sums
          // greenBeanQuantity (productionProgressMany, recalcOrderItemStatus,
          // roastingCeilingForItem, the production screen) filters isBlend: false.
          greenBeanQuantity: totalKg,
          wasteQuantity: 0,
          // Mass conservation, in both fields. roastedAvailableKg was previously left at its
          // default of 0, which is why a finished blend could never be packed at all.
          roastedBeanQuantity: totalKg,
          roastedAvailableKg: totalKg,
          status: commonStatus,
          isBlend: true,
          blendTiming,
          roastProfile: null,
          // productionOrderId is deliberately left null. The source roasts were already
          // credited to whatever production they were made for; attaching the output to one
          // of those orders as well would count the same coffee as produced twice.
        },
      });

      // ── 5. Spend the sources ───────────────────────────────────────────────
      const consumed = await consumeBlendSources(tx, plan, blendedBatch.id);

      // ── 6. Traceability ────────────────────────────────────────────────────
      // One row per source recording what was actually taken, which is what makes
      // Σ quantityUsed equal the output's roasted quantity. The previous version wrote each
      // source's full original roast here instead, so the ingredients never reconciled.
      await tx.blendIngredient.createMany({
        data: plan.map((p) => ({
          sourceBatchId: p.source.id,
          targetBlendBatchId: blendedBatch.id,
          quantityUsed: p.quantityKg,
        })),
      });

      await recordBlendMovements(tx, {
        blendBatchId: blendedBatch.id,
        blendBatchNumber: blendedBatch.batchNumber,
        consumed,
        totalKg,
        userId: user.id,
      });

      // ── 7. OrderItem before ProductionOrder ────────────────────────────────
      // These were previously the other way round, which put blending in direct opposition to
      // packaging: pack-sku recalculates the order line and then the production order, so a
      // blend holding a production order while waiting for a line, and a pack holding that
      // line while waiting for the production order, is a constructible cycle. Every path in
      // this system now takes OrderItem first.
      const affectedItemIds = [
        ...new Set([...distinctOwners, ...(targetOrderItemId ? [targetOrderItemId] : [])]),
      ];
      for (const itemId of affectedItemIds) {
        await recalcOrderItemStatus(itemId, tx);
      }

      const productionOrderIds = [
        ...new Set(locked.map((b) => b.productionOrderId).filter((id): id is string => id !== null)),
      ];
      for (const productionOrderId of productionOrderIds) {
        await recalcProductionOrderStatus(productionOrderId, tx);
      }

      return tx.roastingBatch.findUnique({
        where: { id: blendedBatch.id },
        include: {
          childBatches: { select: { id: true, batchNumber: true, roastedBeanQuantity: true } },
          blendInputs: { select: { id: true, sourceBatchId: true, quantityUsed: true } },
          orderItem: { include: { order: { include: { customer: true } } } },
        },
      });
    }, TX_OPTS);

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
