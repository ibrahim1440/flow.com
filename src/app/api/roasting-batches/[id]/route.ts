import { flushPostings } from "@/lib/accounting/ops/cost-ledger";
import { assertBatchesNotHeld } from "@/lib/services/qc/hold-guard";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub, stockChangeGate } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { normalizeAdjustmentReason } from "@/lib/services/inventory-adjustment";
import { auditPrivilegedInventory } from "@/lib/services/inventory-privileged-audit";
import { audit } from "@/lib/hr/core";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";
import { onRoastCancelled } from "@/lib/accounting/ops/inventory-events";
import { batchProductId } from "@/lib/services/qc/profiles";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Params) {
  const { error, user } = await requireSub("production", "cancel_batch");
  if (error) return error;

  const { id } = await params;
  const url = new URL(request.url);
  const { searchParams } = url;

  // Reviews F5 / N4: the restock flag is judged strictly. Absent → cancel without restock; exactly one
  // `restock=true` / `restock=false` in the query → that. Anything else — another spelling (`TRUE`,
  // `1`, `yes`), any other key containing "restock" (`Restock`, `restock[]`, `restock%00`), the key
  // twice, or a "restock" key anywhere in the body (nested too) — is a 400, never a silent cancel
  // without the restock the caller may have meant.
  const INVALID_RESTOCK = () => NextResponse.json({
    error: "قيمة إعادة المخزون غير صالحة: استخدم restock=true أو restock=false فقط.",
    errorEn: "Invalid restock flag: use restock=true or restock=false only (once, in the query string).",
    code: "INVALID_RESTOCK_FLAG",
  }, { status: 400 });
  // Review N4: any key that merely CONTAINS "restock" — `restock[]`, `restock%00`, `Restock`, `x_restock`
  // — is refused, not ignored; so is one nested anywhere in the body.
  const mentionsRestock = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "").includes("restock");
  const keys = [...searchParams.keys()];
  if (keys.some((k) => mentionsRestock(k) && k !== "restock")) return INVALID_RESTOCK();
  const flags = searchParams.getAll("restock");
  if (flags.length > 1 || (flags.length === 1 && flags[0] !== "true" && flags[0] !== "false")) return INVALID_RESTOCK();
  const restock = flags[0] === "true";
  let body: Record<string, unknown> = {};
  const text = await request.text().catch(() => "");
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
  }
  const nestedRestock = (v: unknown, depth = 0): boolean =>
    depth > 8 ? true : Array.isArray(v) ? v.some((x) => nestedRestock(x, depth + 1))
      : !!v && typeof v === "object" && Object.entries(v as Record<string, unknown>).some(([k, x]) => mentionsRestock(k) || nestedRestock(x, depth + 1));
  if (nestedRestock(body)) return INVALID_RESTOCK();

  // Restocking after roasting requires the inventory.override permission — judged before any
  // lookup. Owner decisions (16 / 17 Oct): an inventory override is a privileged stock change, so it
  // also needs a verified individual, approval evidence, a username + PIN session and a fresh PIN
  // step-up, admins included (stockChangeGate). Cancelling WITHOUT restock stays on
  // production › cancel_batch, and is audited below (review F6).
  if (restock) {
    const refused = await stockChangeGate(user!, "inventory", "override");
    if (refused) return refused;
  }
  // An override needs its reason, like an adjustment (owner decision, inventory Option A): JSON
  // body { reason } (or ?reason=), at least 8 characters. Checked after the permission, so a caller
  // without it is told the truth about privilege first. Without restock the reason is optional and
  // recorded when given.
  const rawReason: unknown = searchParams.get("reason") || body.reason;
  let overrideReason = "";
  if (restock) {
    const explained = normalizeAdjustmentReason(rawReason);
    if (!explained.ok) {
      return NextResponse.json({
        error: "يلزم سبب لا يقل عن 8 أحرف لإعادة البن الأخضر إلى المخزون (تجاوز المخزون).",
        errorEn: "Restocking a cancelled roast is an inventory override: a reason of 8 to 500 characters is required.",
        code: "OVERRIDE_REASON_REQUIRED",
      }, { status: 400 });
    }
    overrideReason = explained.reason;
  }
  const cancelReason = restock ? overrideReason : (typeof rawReason === "string" && rawReason.trim() ? rawReason.trim().slice(0, 500) : null);

  const batch = await prisma.roastingBatch.findUnique({
    where: { id },
    select: { orderItemId: true, greenBeanId: true, greenBeanQuantity: true, roastedBeanQuantity: true, productionOrderId: true, batchNumber: true, productId: true },
  });

  if (!batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }


  try { await prisma.$transaction(async (tx) => {
    // 0. Lock the batch, then refuse to delete one that has packaging history.
    //
    // PackagingOperation.batchId is ON DELETE RESTRICT, so the database would stop this
    // anyway — but it would stop it with a foreign-key violation, which reaches the
    // operator as a generic "a related record is still referenced". The guard exists to
    // answer in the language of the domain instead: once coffee has physically been packed
    // out of a roast, the roast is part of the audit trail and is no longer a thing that
    // can be made to have never happened. Correcting a pack is a reversal, which this wave
    // deliberately does not implement; deletion is simply refused.
    //
    // The lock is what makes the guard race-free rather than advisory. Packaging holds
    // this same row FOR UPDATE for its whole transaction, so a pack committing concurrently
    // is either already visible to the count below, or still waiting — and once it waits,
    // it finds the batch gone and answers 404 rather than packing into a deleted roast.
    // Taking RoastingBatch first also matches the canonical hierarchy, which puts it above
    // the green-bean restock that follows.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "RoastingBatch" WHERE "id" = ${id} FOR UPDATE
    `;
    if (locked.length === 0) throw { _appCode: 404, message: "Batch not found" };
    // QC W3: a held batch is not cancelled away — its disposition (destroy, convert, blend, exception)
    // is decided in QC, by another person, and logged (hold-guard.ts).
    await assertBatchesNotHeld(tx, [id], "delete");
    // Its QC history (inspections, exceptions, dispositions) is the audit trail: such a batch stays.
    if ((await tx.qcException.count({ where: { batchId: id } })) + (await tx.qcDisposition.count({ where: { batchId: id } })) > 0) {
      throw { _appCode: 409, message: "للدفعة سجل استثناء أو تصرف في الجودة، فلا تُحذف.", errorEn: "The batch has a QC exception or disposition record, so it cannot be deleted." };
    }

    const packagedCount = await tx.packagingOperation.count({ where: { batchId: id } });
    if (packagedCount > 0) {
      throw {
        _appCode: 409,
        message: "Batch cannot be deleted because packaging operations exist.",
      };
    }

    // Blend lineage is destroyed silently, not loudly. BlendIngredient cascades from BOTH
    // ends — sourceBatchId and targetBlendBatchId — so deleting either a batch that
    // contributed coffee to a blend, or the blend it went into, takes the rows recording the
    // transformation with it. No foreign key objects, because a cascade is not a refusal:
    // the delete simply succeeds and the record of where several batches' coffee went stops
    // existing.
    //
    // Checked under the same FOR UPDATE taken above, which is what makes it race-safe rather
    // than advisory. Blend creation locks its sources FOR UPDATE before inserting any
    // ingredient row, so a blend committing concurrently is either already visible to this
    // count, or still waiting on this lock — and once it waits, it finds the batch gone and
    // answers "One or more batches not found" instead of blending a deleted roast.
    const blendLinks = await tx.blendIngredient.count({
      where: { OR: [{ sourceBatchId: id }, { targetBlendBatchId: id }] },
    });
    if (blendLinks > 0) {
      throw {
        _appCode: 409,
        message: "Batch cannot be deleted because it is part of blend history.",
      };
    }

    // 1. Restock green beans if requested
    if (restock && batch.greenBeanId && batch.greenBeanQuantity > 0) {
      const bean = await tx.greenBean.findUnique({
        where: { id: batch.greenBeanId },
        select: { quantityKg: true },
      });
      const previousQuantity = bean!.quantityKg;

      await tx.greenBean.update({
        where: { id: batch.greenBeanId },
        data: { quantityKg: { increment: batch.greenBeanQuantity } },
      });

      const movement = await tx.inventoryMovement.create({
        data: {
          type: "IN",
          category: "RAW_MATERIAL",
          referenceEntityId: batch.greenBeanId,
          quantityChanged: batch.greenBeanQuantity,
          previousQuantity,
          newQuantity: previousQuantity + batch.greenBeanQuantity,
          sourceDocType: "ROASTING_BATCH",
          sourceDocId: id,
          userId: user!.id,
          notes: `Batch Cancellation Restock — ${overrideReason}`,
        },
      });
      await auditPrivilegedInventory(tx, user!, {
        action: "INVENTORY_OVERRIDE_RESTOCK", entityType: "RoastingBatch", entityId: id, reason: overrideReason,
        beforeQuantity: previousQuantity, afterQuantity: previousQuantity + batch.greenBeanQuantity, unit: "kg",
        details: { movementId: movement.id, greenBeanId: batch.greenBeanId, restockedKg: batch.greenBeanQuantity, previousQuantity, newQuantity: previousQuantity + batch.greenBeanQuantity },
      });
    }

    // 1b. Review F6: every cancellation is audited in this transaction — who, which batch, the green
    // coffee it consumed and whether it went back to stock or is written off, the roasted output
    // lost, and the reason (required for a restock, optional otherwise).
    const restocked = restock && !!batch.greenBeanId && batch.greenBeanQuantity > 0;
    // Accounting A3: the green comes back at its original cost (and what the roast expensed is credited back), or
    // the roasted stock left is written off — before the batch row goes.
    const restockMovement = restocked ? await tx.inventoryMovement.findFirst({ where: { sourceDocType: "ROASTING_BATCH", sourceDocId: id, type: "IN", category: "RAW_MATERIAL" }, orderBy: { timestamp: "desc" }, select: { id: true } }) : null;
    await onRoastCancelled(tx, { batchId: id, batchNumber: batch.batchNumber, greenBeanId: batch.greenBeanId, greenKg: batch.greenBeanQuantity, restock: restocked, productId: await batchProductId(tx, { productId: batch.productId, orderItemId: batch.orderItemId }), reason: cancelReason, actor: user!.id, movementId: restockMovement?.id ?? null });
    await audit(tx, {
      action: "ROASTING_BATCH_CANCELLED", entityType: "RoastingBatch", entityId: id, actorId: user!.id,
      reason: cancelReason,
      before: { greenBeanId: batch.greenBeanId, greenKgConsumed: batch.greenBeanQuantity, roastedKg: batch.roastedBeanQuantity, batchNumber: batch.batchNumber },
      after: { restocked, greenKgReturned: restocked ? batch.greenBeanQuantity : 0, greenKgWrittenOff: restocked ? 0 : batch.greenBeanQuantity, roastedKgWrittenOff: batch.roastedBeanQuantity, login: { id: user!.id, sessionId: user!.sessionId ?? null } },
    });

    // 2. Delete batch (QcRecords cascade via schema onDelete: Cascade)
    await tx.roastingBatch.delete({ where: { id } });

    // 3. Recalculate order item and production order status after deletion.
    // A stock batch has no order item whose production status could change.
    if (batch.orderItemId) await recalcOrderItemStatus(batch.orderItemId, tx);

    if (batch.productionOrderId) {
      await recalcProductionOrderStatus(batch.productionOrderId, tx);
    }
    await flushPostings(tx);
  });

  return NextResponse.json({ success: true });
  } catch (err) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string; errorEn?: string; code?: string };
      return NextResponse.json({ error: e.message, ...(e.errorEn ? { errorEn: e.errorEn } : {}), ...(e.code ? { code: e.code } : {}) }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
