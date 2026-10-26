// QC station W3 — the exception request («طلب استثناء», station Q4) and its decision in the ERP
// (Production › Quality «طلبات الاستثناء», QX-01…06). Owner decisions 3 and 4:
//   · only a HELD batch, outside its APPROVED spec (or with a defect / sensory not «مطابق»), never one
//     held for foreign objects / contamination (server-enforced: FOREIGN_OBJECT_NO_EXCEPTION);
//   · the request records the reason, the quantity (the whole held quantity — split first by a
//     disposition), the permitted use and a snapshot of the measurements;
//   · the decider holds qc › approve_exception (privileged: a verified individual, a fresh step-up —
//     checked by the route), is NEVER the requester and NEVER the inspector of the inspection (here,
//     and by the table's CHECK); the decision is idempotent (decisionKey) and conditional;
//   · approval releases the batch through the QC release workflow (applyQcDecision Passed, with the
//     QEX reference and the permitted use); a pending or rejected request changes nothing — the
//     batch stays «محجوزة».
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { readQcSettings } from "@/lib/services/settings/sections";
import { applyQcDecision } from "@/lib/services/qc-finalize";
import { autoPrepareAfterBatches } from "@/lib/services/orders/preparation";
import { EXCEPTION_REASONS, EXCEPTION_REASON_WORD, PERMITTED_USES, QC_HOLD_STATUS, sodBlock, type ExceptionReason, type PermittedUse, type SpecSnapshot } from "@/lib/qc/spec";
import { refuse } from "./profiles";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = { id: string; name: string };
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** QEX-2026-0004 / QDP-2026-0001: per calendar year, under an advisory lock (no duplicate numbers). */
export async function nextNumber(tx: Prisma.TransactionClient, prefix: "QEX" | "QDP"): Promise<string> {
  const year = new Date().getUTCFullYear();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7763, ${prefix === "QEX" ? 1 : 2}::int)`;
  const like = `${prefix}-${year}-%`;
  const rows = prefix === "QEX"
    ? await tx.$queryRaw<{ n: number | null }[]>`SELECT max(substring("number" from 10)::int) AS n FROM "QcException" WHERE "number" LIKE ${like}`
    : await tx.$queryRaw<{ n: number | null }[]>`SELECT max(substring("number" from 10)::int) AS n FROM "QcDisposition" WHERE "number" LIKE ${like}`;
  return `${prefix}-${year}-${String((rows[0]?.n ?? 0) + 1).padStart(4, "0")}`;
}

/** The measurements of the inspection a request is about (what the reviewer reads in QX-02). */
export async function measurementsOf(db: Db, recordId: string) {
  const r = await db.qcRecord.findUnique({
    where: { id: recordId },
    select: { id: true, createdAt: true, colorWhole: true, colorGround: true, wholeVerdict: true, groundVerdict: true, wholeDevice: true, wholeScale: true, groundDevice: true, groundScale: true, defectUneven: true, defectScorched: true, defectPale: true, defectForeign: true, sensoryResult: true, sensoryNotes: true, lossPct: true, holdReasons: true, specSnapshot: true, cuppingScore: true, moisturePct: true, densityGL: true, employeeId: true, employee: { select: { name: true } } },
  });
  if (!r) return null;
  return {
    recordId: r.id, at: r.createdAt.toISOString(), inspectorId: r.employeeId, inspectorName: r.employee?.name ?? null, spec: r.specSnapshot as SpecSnapshot | null,
    whole: r.colorWhole, ground: r.colorGround, wholeVerdict: r.wholeVerdict, groundVerdict: r.groundVerdict,
    wholeDevice: r.wholeDevice, wholeScale: r.wholeScale, groundDevice: r.groundDevice, groundScale: r.groundScale,
    defects: { uneven: !!r.defectUneven, scorched: !!r.defectScorched, pale: !!r.defectPale, foreign: !!r.defectForeign },
    sensory: r.sensoryResult, sensoryNotes: r.sensoryNotes, lossPct: r.lossPct, holdReasons: (r.holdReasons as string[] | null) ?? [],
    cuppingScore: r.cuppingScore, moisturePct: r.moisturePct, densityGL: r.densityGL,
  };
}

export const FOREIGN_NO_EXCEPTION = () => refuse(409, "FOREIGN_OBJECT_NO_EXCEPTION", "حُجزت الدفعة لأجسام غريبة / تلوث: لا يُفرج عنها باستثناء تجاري. الطريق: إعادة الفحص بعد التنظيف أو الإتلاف.", "Held for foreign objects / contamination: no commercial exception can release it. Re-inspect after cleaning, or destroy it.");

/** Request an exception for a held batch (the inspector at the station, or QC in the ERP: qc › create_record). */
export async function requestException(actor: Actor, key: string, raw: Record<string, unknown>, opts: { stationId?: string | null } = {}) {
  const prior = await prisma.qcException.findUnique({ where: { requestKey: key }, select: { id: true, batchId: true } });
  const batchId = typeof raw.batchId === "string" ? raw.batchId : "";
  if (prior) {
    if (prior.batchId !== batchId) throw refuse(422, "IDEMPOTENCY_KEY_REUSED", "مفتاح التكرار استُخدم لطلب مختلف.", "This Idempotency-Key was used for a different request.");
    return { ...(await exceptionView(prior.id))!, replayed: true };
  }
  const reason = raw.reason as ExceptionReason;
  if (!EXCEPTION_REASONS.includes(reason)) throw refuse(400, "REASON_REQUIRED", "اختر سبب الطلب.", "Choose the reason for the request.");
  const reasonNote = text(raw.reasonNote, 1000) || null;
  if (reason === "OTHER" && !reasonNote) throw refuse(400, "REASON_NOTE_REQUIRED", "اكتب السبب.", "Write the reason.");
  const use = raw.permittedUse as PermittedUse;
  if (!PERMITTED_USES.includes(use)) throw refuse(400, "USE_REQUIRED", "اختر الاستخدام المسموح.", "Choose the permitted use.");
  const useNote = text(raw.permittedUseNote, 500) || null;
  if (use === "CUSTOMER" && !useNote) throw refuse(400, "USE_NOTE_REQUIRED", "اكتب العميل وموافقته.", "Name the customer and their approval.");
  const id = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "RoastingBatch" WHERE "id" = ${batchId} FOR UPDATE`;
    const b = await tx.roastingBatch.findUnique({ where: { id: batchId }, select: { id: true, batchNumber: true, status: true, roastedAvailableKg: true, qcHoldRecordId: true, qcHoldForeignObject: true, product: { select: { productNameAr: true, productNameEn: true } } } });
    if (!b) throw refuse(404, "NOT_FOUND", "الدفعة غير موجودة.", "Batch not found.");
    if (b.status !== QC_HOLD_STATUS || !b.qcHoldRecordId) throw refuse(409, "NOT_HELD", "طلب الاستثناء لدفعة محجوزة فقط.", "An exception is requested for a held batch only.");
    if (b.qcHoldForeignObject) throw FOREIGN_NO_EXCEPTION();
    const m = await measurementsOf(tx, b.qcHoldRecordId);
    if (!m) throw refuse(409, "NO_INSPECTION", "لا يوجد فحص للدفعة.", "The batch has no inspection.");
    if (m.defects.foreign) throw FOREIGN_NO_EXCEPTION();
    if (m.spec?.state !== "APPROVED") throw refuse(409, "SPEC_NOT_APPROVED", "الاستثناء على مواصفة معتمدة فقط. المواصفة قيد المعايرة: أعد الفحص أو قرّر التصرف.", "An exception applies to an approved spec only. Under calibration: re-inspect or decide a disposition.");
    if (await tx.qcDisposition.count({ where: { batchId, status: { in: ["PENDING", "APPROVED"] } } })) throw refuse(409, "DECISION_PENDING", "على الدفعة تصرف قيد القرار.", "A disposition is pending on this batch.");
    if (await tx.qcException.count({ where: { batchId, status: "PENDING" } })) throw refuse(409, "EXCEPTION_PENDING", "على الدفعة طلب استثناء قيد القرار.", "An exception request is already pending on this batch.");
    const available = Math.round(b.roastedAvailableKg * 1000) / 1000;
    const qty = raw.quantityKg === undefined || raw.quantityKg === null || raw.quantityKg === "" ? available : Number(raw.quantityKg);
    if (!(qty > 0) || Math.abs(qty - available) > 0.001) {
      throw refuse(400, "QUANTITY_WHOLE", `الاستثناء يشمل الكمية المحجوزة كلها (${available.toFixed(2)} كغ). أتلف الجزء الآخر أو اخلطه أولًا بقرار تصرف.`, `The exception covers the whole held quantity (${available.toFixed(2)} kg). Destroy or blend the rest first by a disposition.`);
    }
    const number = await nextNumber(tx, "QEX");
    const e = await tx.qcException.create({
      data: {
        number, batchId, qcRecordId: m.recordId, inspectorId: m.inspectorId, inspectorName: m.inspectorName, reason, reasonNote, quantityKg: available, permittedUse: use, permittedUseNote: useNote,
        measurementsSnapshot: m as unknown as Prisma.InputJsonValue, requestedById: actor.id, requestedByName: actor.name, stationId: opts.stationId ?? null, requestKey: key,
      },
    });
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, {
      event: "quality.exception_requested", dedupeKey: e.id, actorId: actor.id, exclude: [m.inspectorId], entity: { type: "QcException", id: e.id },
      facts: { number, batchNumber: b.batchNumber, productName: b.product?.productNameAr || b.product?.productNameEn || "", productNameEn: b.product?.productNameEn || "", reasonAr: EXCEPTION_REASON_WORD[reason].ar, reasonEn: EXCEPTION_REASON_WORD[reason].en, requesterName: actor.name, exceptionId: e.id },
    });
    return e.id;
  }, TX_OPTS);
  return { ...(await exceptionView(id))!, replayed: false };
}

