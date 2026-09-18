import { Prisma } from "@/generated/prisma/client";
import { explodeBom, roundKg } from "./finished-products";

type PrismaTx = Prisma.TransactionClient;

/**
 * Packaging as one physical process.
 *
 * The old model asked the operator which KIND of packaging they were doing — kilograms or
 * finished units — and then ran two different routes with two different inventory shapes.
 * That question has no physical meaning. A person fills a bag; what varies is only whether
 * the bag ended up holding what its label claims. This module decides that from the weight
 * and leaves the operator with one workflow.
 *
 * ── Grams, as integers ─────────────────────────────────────────────────────
 * Every quantity in this file is whole grams in a JS integer. Packaging decides whether a
 * package may be sold, and that decision must not turn on binary floating point: 0.1 + 0.2
 * is not 0.3, and a package that is one ulp under nominal is not a business event. Grams are
 * the smallest unit anyone here weighs, so integers are exact and comparisons are exact.
 *
 * The roast balance it draws from (`RoastingBatch.roastedAvailableKg`) is kilograms in a
 * Float, and stays that way — re-denominating the certified inventory ledger is a different
 * and far riskier change. The boundary is crossed once, explicitly, in gramsFromKg/kgFromGrams,
 * and the conditional UPDATE that actually moves the stock keeps the same half-gram tolerance
 * the rest of the packaging domain already uses.
 */

/** Kilograms (Float, as stored) to whole grams. */
export function gramsFromKg(kg: number): number {
  return Math.round(kg * 1000);
}

/** Whole grams back to the kilogram scale the roast balance is kept in. */
export function kgFromGrams(grams: number): number {
  return roundKg(grams / 1000);
}

/**
 * A line the operator entered.
 *
 * `pack` makes new physical packages. `topUp` adds coffee to a package that already exists
 * and is short of its nominal weight — the bag is already on the shelf, so it consumes
 * coffee but no new materials.
 */
export type PackagingLine =
  | { kind: "pack"; productSkuId: string; packages: number; gramsEach: number }
  | { kind: "topUp"; lotId: string; gramsAdded: number };

export type LineOutcome = {
  kind: "pack" | "topUp";
  productSkuId: string;
  skuCode: string;
  nominalGrams: number;
  /** Grams in each finished package after this line is applied. */
  actualGramsEach: number;
  packages: number;
  /** Grams this line draws from the roast. */
  gramsConsumed: number;
  classification: "STANDARD" | "PARTIAL";
  /** Sellable units this line creates. A partial package creates none. */
  standardUnitsCreated: number;
  /** Set for topUp lines: the package being finished. */
  lotId?: string;
  /** True when a topUp carries the package over its nominal weight. */
  becomesStandard?: boolean;
};

export type MaterialRequirement = {
  materialItemId: string;
  label: string;
  required: number;
  available: number;
  missing: number;
};

export type PackagingPreview = {
  availableGrams: number;
  lines: LineOutcome[];
  totalConsumedGrams: number;
  standardGrams: number;
  partialGrams: number;
  remainingGrams: number;
  standardUnits: number;
  partialPackages: number;
  materials: MaterialRequirement[];
  /** Reasons the operation cannot be committed. Empty means it can. */
  problems: string[];
};

/** Half a gram, the same tolerance the kilogram columns are compared with elsewhere. */
const KG_EPSILON = 0.0005;

/**
 * Classify a fill against its SKU's nominal weight.
 *
 * At or above nominal is a complete sellable package — 1005 g in a 1 KG bag is one sellable
 * kilogram whose real weight happens to be 1005 g, not 1.005 of a unit. Below nominal is a
 * partial: a real package holding real coffee that may not be sold as that SKU.
 */
export function classifyFill(actualGrams: number, nominalGrams: number): "STANDARD" | "PARTIAL" {
  return actualGrams >= nominalGrams ? "STANDARD" : "PARTIAL";
}

export type SkuFacts = {
  id: string;
  skuCode: string;
  weightGrams: number;
  isActive: boolean;
  productId: string;
};

/**
 * Reconcile a set of lines against the roast's available coffee and the material shelf,
 * without writing anything.
 *
 * The same function backs the operator's pre-commit summary and the commit path's own
 * validation, so what the screen promised and what the server enforces cannot drift apart.
 */
