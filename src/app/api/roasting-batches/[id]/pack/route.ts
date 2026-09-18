import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import {
  readRequestKey,
  packagingRequestHash,
  guardIdempotency,
  recordOperation,
  isReplaySignal,
  type PackIntentLine,
} from "@/lib/services/packaging-idempotency";
import {
  previewPackaging,
  commitPackaging,
  gramsFromKg,
  type PackagingLine,
  type SkuFacts,
} from "@/lib/services/unified-packaging";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/roasting-batches/[id]/pack — the unified packaging operation.
 *
 * One route for what used to be two. The caller never says which KIND of packaging this is,
 * because that was never a physical property of the work: it describes the packages it
 * filled and how much went into each, and the server decides what that means for inventory.
 * A fill at or above the SKU's nominal weight is a sellable unit; a fill below it is a real
 * package that is not yet sellable. Both are recorded; neither is inferred from a mode flag.
 *
 * `preview: true` reconciles and reports without writing, which is what the operator's
 * pre-commit summary is built from. The commit path re-runs the very same reconciliation
 * inside the transaction, so the screen and the server cannot disagree about what will happen.
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
  const isPreview = b.preview === true;

  // ── Shape the lines before anything else ──────────────────────────────────
  // Rejected here rather than deep inside a transaction: a malformed line is a caller bug,
  // and locking a roast to discover it helps nobody.
  if (!Array.isArray(b.lines) || b.lines.length === 0) {
    return NextResponse.json({ error: "At least one packaging line is required." }, { status: 400 });
  }
  if (b.lines.length > 50) {
    return NextResponse.json({ error: "Too many packaging lines in one operation." }, { status: 400 });
  }

  const lines: PackagingLine[] = [];
  for (const raw of b.lines as Record<string, unknown>[]) {
    if (raw?.kind === "loss") {
      lines.push({ kind: "loss", grams: Number(raw.grams), reason: String(raw.reason ?? "") });
      continue;
    }
    if (raw?.kind === "topUp") {
      if (typeof raw.lotId !== "string" || !raw.lotId) {
        return NextResponse.json({ error: "Each top-up line needs the package it continues." }, { status: 400 });
      }
      lines.push({ kind: "topUp", lotId: raw.lotId, gramsAdded: Number(raw.gramsAdded) });
      continue;
    }
    if (typeof raw?.productSkuId !== "string" || !raw.productSkuId) {
      return NextResponse.json({ error: "Each packaging line needs a product." }, { status: 400 });
    }
    lines.push({
      kind: "pack",
      productSkuId: raw.productSkuId,
      packages: Number(raw.packages),
      gramsEach: Number(raw.gramsEach),
    });
  }

  // A preview writes nothing, so it needs no idempotency key and takes no lock.
  if (isPreview) {
    try {
      const prepared = await loadPreviewInputs(prisma, id, lines);
      if ("error" in prepared) return NextResponse.json({ error: prepared.error }, { status: prepared.status });
      const preview = await previewPackaging(prisma, {
        batch: prepared.batch,
        lines,
        skus: prepared.skus,
        partialLots: prepared.partialLots,
      });
      return NextResponse.json(preview);
    } catch (err) {
      return handlePrismaError(err);
    }
  }

  const key = readRequestKey(request);
  if (!key.ok) return NextResponse.json({ error: key.message }, { status: 400 });

  const intentLines: PackIntentLine[] = lines.map((l) => {
    if (l.kind === "pack") {
      return { kind: "pack", productSkuId: l.productSkuId, packages: l.packages, gramsEach: l.gramsEach };
    }
    if (l.kind === "topUp") return { kind: "topUp", lotId: l.lotId, gramsAdded: l.gramsAdded };
    return { kind: "loss", grams: l.grams, reason: l.reason };
  });
  const requestHash = packagingRequestHash({ method: "PACK", batchId: id, lines: intentLines });

  try {
    const result = await prisma.$transaction(async (tx) => {
      // The roast row is the single point of serialisation for packaging, and may be locked
      // ahead of every stock and order lock, so taking it here costs no ordering guarantee.
      const locked = await tx.$queryRaw<
        { id: string; batchNumber: string; status: string; productId: string | null; roastedAvailableKg: number }[]
      >`
        SELECT "id", "batchNumber", "status", "productId", "roastedAvailableKg"
          FROM "RoastingBatch"
         WHERE "id" = ${id}
           FOR UPDATE
      `;
      const batch = locked[0];
      if (!batch) throw { _appCode: 404, message: "Batch not found." };

      // Behind the lock, with nothing cheaper in front of it: two retries of one submit
      // queue here and the second reads what the first committed rather than racing it.
      await guardIdempotency(tx, batch.id, key.key, requestHash);

      if (batch.status !== "Passed" && batch.status !== "Partially Packaged") {
        throw {
          _appCode: 409,
          message: `Cannot package a batch with status "${batch.status}". Only QC-passed or partially packaged batches can be packed.`,
        };
      }

      const prepared = await loadPreviewInputs(tx, batch.id, lines, batch);
      if ("error" in prepared) throw { _appCode: prepared.status, message: prepared.error };

      // Re-reconciled against the state this transaction sees, not the state the screen saw.
      const preview = await previewPackaging(tx, {
        batch: prepared.batch,
        lines,
        skus: prepared.skus,
        partialLots: prepared.partialLots,
      });

      const committed = await commitPackaging(tx, {
        batch: { id: batch.id, batchNumber: batch.batchNumber, productId: batch.productId, roastedAvailableKg: batch.roastedAvailableKg },
        preview,
        skus: prepared.skus,
        userId: user.id,
        operationId: null,
      });

      // Mark the roast packed out once nothing meaningful is left (under 50 g), matching the
      // threshold the existing packaging paths use.
      if (committed.remainingGrams < 50) {
        await tx.roastingBatch.updateMany({
          where: { id: batch.id, status: { not: "Packaged" } },
          data: { status: "Packaged" },
        });
      } else {
        await tx.roastingBatch.updateMany({
          where: { id: batch.id, status: "Passed" },
          data: { status: "Partially Packaged" },
        });
      }

      const responseBody = {
        batchNumber: batch.batchNumber,
        standardUnitsCreated: committed.standardUnitsCreated,
        partialPackagesCreated: committed.partialPackagesCreated,
        partialPackagesCompleted: committed.partialPackagesCompleted,
        gramsConsumed: committed.gramsConsumed,
        lossGrams: committed.lossGrams,
        remainingGrams: committed.remainingGrams,
        lots: committed.lots,
        materialsConsumed: committed.materialsConsumed,
      };

      await recordOperation(tx, {
        batchId: batch.id,
        requestKey: key.key,
        requestHash,
        method: "PACK",
        quantityKg: null,
        quantityUnits: committed.standardUnitsCreated,
        productSkuId: null,
        finishedGoodsLotId: committed.lots[0]?.id ?? null,
        responseStatus: 201,
        responseBody,
        userId: user.id,
      });

      return responseBody;
    }, TX_OPTS);

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (isReplaySignal(err)) {
      return NextResponse.json(err._replayBody, {
        status: err._replayStatus,
        headers: { "X-Idempotent-Replay": "true" },
      });
    }
    // Domain refusals carry the status they mean. Without this they fall through to the
    // Prisma mapper and surface as 500s, which tells the operator nothing and makes a
    // deliberate, correct refusal look like a server fault.
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}