export const SOD_REFUSAL = (who: "requester" | "inspector") => who === "requester"
  ? refuse(403, "SOD_OWN_REQUEST", "قدّمت هذا الطلب، فلا يمكنك اعتماده أو رفضه. يقرّره شخص آخر.", "You made this request, so you cannot decide it. Someone else decides it.")
  : refuse(403, "SOD_OWN_INSPECTION", "أنت من فحص هذه الدفعة، فلا يمكنك قرار استثنائها. يقرّره شخص آخر.", "You inspected this batch, so you cannot decide its exception. Someone else decides it.");

export { sodBlock };

/** Approve / reject (the route has checked qc › approve_exception, identity and step-up). */
export async function decideException(actor: Actor, id: string, raw: Record<string, unknown>, decisionKey: string | null) {
  const decision = raw.decision === "APPROVE" ? "APPROVED" : raw.decision === "REJECT" ? "REJECTED" : null;
  if (!decision) throw refuse(400, "DECISION_REQUIRED", "اختر القرار.", "Choose the decision.");
  const reason = text(raw.reason, 1000);
  if (reason.length < 3) throw refuse(400, "DECISION_REASON_REQUIRED", "سبب القرار مطلوب.", "A decision reason is required.");
  let releasedBatch: string | null = null;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "QcException" WHERE "id" = ${id} FOR UPDATE`;
    const e = await tx.qcException.findUnique({ where: { id }, include: { batch: { select: { id: true, batchNumber: true, status: true, orderItemId: true, productionOrderId: true, qcHoldForeignObject: true } } } });
    if (!e) throw refuse(404, "NOT_FOUND", "الطلب غير موجود.", "Request not found.");
    const block = sodBlock(actor.id, e);
    if (block) throw SOD_REFUSAL(block);
    if (e.status !== "PENDING") {
      if (decisionKey && e.decisionKey === decisionKey) return; // replay: the stored decision answers
      throw refuse(409, "ALREADY_DECIDED", `قُرّر هذا الطلب (${e.status === "APPROVED" ? "اعتُمد" : e.status === "REJECTED" ? "رُفض" : "سُحب"}) بواسطة ${e.decidedByName ?? "—"}. لا يتكرر الإفراج.`, `This request was already decided (${e.status}) by ${e.decidedByName ?? "—"}.`);
    }
    const now = new Date();
    if (decision === "APPROVED") {
      if (e.batch.status !== QC_HOLD_STATUS) throw refuse(409, "NOT_HELD", "الدفعة لم تعد محجوزة.", "The batch is no longer held.");
      if (e.batch.qcHoldForeignObject || (e.measurementsSnapshot as { defects?: { foreign?: boolean } })?.defects?.foreign) throw FOREIGN_NO_EXCEPTION();
      await tx.$queryRaw`SELECT "id" FROM "RoastingBatch" WHERE "id" = ${e.batchId} FOR UPDATE`;
      const { effectiveMinEvaluators: min } = await readQcSettings(tx);
      const applied = await applyQcDecision(tx, {
        batch: { id: e.batch.id, status: QC_HOLD_STATUS, orderItemId: e.batch.orderItemId ?? null, productionOrderId: e.batch.productionOrderId, batchNumber: e.batch.batchNumber },
        outcome: "Passed", check: { ok: true, overrideApplied: false, decisionReason: `مقبولة باستثناء ${e.number}: ${reason}`.slice(0, 500), overrideReason: null }, min, actor,
      });
      if (!applied.decided) throw refuse(409, "NOT_HELD", "الدفعة لم تعد محجوزة.", "The batch is no longer held.");
      await tx.roastingBatch.update({ where: { id: e.batchId }, data: { qcExceptionId: e.id, qcPermittedUse: e.permittedUse } });
      releasedBatch = e.batchId;
    }
    await tx.qcException.update({ where: { id }, data: { status: decision, decidedById: actor.id, decidedByName: actor.name, decisionReason: reason, decidedAt: now, decisionKey } });
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, { event: "quality.exception_decided", dedupeKey: `${id}:${decision}`, actorId: actor.id, people: { requester: e.requestedById }, entity: { type: "QcException", id }, facts: { number: e.number, status: decision, batchNumber: e.batch.batchNumber, deciderName: actor.name, exceptionId: id } });
  }, TX_OPTS);
  if (releasedBatch) await autoPrepareAfterBatches([releasedBatch], "qc_decision", actor);
  return exceptionView(id);
}

export async function exceptionView(id: string) {
  const e = await prisma.qcException.findUnique({
    where: { id },
    include: { batch: { select: { id: true, batchNumber: true, status: true, roastedAvailableKg: true, roastedBeanQuantity: true, createdAt: true, roasterId: true, qcExceptionId: true, productionOrder: { select: { productionNumber: true } }, product: { select: { productNameEn: true, productNameAr: true } }, greenBean: { select: { serialNumber: true, beanType: true, beanTypeAr: true, country: true, countryAr: true } }, orderItem: { select: { order: { select: { orderNumber: true } }, productSku: { select: { product: { select: { productNameEn: true, productNameAr: true } } } } } } } } },
  });
  if (!e) return null;
  const roaster = e.batch.roasterId ? await prisma.roaster.findUnique({ where: { id: e.batch.roasterId }, select: { name: true } }) : null;
  const p = e.batch.product ?? e.batch.orderItem?.productSku?.product ?? null;
  return {
    id: e.id, number: e.number, status: e.status, reason: e.reason, reasonNote: e.reasonNote, quantityKg: e.quantityKg, permittedUse: e.permittedUse, permittedUseNote: e.permittedUseNote,
    measurements: e.measurementsSnapshot as Awaited<ReturnType<typeof measurementsOf>>, requestedById: e.requestedById, requestedByName: e.requestedByName, inspectorId: e.inspectorId, inspectorName: e.inspectorName,
    stationId: e.stationId, createdAt: e.createdAt.toISOString(), decidedById: e.decidedById, decidedByName: e.decidedByName, decisionReason: e.decisionReason, decidedAt: e.decidedAt?.toISOString() ?? null,
    batch: {
      id: e.batch.id, batchNumber: e.batch.batchNumber, status: e.batch.status, availableKg: e.batch.roastedAvailableKg, roastedKg: e.batch.roastedBeanQuantity, roastedAt: e.batch.createdAt.toISOString(),
      nameEn: p?.productNameEn ?? e.batch.greenBean?.beanType ?? "", nameAr: p?.productNameAr ?? e.batch.greenBean?.beanTypeAr ?? null, orderNumber: e.batch.orderItem?.order?.orderNumber ?? null,
      productionNumber: e.batch.productionOrder?.productionNumber ?? null, green: e.batch.greenBean, roaster: roaster?.name ?? null, releasedByThis: e.batch.qcExceptionId === e.id,
    },
  };
}

export async function listExceptions() {
  const rows = await prisma.qcException.findMany({ orderBy: [{ createdAt: "desc" }], take: 200, select: { id: true } });
  const all = await Promise.all(rows.map((r) => exceptionView(r.id)));
  const list = all.filter((x): x is NonNullable<typeof x> => !!x);
  return { pending: list.filter((x) => x.status === "PENDING"), decided: list.filter((x) => x.status !== "PENDING") };
}
