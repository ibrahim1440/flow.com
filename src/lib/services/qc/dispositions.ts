// QC station W3 — the disposition of a held batch other than re-inspection and exception (owner
// decision 5; UR-S19: the disposal decision is another person's):
//   · CONVERT  to another product — only when the batch's last inspection meets THAT product's
//              APPROVED spec (computed by the server, stored as `conformity`), then approved; on
//              approval the batch becomes the target product (its order line, if any, is released —
//              the line wanted the other coffee) and is released through the QC workflow;
//   · BLEND    only by an approved recipe: the held quantity and the partner batches (released,
//              not held, not blends) are fixed in the request; once approved, production records
//              the blend through the existing blend route (production › blend) with this
//              disposition — the inputs must match the recipe; the sources are traced
//              (BlendIngredient) and the OUTPUT goes to QC («بانتظار الجودة»);
//   · DESTROY  reason and quantity; on approval the roasted coffee leaves through a LOSS ·
//              ROASTED_COFFEE movement (the existing write-off path: applyQcDecision Rejected for
//              the whole remainder, the same LOSS movement for a part); fully destroyed → «مرفوضة».
// Never CONVERT or BLEND a batch held for foreign objects (blending never hides a defect it cannot
// clean). Requested by QC (qc › manage); decided by qc › dispose (privileged, step-up — the route),
// never by the requester nor the inspector of the hold.
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { readQcSettings } from "@/lib/services/settings/sections";
import { applyQcDecision } from "@/lib/services/qc-finalize";
import { autoPrepareAfterBatches } from "@/lib/services/orders/preparation";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";
import { DISPOSITION_KINDS, DISPOSITION_WORD, QC_HOLD_STATUS, meetsSpec, snapshotOf, type DispositionKind, type SensoryResult } from "@/lib/qc/spec";
import { batchProductId, refuse, resolveApprovedVersionId, VERSION_SELECT } from "./profiles";
import { measurementsOf, nextNumber, sodBlock } from "./exceptions";

type Actor = { id: string; name: string };
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const kg3 = (v: number) => Math.round(v * 1000) / 1000;
export type RecipeLine = { batchId: string; batchNumber: string; quantityKg: number };
export type Recipe = { heldQuantityKg: number; partners: RecipeLine[] };

const SOD = (who: "requester" | "inspector") => who === "requester"
  ? refuse(403, "SOD_OWN_REQUEST", "طلبت هذا التصرف، فلا يمكنك اعتماده أو رفضه.", "You requested this disposition, so you cannot decide it.")
  : refuse(403, "SOD_OWN_INSPECTION", "أنت من فحص هذه الدفعة وحجزها، فلا يمكنك قرار التصرف فيها (فصل المهام).", "You inspected and held this batch, so you cannot decide its disposition (separation of duties).");

