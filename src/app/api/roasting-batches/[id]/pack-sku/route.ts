import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";
import { explodeBom, kgForUnits, roundKg } from "@/lib/services/finished-products";

type Params = { params: Promise<{ id: string }> };

/**
 * Pack a roast into whole units of one finished SKU.
 *
 * This is the step that closes the chain the redesign asks for:
 *   GreenBean -> Roasting -> roasted stock -> Packaging (BOM) -> Finished Goods SKU
 *
 * It consumes the SKU's bill of materials — roasted coffee in kilograms from this batch,
 * and packaging materials in pieces from MaterialItem — and produces a unit-tracked
 * FinishedGoodsLot. Green coffee is never touched here; it was already consumed by the
 * roast that created this batch's roasted stock.
 *
 * Deliberately a NEW endpoint rather than a rewrite of PUT ../package. That route is the
 * legacy kilogram path (fixed 3kg/1kg/250g/150g bag counters, one lot per batch) and it
 * still serves the legacy bean-based order lines. Rewriting it would have put the
 * recently stabilised shelf-allocation behaviour at risk for no benefit; the two paths
 * are kept apart, and a lot produced here is unit-tracked while a lot produced there is
 * not.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireEdit("packaging");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (typeof b.productSkuId !== "string" || !b.productSkuId)
    return NextResponse.json({ error: "productSkuId is required." }, { status: 400 });

  const units = Number(b.units);
  if (!Number.isInteger(units) || units <= 0)
    return NextResponse.json(
      { error: "units must be a whole number greater than zero." },
      { status: 400 }
    );

  try {
    const result = await prisma.$transaction(async (tx) => {
      const batch = await tx.roastingBatch.findUnique({
        where: { id },
        select: {
          id: true,
          batchNumber: true,
          status: true,
          productId: true,
          roastedAvailableKg: true,
          productionOrderId: true,
        },
      });
      if (!batch) throw { _appCode: 404, message: "Batch not found." };

      if (batch.status !== "Passed" && batch.status !== "Partially Packaged")
        throw {
          _appCode: 409,
          message: `Cannot package a batch with status "${batch.status}". Only QC-passed or partially packaged batches can be packed.`,
        };

      // The legacy kilogram path and this one must never both run on the same batch.
      // That route records bag counters and creates a kg lot without drawing down
      // roastedAvailableKg, so allowing both would let one roast be sold twice — once as
      // kilograms on the legacy shelf and again as units here.
      const legacyLot = await tx.finishedGoodsLot.findFirst({
        where: { roastingBatchId: batch.id },
        select: { id: true },
      });
      if (legacyLot)
        throw {
          _appCode: 409,
          message: `Batch ${batch.batchNumber} was already packed through the legacy kilogram flow. A batch cannot be packed both ways.`,
        };

      const sku = await tx.productSKU.findUnique({
        where: { id: b.productSkuId as string },
        select: { id: true, skuCode: true, weightGrams: true, isActive: true, productId: true },
      });
      if (!sku) throw { _appCode: 404, message: "Product SKU not found." };
      if (!sku.isActive)
        throw { _appCode: 409, message: `"${sku.skuCode}" is inactive and cannot be packed.` };

      // ── Bill of materials ──────────────────────────────────────────────────
      const requirements = await explodeBom(tx, sku.id, units);
      if (requirements.length === 0)
        throw {
          _appCode: 409,
          message: `"${sku.skuCode}" has no bill of materials. Define its components before packing.`,
        };

      // Roasted coffee must come from THIS batch — that is what makes the lot traceable
      // back to a specific roast. explodeBom reports stock across every batch, so the
      // per-batch check is done here rather than taken from its shortfall figure.
      const coffeeNeeded = roundKg(
        requirements
          .filter((r) => r.type === "ROASTED_COFFEE")
          .reduce((sum, r) => sum + r.quantityRequired, 0)
      );

      if (coffeeNeeded > 0) {
        const coffeeLines = requirements.filter((r) => r.type === "ROASTED_COFFEE");
        const mismatched = coffeeLines.find(
          (r) => r.coffeeProductId && batch.productId && r.coffeeProductId !== batch.productId
        );
        if (mismatched)
          throw {
            _appCode: 409,
            message: `This batch is not the coffee "${sku.skuCode}" is made from. Its BOM needs ${mismatched.label}.`,
          };

        // Conditional UPDATE: re-checks the balance in the WHERE clause so two packers
        // drawing on the same roast cannot both succeed on the same kilograms. Same
        // atomic pattern as the shelf reservation. The 0.0005 slack is half a gram,
        // below the 3-decimal storage precision, absorbing float error on a value that
        // was read rounded.
        const drawn = await tx.$executeRaw`
          UPDATE "RoastingBatch"
             SET "roastedAvailableKg" = "roastedAvailableKg" - ${coffeeNeeded}
           WHERE "id" = ${batch.id}
             AND ("roastedAvailableKg" + 0.0005) >= ${coffeeNeeded}
        `;
        if (drawn !== 1)
          throw {
            _appCode: 409,
            message: `Not enough roasted coffee on batch ${batch.batchNumber}: ${units} x ${sku.skuCode} needs ${coffeeNeeded}kg but only ${batch.roastedAvailableKg}kg is unpacked.`,
          };

        await tx.inventoryMovement.create({
          data: {
            type: "OUT",
            category: "ROASTED_COFFEE",
            referenceEntityId: batch.id,
            quantityChanged: -coffeeNeeded,
            previousQuantity: batch.roastedAvailableKg,
            newQuantity: roundKg(batch.roastedAvailableKg - coffeeNeeded),
            sourceDocType: "BOM_CONSUMPTION",
            sourceDocId: batch.id,
            userId: user.id,
            notes: `Packed ${units} x ${sku.skuCode}`,
          },
        });
      }

      // ── Packaging materials ────────────────────────────────────────────────
      // Three round trips per component — look it up, claim it, record the movement —
      // added up fast on a bill of materials of any size, and this database is across the
      // public internet. Only the middle one has to be per-component: the conditional
      // UPDATE is the atomic claim and stays exactly as it was. The lookups are collapsed
      // into one query before the loop, and the movements into one insert after it, so a
      // three-component pack costs five round trips instead of nine.
      const materialLines = requirements.filter((r) => r.type === "MATERIAL" && r.materialItemId);

      const materials = new Map(
        (
          await tx.materialItem.findMany({
            where: { id: { in: materialLines.map((l) => l.materialItemId as string) } },
            select: { id: true, code: true, name: true, quantityOnHand: true },
          })
        ).map((m) => [m.id, m])
      );

      const materialMovements: Prisma.InventoryMovementCreateManyInput[] = [];

      for (const line of materialLines) {
        const material = materials.get(line.materialItemId as string);
        if (!material)
          throw { _appCode: 409, message: `Material ${line.label} no longer exists.` };

        const consumed = await tx.$executeRaw`
          UPDATE "MaterialItem"
             SET "quantityOnHand" = "quantityOnHand" - ${line.quantityRequired}
           WHERE "id" = ${line.materialItemId}
             AND "quantityOnHand" >= ${line.quantityRequired}
        `;
        if (consumed !== 1)
          throw {
            _appCode: 409,
            message: `Not enough ${material.name} (${material.code}): need ${line.quantityRequired}, have ${material.quantityOnHand}.`,
          };

        materialMovements.push({
          type: "OUT",
          category: "PACKAGING_MATERIAL",
          referenceEntityId: material.id,
          quantityChanged: -line.quantityRequired,
          previousQuantity: material.quantityOnHand,
          newQuantity: Number((material.quantityOnHand - line.quantityRequired).toFixed(3)),
          sourceDocType: "BOM_CONSUMPTION",
          sourceDocId: batch.id,
          userId: user.id,
          notes: `Packed ${units} x ${sku.skuCode}`,
        });
      }

      // Written after the loop, inside the same transaction: if any component came up
      // short the throw above aborts before this runs, and nothing is left behind.
      if (materialMovements.length > 0) {
        await tx.inventoryMovement.createMany({ data: materialMovements });
      }

      // ── Finished goods ─────────────────────────────────────────────────────
      // One lot per (batch, SKU) packing run. Units are authoritative; quantityKg is
      // written as the derived kg-equivalent so the ledger and reports keep one field to
      // read, and availableQty/reservedQty stay at 0 because this lot is not kg-tracked.
      const producedKg = kgForUnits(sku, units);

      const existing = await tx.finishedGoodsLot.findFirst({
        where: { packedFromBatchId: batch.id, productSkuId: sku.id, isUnitTracked: true },
        select: { id: true, unitsProduced: true, unitsAvailable: true, quantityKg: true },
      });

      const lot = existing
        ? await tx.finishedGoodsLot.update({
            where: { id: existing.id },
            data: {
              unitsProduced: existing.unitsProduced + units,
              unitsAvailable: existing.unitsAvailable + units,
              quantityKg: roundKg(existing.quantityKg + producedKg),
            },
          })
        : await tx.finishedGoodsLot.create({
            data: {
              productId: sku.productId,
              productSkuId: sku.id,
              batchNumber: batch.batchNumber,
              // roastingBatchId deliberately left null — see the note on packedFromBatchId
              // in schema.prisma. That column is the legacy 1:1 link and is UNIQUE.
              packedFromBatchId: batch.id,
              quantityKg: producedKg,
              availableQty: 0,
              reservedQty: 0,
              isUnitTracked: true,
              unitsProduced: units,
              unitsAvailable: units,
              unitsReserved: 0,
              status: "AVAILABLE",
            },
          });

      await tx.inventoryMovement.create({
        data: {
          type: "IN",
          category: "FINISHED_GOODS",
          referenceEntityId: lot.id,
          quantityChanged: producedKg,
          previousQuantity: existing ? existing.quantityKg : 0,
          newQuantity: lot.quantityKg,
          sourceDocType: "PACKING",
          sourceDocId: batch.id,
          userId: user.id,
          notes: `${units} x ${sku.skuCode}`,
        },
      });

      // Mark the roast packed out once nothing meaningful is left to pack (under 50g).
      const after = await tx.roastingBatch.findUniqueOrThrow({
        where: { id: batch.id },
        select: { roastedAvailableKg: true, status: true },
      });
      if (after.roastedAvailableKg < 0.05 && after.status !== "Packaged") {
        await tx.roastingBatch.update({ where: { id: batch.id }, data: { status: "Packaged" } });
      } else if (after.status === "Passed") {
        await tx.roastingBatch.update({
          where: { id: batch.id },
          data: { status: "Partially Packaged" },
        });
      }

      if (batch.productionOrderId) await recalcProductionOrderStatus(batch.productionOrderId, tx);

      return {
        lotId: lot.id,
        skuCode: sku.skuCode,
        unitsPacked: units,
        unitsAvailableOnLot: lot.unitsAvailable,
        roastedCoffeeConsumedKg: coffeeNeeded,
        roastedAvailableKgRemaining: roundKg(after.roastedAvailableKg),
        materialsConsumed: requirements
          .filter((r) => r.type === "MATERIAL")
          .map((r) => ({ label: r.label, quantity: r.quantityRequired })),
      };
    }, TX_OPTS);

    return NextResponse.json(result, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