/**
 * Everything the reconciliation needs, read once.
 *
 * Takes the batch when the caller already holds it locked, so the commit path reconciles
 * against the row it locked rather than re-reading it unlocked.
 */
async function loadPreviewInputs(
  db: typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  batchId: string,
  lines: PackagingLine[],
  known?: { id: string; productId: string | null; roastedAvailableKg: number; status: string },
) {
  const batch =
    known ??
    (await db.roastingBatch.findUnique({
      where: { id: batchId },
      select: { id: true, productId: true, roastedAvailableKg: true, status: true },
    }));
  if (!batch) return { error: "Batch not found.", status: 404 as const };

  const skuIds = [...new Set(lines.flatMap((l) => (l.kind === "pack" ? [l.productSkuId] : [])))];
  const lotIds = [...new Set(lines.flatMap((l) => (l.kind === "topUp" ? [l.lotId] : [])))];

  const skuRows = skuIds.length
    ? await db.productSKU.findMany({
        where: { id: { in: skuIds } },
        select: { id: true, skuCode: true, weightGrams: true, isActive: true, productId: true },
      })
    : [];
  const skus = new Map<string, SkuFacts>(skuRows.map((s) => [s.id, s]));

  const lotRows = lotIds.length
    ? await db.finishedGoodsLot.findMany({
        where: { id: { in: lotIds } },
        select: {
          id: true,
          productSkuId: true,
          actualContentGrams: true,
          nominalContentGrams: true,
          status: true,
          productId: true,
        },
      })
    : [];
  // A top-up needs its SKU's facts too, to name it and to know its nominal weight.
  for (const lot of lotRows) {
    if (lot.productSkuId && !skus.has(lot.productSkuId)) {
      const s = await db.productSKU.findUnique({
        where: { id: lot.productSkuId },
        select: { id: true, skuCode: true, weightGrams: true, isActive: true, productId: true },
      });
      if (s) skus.set(s.id, s);
    }
  }
  const partialLots = new Map(lotRows.map((l) => [l.id, { ...l, status: String(l.status) }]));

  return { batch, skus, partialLots };
}

/**
 * GET /api/roasting-batches/[id]/pack — what the packaging screen needs to open.
 *
 * The unpacked coffee on the roast, and the open partial packages this roast may legally be
 * poured into. Eligibility is decided here with the SAME rule previewPackaging enforces —
 * two coffees may only meet inside one package if the ERP already calls them the same
 * product — so the screen cannot offer a top-up the commit would refuse.
 */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireEdit("packaging");
  if (error) return error;

  const { id } = await params;

  try {
    const batch = await prisma.roastingBatch.findUnique({
      where: { id },
      select: { id: true, batchNumber: true, status: true, productId: true, roastedAvailableKg: true },
    });
    if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });

    const partials = await prisma.finishedGoodsLot.findMany({
      where: {
        status: "PARTIAL",
        // Mirrors the commit-side guard exactly. A roast with no product of its own is not
        // narrowed here, because the validator does not narrow it either.
        ...(batch.productId ? { productId: batch.productId } : {}),
      },
      select: {
        id: true,
        batchNumber: true,
        actualContentGrams: true,
        nominalContentGrams: true,
        createdAt: true,
        packedFromBatchId: true,
        productSku: { select: { id: true, skuCode: true, weightGrams: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    });

    return NextResponse.json({
      batchNumber: batch.batchNumber,
      status: batch.status,
      availableGrams: gramsFromKg(batch.roastedAvailableKg),
      openPartials: partials.map((p) => ({
        lotId: p.id,
        batchNumber: p.batchNumber,
        skuId: p.productSku?.id ?? null,
        skuCode: p.productSku?.skuCode ?? "—",
        actualGrams: p.actualContentGrams ?? 0,
        nominalGrams: p.nominalContentGrams ?? Math.round(p.productSku?.weightGrams ?? 0),
        // True when the package was first filled from THIS roast. A top-up from another
        // roast of the same coffee is legitimate, so this informs rather than restricts.
        fromThisBatch: p.packedFromBatchId === batch.id,
      })),
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}