export async function requestDisposition(actor: Actor, key: string, raw: Record<string, unknown>) {
  const prior = await prisma.qcDisposition.findUnique({ where: { requestKey: key }, select: { id: true, batchId: true } });
  const batchId = typeof raw.batchId === "string" ? raw.batchId : "";
  if (prior) {
    if (prior.batchId !== batchId) throw refuse(422, "IDEMPOTENCY_KEY_REUSED", "مفتاح التكرار استُخدم لطلب مختلف.", "This Idempotency-Key was used for a different request.");
    return { id: prior.id, replayed: true };
  }
  const kind = raw.kind as DispositionKind;
  if (!DISPOSITION_KINDS.includes(kind)) throw refuse(400, "KIND_REQUIRED", "اختر نوع التصرف.", "Choose the disposition.");
  const reason = text(raw.reason, 1000);
  if (reason.length < 3) throw refuse(400, "REASON_REQUIRED", "اكتب السبب.", "Write the reason.");
  const id = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "RoastingBatch" WHERE "id" = ${batchId} FOR UPDATE`;
    const b = await tx.roastingBatch.findUnique({ where: { id: batchId }, select: { id: true, batchNumber: true, status: true, roastedAvailableKg: true, qcHoldRecordId: true, qcHoldForeignObject: true, productId: true, orderItemId: true, greenBeanId: true } });
    if (!b) throw refuse(404, "NOT_FOUND", "الدفعة غير موجودة.", "Batch not found.");
    if (b.status !== QC_HOLD_STATUS) throw refuse(409, "NOT_HELD", "التصرف لدفعة محجوزة فقط.", "A disposition is for a held batch only.");
    if (b.qcHoldForeignObject && kind !== "DESTROY") throw refuse(409, "FOREIGN_OBJECT_NO_CONVERT", "حُجزت الدفعة لأجسام غريبة / تلوث: لا تحويل ولا خلط. الطريق: إعادة الفحص بعد التنظيف أو الإتلاف.", "Held for foreign objects / contamination: no conversion or blend. Re-inspect after cleaning, or destroy it.");
    if (await tx.qcDisposition.count({ where: { batchId, status: { in: ["PENDING", "APPROVED"] } } })) throw refuse(409, "DECISION_PENDING", "على الدفعة تصرف قيد القرار.", "A disposition is already pending on this batch.");
    if (await tx.qcException.count({ where: { batchId, status: "PENDING" } })) throw refuse(409, "EXCEPTION_PENDING", "على الدفعة طلب استثناء قيد القرار.", "An exception request is pending on this batch.");
    const available = kg3(b.roastedAvailableKg);
    const m = b.qcHoldRecordId ? await measurementsOf(tx, b.qcHoldRecordId) : null;
    const data: Prisma.QcDispositionUncheckedCreateInput = {
      number: "", batchId, qcRecordId: m?.recordId ?? null, inspectorId: m?.inspectorId ?? null, kind, quantityKg: available, reason,
      requestedById: actor.id, requestedByName: actor.name, requestKey: key,
    };
    if (kind === "DESTROY") {
      const q = raw.quantityKg === undefined || raw.quantityKg === "" || raw.quantityKg === null ? available : Number(raw.quantityKg);
      if (!(q > 0) || q > available + 0.0005) throw refuse(400, "QUANTITY_INVALID", `الكمية بين 0 و${available.toFixed(2)} كغ.`, `The quantity is between 0 and ${available.toFixed(2)} kg.`);
      data.quantityKg = kg3(Math.min(q, available));
    } else if (kind === "CONVERT") {
      const target = typeof raw.targetProductId === "string" ? raw.targetProductId : "";
      const current = await batchProductId(tx, b);
      if (!target || target === current) throw refuse(400, "TARGET_REQUIRED", "اختر منتجًا آخر للتحويل.", "Choose another product to convert to.");
      const versionId = await resolveApprovedVersionId(tx, target, b.greenBeanId);
      if (!versionId) throw refuse(409, "TARGET_NOT_APPROVED", "لا مواصفة معتمدة للمنتج الهدف. لا يُحوَّل إلا إلى منتج له مواصفة معتمدة.", "The target product has no approved spec; a batch converts only to a product with one.");
      const v = await tx.roastProfileVersion.findUniqueOrThrow({ where: { id: versionId }, select: VERSION_SELECT });
      const spec = snapshotOf(v);
      if (!m) throw refuse(409, "NO_INSPECTION", "لا يوجد فحص للدفعة.", "The batch has no inspection.");
      const c = meetsSpec(spec, { whole: m.whole, ground: m.ground, defects: m.defects, sensory: m.sensory as SensoryResult | null });
      if (!c.ok) throw { ...refuse(409, "CONVERT_NOT_CONFORMING", "قراءات الدفعة لا تطابق مواصفة المنتج الهدف المعتمدة. لا يُحوَّل.", "The batch's readings do not meet the target product's approved spec."), conformity: c };
      data.targetProductId = target; data.targetVersionId = versionId;
      data.conformity = { ...c, spec, whole: m.whole, ground: m.ground } as unknown as Prisma.InputJsonValue;
    } else {
      const heldQ = Number(raw.heldQuantityKg ?? available);
      if (!(heldQ > 0) || heldQ > available + 0.0005) throw refuse(400, "QUANTITY_INVALID", `كمية الدفعة المحجوزة في الوصفة بين 0 و${available.toFixed(2)} كغ.`, `The held quantity in the recipe is between 0 and ${available.toFixed(2)} kg.`);
      const partnersRaw = Array.isArray(raw.partners) ? (raw.partners as Record<string, unknown>[]) : [];
      if (!partnersRaw.length) throw refuse(400, "RECIPE_REQUIRED", "الوصفة تحتاج دفعة مقبولة واحدة على الأقل للخلط معها.", "The recipe needs at least one released batch to blend with.");
      const partners: RecipeLine[] = [];
      for (const p of partnersRaw) {
        const pid = typeof p.batchId === "string" ? p.batchId : "";
        const q = Number(p.quantityKg);
        const pb = pid ? await tx.roastingBatch.findUnique({ where: { id: pid }, select: { id: true, batchNumber: true, status: true, isBlend: true, roastedAvailableKg: true } }) : null;
        if (!pb || pb.id === batchId) throw refuse(400, "RECIPE_INVALID", "دفعة غير صالحة في الوصفة.", "A recipe batch is not valid.");
        if (pb.status !== "Passed" || pb.isBlend) throw refuse(409, "RECIPE_PARTNER_NOT_RELEASED", `الدفعة ${pb.batchNumber} ليست مقبولة: الخلط مع دفعات مقبولة فقط، لا مع محجوزة أو بانتظار الجودة أو خلطات.`, `Batch ${pb.batchNumber} is not released: blend only with released batches.`);
        if (!(q > 0) || q > pb.roastedAvailableKg + 0.0005) throw refuse(400, "QUANTITY_INVALID", `كمية الدفعة ${pb.batchNumber} غير صالحة.`, `Invalid quantity for batch ${pb.batchNumber}.`);
        partners.push({ batchId: pb.id, batchNumber: pb.batchNumber, quantityKg: kg3(q) });
      }
      data.quantityKg = kg3(heldQ);
      data.recipe = { heldQuantityKg: kg3(heldQ), partners } as unknown as Prisma.InputJsonValue;
    }
    data.number = await nextNumber(tx, "QDP");
    const d = await tx.qcDisposition.create({ data });
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, {
      event: "quality.disposition_requested", dedupeKey: d.id, actorId: actor.id, exclude: [m?.inspectorId], entity: { type: "QcDisposition", id: d.id },
      facts: { number: d.number, batchNumber: b.batchNumber, kindAr: DISPOSITION_WORD[kind].ar, kindEn: DISPOSITION_WORD[kind].en, quantityKg: d.quantityKg.toFixed(2), reason },
    });
    return d.id;
  }, TX_OPTS);
  return { id, replayed: false };
}

/** Approve / reject a disposition (the route checked qc › dispose, identity and step-up). DESTROY and CONVERT execute on approval. */
export async function decideDisposition(actor: Actor, id: string, raw: Record<string, unknown>) {
  const decision = raw.decision === "APPROVE" ? "APPROVED" : raw.decision === "REJECT" ? "REJECTED" : null;
  if (!decision) throw refuse(400, "DECISION_REQUIRED", "اختر القرار.", "Choose the decision.");
  const reason = text(raw.reason, 1000);
  if (reason.length < 3) throw refuse(400, "DECISION_REASON_REQUIRED", "سبب القرار مطلوب.", "A decision reason is required.");
  let released: string | null = null;
  const out = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "QcDisposition" WHERE "id" = ${id} FOR UPDATE`;
    const d = await tx.qcDisposition.findUnique({ where: { id } });
    if (!d) throw refuse(404, "NOT_FOUND", "الطلب غير موجود.", "Request not found.");
    const block = sodBlock(actor.id, d);
    if (block) throw SOD(block);
    if (d.status !== "PENDING") throw refuse(409, "ALREADY_DECIDED", `قُرّر هذا الطلب (${d.status}) بواسطة ${d.decidedByName ?? "—"}.`, `This request was already decided (${d.status}).`);
    const now = new Date();
    const decided = { decidedById: actor.id, decidedByName: actor.name, decisionReason: reason, decidedAt: now };
    const { notify } = await import("@/lib/notifications/notify");
    const kind = d.kind as DispositionKind;
    const say = async (status: string) => {
      const b = await tx.roastingBatch.findUnique({ where: { id: d.batchId }, select: { batchNumber: true } });
      await notify(tx, { event: "quality.disposition_decided", dedupeKey: `${id}:${status}`, actorId: actor.id, people: { requester: d.requestedById }, entity: { type: "QcDisposition", id }, facts: { status, batchNumber: b?.batchNumber ?? "", kindAr: DISPOSITION_WORD[kind].ar, kindEn: DISPOSITION_WORD[kind].en, deciderName: actor.name } });
    };
    if (decision === "REJECTED") {
      await tx.qcDisposition.update({ where: { id }, data: { status: "REJECTED", ...decided } });
      await say("REJECTED");
      return { status: "REJECTED" };
    }
    await tx.$queryRaw`SELECT "id" FROM "RoastingBatch" WHERE "id" = ${d.batchId} FOR UPDATE`;
    const b = await tx.roastingBatch.findUniqueOrThrow({ where: { id: d.batchId }, select: { id: true, batchNumber: true, status: true, roastedAvailableKg: true, orderItemId: true, productionOrderId: true, productId: true, qcHoldForeignObject: true, greenBeanId: true } });
    if (b.status !== QC_HOLD_STATUS) throw refuse(409, "NOT_HELD", "الدفعة لم تعد محجوزة.", "The batch is no longer held.");
    const { effectiveMinEvaluators: min } = await readQcSettings(tx);
    if (kind === "BLEND") {
      if (b.qcHoldForeignObject) throw refuse(409, "FOREIGN_OBJECT_NO_CONVERT", "حُجزت الدفعة لأجسام غريبة: لا خلط.", "Held for foreign objects: no blend.");
      await tx.qcDisposition.update({ where: { id }, data: { status: "APPROVED", ...decided } });
      await say("APPROVED");
      return { status: "APPROVED" };
    }
    if (kind === "DESTROY") {
      const available = kg3(b.roastedAvailableKg);
      const qty = Math.min(d.quantityKg, available);
      let movementId: string | null = null;
      if (qty >= available - 0.0005) {
        // The whole remainder: the existing QC write-off (LOSS · ROASTED_COFFEE, status «مرفوضة»).
        const applied = await applyQcDecision(tx, { batch: { id: b.id, status: QC_HOLD_STATUS, orderItemId: b.orderItemId, productionOrderId: b.productionOrderId, batchNumber: b.batchNumber }, outcome: "Rejected", check: { ok: true, overrideApplied: false, decisionReason: `إتلاف ${d.number}: ${d.reason}`.slice(0, 500), overrideReason: null }, min, actor });
        if (!applied.decided) throw refuse(409, "NOT_HELD", "الدفعة لم تعد محجوزة.", "The batch is no longer held.");
        movementId = (await tx.inventoryMovement.findFirst({ where: { referenceEntityId: b.id, type: "LOSS", category: "ROASTED_COFFEE" }, orderBy: { timestamp: "desc" }, select: { id: true } }))?.id ?? null;
      } else if (qty > 0) {
        // A part: the same LOSS movement; the rest stays held.
        await tx.roastingBatch.update({ where: { id: b.id }, data: { roastedAvailableKg: kg3(available - qty) } });
        const mv = await tx.inventoryMovement.create({
          data: { type: "LOSS", category: "ROASTED_COFFEE", referenceEntityId: b.id, quantityChanged: -qty, previousQuantity: available, newQuantity: kg3(available - qty), sourceDocType: "ROASTING_BATCH", sourceDocId: b.id, userId: actor.id, notes: `QC disposal ${d.number} of held batch ${b.batchNumber}: ${d.reason}`.slice(0, 1000) },
        });
        movementId = mv.id;
      }
      await tx.qcDisposition.update({ where: { id }, data: { status: "EXECUTED", ...decided, executedAt: now, executedById: actor.id, movementId, quantityKg: qty > 0 ? qty : d.quantityKg } });
      await say("APPROVED");
      return { status: "EXECUTED", destroyedKg: qty, movementId };
    }
    // CONVERT: re-check against the target's CURRENT approved version (it may have changed since the request).
    const versionId = await resolveApprovedVersionId(tx, d.targetProductId, b.greenBeanId);
    if (!versionId) throw refuse(409, "TARGET_NOT_APPROVED", "لا مواصفة معتمدة للمنتج الهدف الآن.", "The target product has no approved spec now.");
    const v = await tx.roastProfileVersion.findUniqueOrThrow({ where: { id: versionId }, select: VERSION_SELECT });
    const m = d.qcRecordId ? await measurementsOf(tx, d.qcRecordId) : null;
    const c = m ? meetsSpec(snapshotOf(v), { whole: m.whole, ground: m.ground, defects: m.defects, sensory: m.sensory as SensoryResult | null }) : { ok: false };
    if (!c.ok) throw refuse(409, "CONVERT_NOT_CONFORMING", "قراءات الدفعة لا تطابق مواصفة المنتج الهدف المعتمدة الآن.", "The batch's readings do not meet the target's current approved spec.");
    const fromProduct = await batchProductId(tx, b);
    await tx.roastingBatch.update({ where: { id: b.id }, data: { productId: d.targetProductId, profileVersionId: versionId, convertedFromProductId: fromProduct, orderItemId: null, productionOrderId: null } });
    // The order line / production order wanted the other coffee: their progress is recomputed without it.
    if (b.orderItemId) await recalcOrderItemStatus(b.orderItemId, tx);
    if (b.productionOrderId) await recalcProductionOrderStatus(b.productionOrderId, tx);
    const applied = await applyQcDecision(tx, { batch: { id: b.id, status: QC_HOLD_STATUS, orderItemId: null, productionOrderId: null, batchNumber: b.batchNumber }, outcome: "Passed", check: { ok: true, overrideApplied: false, decisionReason: `حُوّلت ${d.number}: ${reason}`.slice(0, 500), overrideReason: null }, min, actor });
    if (!applied.decided) throw refuse(409, "NOT_HELD", "الدفعة لم تعد محجوزة.", "The batch is no longer held.");
    await tx.qcDisposition.update({ where: { id }, data: { status: "EXECUTED", ...decided, executedAt: now, executedById: actor.id, targetVersionId: versionId } });
    await say("APPROVED");
    released = b.id;
    return { status: "EXECUTED" };
  }, TX_OPTS);
  if (released) await autoPrepareAfterBatches([released], "qc_decision", actor);
  return { id, ...out };
}