export async function previewPackaging(
  tx: PrismaTx,
  args: {
    batch: { id: string; productId: string | null; roastedAvailableKg: number; status: string };
    lines: PackagingLine[];
    skus: Map<string, SkuFacts>;
    partialLots: Map<string, { id: string; productSkuId: string | null; actualContentGrams: number | null; nominalContentGrams: number | null; status: string; productId: string }>;
  },
): Promise<PackagingPreview> {
  const { batch, lines, skus, partialLots } = args;
  const problems: string[] = [];
  const availableGrams = gramsFromKg(batch.roastedAvailableKg);

  const outcomes: LineOutcome[] = [];
  // materialItemId -> pieces required across every line
  const materialNeed = new Map<string, number>();

  for (const [index, line] of lines.entries()) {
    const n = index + 1;

    if (line.kind === "pack") {
      const sku = skus.get(line.productSkuId);
      if (!sku) { problems.push(`Line ${n}: that product no longer exists.`); continue; }
      if (!sku.isActive) { problems.push(`Line ${n}: "${sku.skuCode}" is inactive and cannot be packed.`); continue; }
      if (!Number.isInteger(line.packages) || line.packages < 1) {
        problems.push(`Line ${n}: the number of packages must be a whole number of at least one.`);
        continue;
      }
      if (!Number.isInteger(line.gramsEach) || line.gramsEach < 1) {
        problems.push(`Line ${n}: the fill weight must be a whole number of grams, greater than zero.`);
        continue;
      }

      const nominalGrams = Math.round(sku.weightGrams);
      const classification = classifyFill(line.gramsEach, nominalGrams);
      const gramsConsumed = line.gramsEach * line.packages;

      outcomes.push({
        kind: "pack",
        productSkuId: sku.id,
        skuCode: sku.skuCode,
        nominalGrams,
        actualGramsEach: line.gramsEach,
        packages: line.packages,
        gramsConsumed,
        classification,
        standardUnitsCreated: classification === "STANDARD" ? line.packages : 0,
      });

      // Materials are per PHYSICAL package and are indifferent to how full it is: an
      // under-filled bag is still a bag, still sealed, still labelled. The BOM's
      // roasted-coffee line is deliberately ignored here — the coffee drawn is the weight
      // the operator actually put in, not the SKU's nominal figure.
      const bom = await explodeBom(tx, sku.id, line.packages);
      for (const req of bom) {
        if (req.type !== "MATERIAL" || !req.materialItemId) continue;
        materialNeed.set(req.materialItemId, (materialNeed.get(req.materialItemId) ?? 0) + req.quantityRequired);
      }
      continue;
    }

    // ── top-up ────────────────────────────────────────────────────────────
    const lot = partialLots.get(line.lotId);
    if (!lot) { problems.push(`Line ${n}: that package no longer exists.`); continue; }
    if (lot.status !== "PARTIAL") {
      problems.push(`Line ${n}: that package has already been completed and cannot be topped up again.`);
      continue;
    }
    if (!Number.isInteger(line.gramsAdded) || line.gramsAdded < 1) {
      problems.push(`Line ${n}: the added weight must be a whole number of grams, greater than zero.`);
      continue;
    }
    // Two coffees may only meet inside one package if the ERP already considers them the
    // same product. Packaging is not a blending route and must not become one by accident.
    if (batch.productId && lot.productId !== batch.productId) {
      problems.push(
        `Line ${n}: that package holds a different coffee from this roast. ` +
          `Combining them here would create a blend that no blending record accounts for.`,
      );
      continue;
    }

    const sku = lot.productSkuId ? skus.get(lot.productSkuId) : undefined;
    const nominalGrams = lot.nominalContentGrams ?? (sku ? Math.round(sku.weightGrams) : 0);
    const before = lot.actualContentGrams ?? 0;
    const after = before + line.gramsAdded;
    const classification = classifyFill(after, nominalGrams);

    outcomes.push({
      kind: "topUp",
      productSkuId: lot.productSkuId ?? "",
      skuCode: sku?.skuCode ?? "—",
      nominalGrams,
      actualGramsEach: after,
      packages: 1,
      gramsConsumed: line.gramsAdded,
      classification,
      standardUnitsCreated: classification === "STANDARD" ? 1 : 0,
      lotId: lot.id,
      becomesStandard: classification === "STANDARD",
    });
    // No materials: the bag, label and valve were consumed when the package was first made.
  }

  const totalConsumedGrams = outcomes.reduce((s, o) => s + o.gramsConsumed, 0);
  const standardGrams = outcomes.filter((o) => o.classification === "STANDARD").reduce((s, o) => s + o.gramsConsumed, 0);
  const partialGrams = totalConsumedGrams - standardGrams;

  if (outcomes.length === 0 && problems.length === 0) {
    problems.push("Nothing was entered to package.");
  }
  if (totalConsumedGrams > availableGrams) {
    problems.push(
      `This would use ${totalConsumedGrams} g but only ${availableGrams} g is unpacked on this roast.`,
    );
  }

  const materials: MaterialRequirement[] = [];
  if (materialNeed.size > 0) {
    const items = await tx.materialItem.findMany({
      where: { id: { in: [...materialNeed.keys()] } },
      select: { id: true, name: true, quantityOnHand: true },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const [materialItemId, required] of materialNeed) {
      const item = byId.get(materialItemId);
      const available = item?.quantityOnHand ?? 0;
      const missing = Math.max(0, required - available);
      materials.push({ materialItemId, label: item?.name ?? materialItemId, required, available, missing });
      if (missing > 0) {
        problems.push(
          `Not enough ${item?.name ?? "packaging material"}: ${required} needed, ${available} on hand.`,
        );
      }
    }
  }

  return {
    availableGrams,
    lines: outcomes,
    totalConsumedGrams,
    standardGrams,
    partialGrams,
    remainingGrams: Math.max(0, availableGrams - totalConsumedGrams),
    standardUnits: outcomes.reduce((s, o) => s + o.standardUnitsCreated, 0),
    partialPackages: outcomes.filter((o) => o.kind === "pack" && o.classification === "PARTIAL")
      .reduce((s, o) => s + o.packages, 0),
    materials,
    problems,
  };
}

export const PACKAGING_EPSILON_KG = KG_EPSILON;

export type CommitResult = {
  standardUnitsCreated: number;
  partialPackagesCreated: number;
  partialPackagesCompleted: number;
  gramsConsumed: number;
  remainingGrams: number;
  lots: { id: string; skuCode: string; classification: "STANDARD" | "PARTIAL"; units: number; actualGrams: number }[];
  materialsConsumed: { materialItemId: string; label: string; quantity: number }[];
};

/**
 * Apply a reconciled set of packaging lines.
 *
 * Must be called inside a transaction that already holds SELECT ... FOR UPDATE on the roast
 * row and has cleared the idempotency guard. That lock is the single point of serialisation
 * for everything below: two operators packing the same roast queue on it rather than racing,
 * which is what makes the coffee draw, the material draw and the lot writes one indivisible
 * act. Taking it on RoastingBatch also keeps the established lock order — batch before stock
 * before order — so this adds no new deadlock edge.
 */
export async function commitPackaging(
  tx: PrismaTx,
  args: {
    batch: { id: string; batchNumber: string; productId: string | null; roastedAvailableKg: number };
    preview: PackagingPreview;
    skus: Map<string, SkuFacts>;
    userId: string | null;
    operationId: string | null;
  },
): Promise<CommitResult> {
  const { batch, preview, skus, userId, operationId } = args;

  if (preview.problems.length > 0) {
    throw { _appCode: 409, message: preview.problems[0] };
  }

  const consumedKg = kgFromGrams(preview.totalConsumedGrams);

  // ── Draw the coffee, atomically ───────────────────────────────────────────
  // Conditional UPDATE rather than read-then-write even though the row is already locked:
  // the WHERE clause is what makes the balance impossible to overdraw and keeps the
  // non-negative constraint out of reach. The half-gram slack is the tolerance the rest of
  // the packaging domain already compares kilograms with.
  const drawn = await tx.$executeRaw`
    UPDATE "RoastingBatch"
       SET "roastedAvailableKg" = "roastedAvailableKg" - ${consumedKg}
     WHERE "id" = ${batch.id}
       AND ("roastedAvailableKg" + ${PACKAGING_EPSILON_KG}) >= ${consumedKg}
  `;
  if (drawn !== 1) {
    throw {
      _appCode: 409,
      message:
        `Not enough roasted coffee left on batch ${batch.batchNumber}: this needs ` +
        `${preview.totalConsumedGrams} g and the roast no longer holds it.`,
    };
  }

  await tx.inventoryMovement.create({
    data: {
      type: "OUT",
      category: "ROASTED_COFFEE",
      referenceEntityId: batch.id,
      quantityChanged: -consumedKg,
      previousQuantity: batch.roastedAvailableKg,
      newQuantity: roundKg(batch.roastedAvailableKg - consumedKg),
      sourceDocType: "PACKING",
      sourceDocId: batch.id,
      userId,
      notes: `Unified packaging: ${preview.totalConsumedGrams} g across ${preview.lines.length} line(s)`,
    },
  });

  // ── Draw the packaging materials ──────────────────────────────────────────
  const materialsConsumed: CommitResult["materialsConsumed"] = [];
  for (const m of preview.materials) {
    if (m.required <= 0) continue;
    const ok = await tx.$executeRaw`
      UPDATE "MaterialItem"
         SET "quantityOnHand" = "quantityOnHand" - ${m.required}
       WHERE "id" = ${m.materialItemId}
         AND "quantityOnHand" >= ${m.required}
    `;
    if (ok !== 1) {
      throw {
        _appCode: 409,
        message: `Not enough ${m.label}: ${m.required} needed and the shelf no longer holds it.`,
      };
    }
    await tx.inventoryMovement.create({
      data: {
        type: "OUT",
        category: "PACKAGING_MATERIAL",
        referenceEntityId: m.materialItemId,
        quantityChanged: -m.required,
        previousQuantity: m.available,
        newQuantity: m.available - m.required,
        sourceDocType: "BOM_CONSUMPTION",
        sourceDocId: batch.id,
        userId,
        notes: `${m.required} x ${m.label}`,
      },
    });
    materialsConsumed.push({ materialItemId: m.materialItemId, label: m.label, quantity: m.required });
  }

  // ── Create and complete packages ──────────────────────────────────────────
  const lots: CommitResult["lots"] = [];
  let standardUnitsCreated = 0;
  let partialPackagesCreated = 0;
  let partialPackagesCompleted = 0;

  for (const line of preview.lines) {
    if (line.kind === "topUp" && line.lotId) {
      // Claim the package by its CURRENT state. If a concurrent submit finished the same
      // package first this matches nothing, and the operation fails rather than producing a
      // second sellable unit out of one bag.
      const claimed = await tx.finishedGoodsLot.updateMany({
        where: { id: line.lotId, status: "PARTIAL" },
        data: {
          actualContentGrams: line.actualGramsEach,
          quantityKg: kgFromGrams(line.actualGramsEach),
          ...(line.becomesStandard
            ? { status: "AVAILABLE" as const, unitsProduced: 1, unitsAvailable: 1 }
            : {}),
        },
      });
      if (claimed.count !== 1) {
        throw {
          _appCode: 409,
          message:
            "That package was completed by someone else while this was being entered. Nothing was changed.",
        };
      }
      await tx.packagingSource.create({
        data: {
          finishedGoodsLotId: line.lotId,
          roastingBatchId: batch.id,
          gramsContributed: line.gramsConsumed,
          packagingOperationId: operationId,
        },
      });
      await tx.inventoryMovement.create({
        data: {
          type: "IN",
          category: "FINISHED_GOODS",
          referenceEntityId: line.lotId,
          quantityChanged: kgFromGrams(line.gramsConsumed),
          previousQuantity: kgFromGrams(line.actualGramsEach - line.gramsConsumed),
          newQuantity: kgFromGrams(line.actualGramsEach),
          sourceDocType: "PACKING",
          sourceDocId: batch.id,
          userId,
          notes: `top-up ${line.skuCode}: +${line.gramsConsumed} g to ${line.actualGramsEach} g of ${line.nominalGrams} g`,
        },
      });
      if (line.becomesStandard) {
        standardUnitsCreated += 1;
        partialPackagesCompleted += 1;
      }
      lots.push({
        id: line.lotId,
        skuCode: line.skuCode,
        classification: line.classification,
        units: line.becomesStandard ? 1 : 0,
        actualGrams: line.actualGramsEach,
      });
      continue;
    }

    const sku = skus.get(line.productSkuId);
    if (!sku) throw { _appCode: 409, message: "That product is no longer available." };

    if (line.classification === "STANDARD") {
      // One lot carries every package from this line — they are identical and
      // interchangeable, which is exactly what a unit-tracked lot means.
      const lot = await tx.finishedGoodsLot.create({
        data: {
          productId: sku.productId,
          productSkuId: sku.id,
          batchNumber: batch.batchNumber,
          packedFromBatchId: batch.id,
          quantityKg: kgFromGrams(line.gramsConsumed),
          availableQty: 0,
          reservedQty: 0,
          isUnitTracked: true,
          unitsProduced: line.packages,
          unitsAvailable: line.packages,
          unitsReserved: 0,
          status: "AVAILABLE",
          actualContentGrams: line.actualGramsEach,
          nominalContentGrams: line.nominalGrams,
          materialsConsumed: true,
        },
      });
      await tx.packagingSource.create({
        data: {
          finishedGoodsLotId: lot.id,
          roastingBatchId: batch.id,
          gramsContributed: line.gramsConsumed,
          packagingOperationId: operationId,
        },
      });
      await tx.inventoryMovement.create({
        data: {
          type: "IN",
          category: "FINISHED_GOODS",
          referenceEntityId: lot.id,
          quantityChanged: kgFromGrams(line.gramsConsumed),
          previousQuantity: 0,
          newQuantity: kgFromGrams(line.gramsConsumed),
          sourceDocType: "PACKING",
          sourceDocId: batch.id,
          userId,
          notes: `${line.packages} x ${sku.skuCode} @ ${line.actualGramsEach} g`,
        },
      });
      standardUnitsCreated += line.packages;
      lots.push({
        id: lot.id,
        skuCode: sku.skuCode,
        classification: "STANDARD",
        units: line.packages,
        actualGrams: line.actualGramsEach,
      });
      continue;
    }

    // PARTIAL: one lot per physical package, because each can be topped up independently
    // and therefore needs its own identity.
    for (let i = 0; i < line.packages; i++) {
      const lot = await tx.finishedGoodsLot.create({
        data: {
          productId: sku.productId,
          productSkuId: sku.id,
          batchNumber: batch.batchNumber,
          packedFromBatchId: batch.id,
          quantityKg: kgFromGrams(line.actualGramsEach),
          availableQty: 0,
          reservedQty: 0,
          isUnitTracked: true,
          // Zero sellable units. The coffee and the bag are fully accounted for, but nothing
          // here may be promised to an order until the package reaches its nominal weight.
          unitsProduced: 0,
          unitsAvailable: 0,
          unitsReserved: 0,
          status: "PARTIAL",
          actualContentGrams: line.actualGramsEach,
          nominalContentGrams: line.nominalGrams,
          materialsConsumed: true,
        },
      });
      await tx.packagingSource.create({
        data: {
          finishedGoodsLotId: lot.id,
          roastingBatchId: batch.id,
          gramsContributed: line.actualGramsEach,
          packagingOperationId: operationId,
        },
      });
      await tx.inventoryMovement.create({
        data: {
          type: "IN",
          category: "FINISHED_GOODS",
          referenceEntityId: lot.id,
          quantityChanged: kgFromGrams(line.actualGramsEach),
          previousQuantity: 0,
          newQuantity: kgFromGrams(line.actualGramsEach),
          sourceDocType: "PACKING",
          sourceDocId: batch.id,
          userId,
          notes: `partial ${sku.skuCode}: ${line.actualGramsEach} g of ${line.nominalGrams} g`,
        },
      });
      partialPackagesCreated += 1;
      lots.push({
        id: lot.id,
        skuCode: sku.skuCode,
        classification: "PARTIAL",
        units: 0,
        actualGrams: line.actualGramsEach,
      });
    }
  }

  const after = await tx.roastingBatch.findUniqueOrThrow({
    where: { id: batch.id },
    select: { roastedAvailableKg: true },
  });

  return {
    standardUnitsCreated,
    partialPackagesCreated,
    partialPackagesCompleted,
    gramsConsumed: preview.totalConsumedGrams,
    remainingGrams: gramsFromKg(after.roastedAvailableKg),
    lots,
    materialsConsumed,
  };
}