/**
 * The blend route's check (POST /api/roasting-batches/blend): a held source is accepted only with an
 * APPROVED BLEND disposition of that batch whose recipe the request matches exactly. Returns the
 * disposition to mark EXECUTED with the output, or throws.
 */
export async function approvedBlendFor(tx: Prisma.TransactionClient, heldIds: string[], dispositionId: string | null, requested: { batchId: string; quantityKg: number | null }[]) {
  const fail = (ar: string, en: string, code = "BLEND_RECIPE_REQUIRED") => refuse(409, code, ar, en);
  if (heldIds.length !== 1 || !dispositionId) throw fail("دفعة محجوزة لا تُخلط إلا بوصفة معتمدة من الجودة (قرار تصرف «خلط»).", "A held batch is blended only by a QC-approved recipe (a BLEND disposition).");
  const d = await tx.qcDisposition.findUnique({ where: { id: dispositionId } });
  if (!d || d.kind !== "BLEND" || d.status !== "APPROVED" || d.batchId !== heldIds[0]) throw fail("الوصفة غير معتمدة لهذه الدفعة.", "No approved recipe for this batch.");
  const recipe = d.recipe as unknown as Recipe;
  const want = new Map<string, number>([[d.batchId, recipe.heldQuantityKg], ...recipe.partners.map((p) => [p.batchId, p.quantityKg] as [string, number])]);
  const got = new Map(requested.map((r) => [r.batchId, r.quantityKg]));
  const same = want.size === got.size && [...want].every(([k, q]) => got.has(k) && got.get(k) !== null && Math.abs((got.get(k) as number) - q) <= 0.0005);
  if (!same) throw fail("مكوّنات الخلط لا تطابق الوصفة المعتمدة (الدفعات والكميات).", "The blend inputs do not match the approved recipe (batches and quantities).", "BLEND_RECIPE_MISMATCH");
  return d;
}

export async function listHeld() {
  const rows = await prisma.qcDisposition.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map((d) => ({ ...d, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(), decidedAt: d.decidedAt?.toISOString() ?? null, executedAt: d.executedAt?.toISOString() ?? null }));
}
