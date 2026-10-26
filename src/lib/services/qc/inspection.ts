// QC station W3 — the inspection («فحص بالقياس», Q1–Q6) and its outcome (owner decisions 1–3).
//
// One inspection = one QcRecord of kind INSPECTION by the signed-in inspector (name, time and batch
// recorded by the server), with: whole and ground readings (number + device + scale), the visible
// defects, the sensory result (+ notes), optional cupping score / moisture / density, the roast loss
// copied from the batch for reference, and a SNAPSHOT of the spec it was judged against. The server
// computes the colour verdicts against that snapshot and decides:
//   · conforming → release («مقبولة · متاحة للتعبئة», today's QC pass: applyQcDecision Passed) once
//     the batch has the QC minimum of evaluator records (Settings › QC, owner decision D1); below it
//     the inspection is recorded «مطابقة · بانتظار مقيّم آخر» and the batch stays «بانتظار الجودة»;
//   · otherwise → HOLD («محجوزة», status "QC Hold"). Never an automatic rejection. A foreign-object
//     hold is flagged: no commercial exception can release it.
// Sensory is required (server-side) for the first batch of the profile each Riyadh day and for a
// deviating batch. Re-inspection of a held batch is a new record (history kept); after a foreign-
// object hold it needs the cleaning done, written. Idempotent by Idempotency-Key (W1 pattern).
import { createHash } from "node:crypto";
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { readQcSettings } from "@/lib/services/settings/sections";
import { applyQcDecision } from "@/lib/services/qc-finalize";
import { autoPrepareAfterBatches } from "@/lib/services/orders/preparation";
import {
  DEFAULT_DEVICE, DEFAULT_SCALE, HOLD_REASON_WORD, QC_HOLD_STATUS, SENSORY_RESULTS, judgeInspection, lossPercent, parseOptional, parseReading, riyadhDay,
  type Defects, type HoldReason, type SensoryResult, type SpecSnapshot, type Verdict,
} from "@/lib/qc/spec";
import { batchProductId, refuse, specForBatch } from "./profiles";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = { id: string; name: string };

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const kg3 = (v: number) => Math.round(v * 1000) / 1000;

/** The batch fields every QC read needs. */
const BATCH_SELECT = {
  id: true, batchNumber: true, status: true, date: true, createdAt: true, updatedAt: true, qcDeadline: true, isBlend: true,
  greenBeanQuantity: true, roastedBeanQuantity: true, roastedAvailableKg: true, productId: true, orderItemId: true, productionOrderId: true, greenBeanId: true,
  profileVersionId: true, roasterId: true, qcHoldAt: true, qcHoldRecordId: true, qcHoldForeignObject: true, qcExceptionId: true, qcPermittedUse: true, convertedFromProductId: true,
  product: { select: { id: true, productNameEn: true, productNameAr: true } },
  greenBean: { select: { serialNumber: true, beanType: true, beanTypeAr: true, country: true, countryAr: true, process: true, processAr: true } },
  orderItem: { select: { id: true, beanTypeName: true, productSku: { select: { productId: true, product: { select: { productNameEn: true, productNameAr: true } } } }, order: { select: { orderNumber: true } } } },
} satisfies Prisma.RoastingBatchSelect;
type BatchRow = Prisma.RoastingBatchGetPayload<{ select: typeof BATCH_SELECT }>;

function nameOf(b: BatchRow) {
  const p = b.product ?? b.orderItem?.productSku?.product ?? null;
  const green = b.greenBean;
  return { nameEn: p?.productNameEn ?? green?.beanType ?? b.orderItem?.beanTypeName ?? b.batchNumber, nameAr: p?.productNameAr ?? green?.beanTypeAr ?? null };
}

function riyadhDayStart(now = new Date()): Date {
  return new Date(`${riyadhDay(now)}T00:00:00+03:00`);
}

/** Has an inspection of this profile (or, under calibration, this product) already recorded a sensory result today? */
export async function sensoryDoneToday(db: Db, spec: SpecSnapshot, productId: string | null, now = new Date()): Promise<boolean> {
  const since = riyadhDayStart(now);
  const base: Prisma.QcRecordWhereInput = { kind: "INSPECTION", sensoryResult: { not: null }, createdAt: { gte: since } };
  if (spec.profileId) {
    const n = await db.qcRecord.count({ where: { ...base, specSnapshot: { path: ["profileId"], equals: spec.profileId } } });
    return n > 0;
  }
  if (!productId) return false;
  const n = await db.qcRecord.count({ where: { ...base, batch: { OR: [{ productId }, { orderItem: { productSku: { productId } } }] } } });
  return n > 0;
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────
export type QueueBatch = {
  id: string; batchNumber: string; status: string; nameEn: string; nameAr: string | null; roastedKg: number; availableKg: number;
  orderNumber: number | null; qcDeadline: string | null; recordedAt: string; records: number; accepts: number; specState: "APPROVED" | "CALIBRATING" | "UNKNOWN"; isBlend: boolean;
};
export type HeldBatch = QueueBatch & {
  heldAt: string | null; foreign: boolean; reasons: HoldReason[]; inspectorName: string | null;
  exception: { id: string; number: string; status: string } | null; disposition: { id: string; number: string; kind: string; status: string } | null;
};

function queueRow(b: BatchRow & { qcRecords: { decision: string }[] }): QueueBatch {
  return {
    id: b.id, batchNumber: b.batchNumber, status: b.status, ...nameOf(b), roastedKg: kg3(b.roastedBeanQuantity), availableKg: kg3(b.roastedAvailableKg),
    orderNumber: b.orderItem?.order?.orderNumber ?? null, qcDeadline: b.qcDeadline?.toISOString() ?? null, recordedAt: b.createdAt.toISOString(),
    records: b.qcRecords.length, accepts: b.qcRecords.filter((r) => r.decision === "Accept").length, specState: b.profileVersionId ? "APPROVED" : "CALIBRATING", isBlend: b.isBlend,
  };
}

/** Q1 / Q5 / Q6: batches awaiting QC (by the 48 h deadline), held batches, the last 7 days of confirmed inspections. */
export async function qcStationQueue() {
  const [pending, held, history, settings] = await Promise.all([
    prisma.roastingBatch.findMany({ where: { status: "Pending QC" }, select: { ...BATCH_SELECT, qcRecords: { select: { decision: true } } }, orderBy: [{ qcDeadline: "asc" }, { createdAt: "asc" }], take: 100 }),
    prisma.roastingBatch.findMany({
      where: { status: QC_HOLD_STATUS }, orderBy: [{ qcHoldAt: "asc" }],
      select: { ...BATCH_SELECT, qcRecords: { select: { decision: true } }, qcExceptions: { where: { status: "PENDING" }, select: { id: true, number: true, status: true }, take: 1 }, qcDispositions: { where: { status: { in: ["PENDING", "APPROVED"] } }, select: { id: true, number: true, kind: true, status: true }, take: 1 } },
      take: 100,
    }),
    prisma.qcRecord.findMany({
      where: { kind: "INSPECTION", createdAt: { gte: new Date(Date.now() - 7 * 86400_000) } }, orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, createdAt: true, outcome: true, holdReasons: true, colorWhole: true, colorGround: true, wholeVerdict: true, groundVerdict: true, employee: { select: { name: true } }, batch: { select: BATCH_SELECT } },
    }),
    readQcSettings(prisma),
  ]);
  const holdRecords = await prisma.qcRecord.findMany({ where: { id: { in: held.map((b) => b.qcHoldRecordId).filter((x): x is string => !!x) } }, select: { id: true, holdReasons: true, employee: { select: { name: true } } } });
  const holdBy = new Map(holdRecords.map((r) => [r.id, r]));
  return {
    pending: pending.map(queueRow),
    held: held.map((b): HeldBatch => {
      const r = b.qcHoldRecordId ? holdBy.get(b.qcHoldRecordId) : undefined;
      return {
        ...queueRow(b), heldAt: b.qcHoldAt?.toISOString() ?? null, foreign: b.qcHoldForeignObject === true, reasons: (r?.holdReasons as HoldReason[] | null) ?? [], inspectorName: r?.employee?.name ?? null,
        exception: b.qcExceptions[0] ?? null, disposition: b.qcDispositions[0] ?? null,
      };
    }),
    history: history.map((h) => ({
      id: h.id, at: h.createdAt.toISOString(), outcome: h.outcome, reasons: (h.holdReasons as HoldReason[] | null) ?? [], whole: h.colorWhole, ground: h.colorGround,
      wholeVerdict: h.wholeVerdict, groundVerdict: h.groundVerdict, inspector: h.employee?.name ?? null, batchId: h.batch.id, batchNumber: h.batch.batchNumber, ...nameOf(h.batch),
    })),
    minEvaluators: settings.effectiveMinEvaluators,
    serverTime: new Date().toISOString(),
  };
}

/** Q2 / Q3: one batch — facts, the spec it is judged against, loss (reference), earlier records, whether sensory is due today. */
export async function qcBatchDetail(batchId: string) {
  const b = await prisma.roastingBatch.findUnique({
    where: { id: batchId },
    select: {
      ...BATCH_SELECT,
      qcRecords: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true, kind: true, createdAt: true, decision: true, outcome: true, colorWhole: true, colorGround: true, wholeVerdict: true, groundVerdict: true, wholeDevice: true, wholeScale: true, groundDevice: true, groundScale: true,
          defectUneven: true, defectScorched: true, defectPale: true, defectForeign: true, sensoryResult: true, sensoryNotes: true, sensoryRequiredWhy: true, holdReasons: true, manualDecision: true, manualNote: true,
          cuppingScore: true, moisturePct: true, densityGL: true, cleaningNote: true, remarks: true, testerName: true, isExternal: true, specSnapshot: true, employee: { select: { id: true, name: true } },
        },
      },
      qcExceptions: { orderBy: { createdAt: "desc" }, select: { id: true, number: true, status: true, reason: true, permittedUse: true, requestedByName: true, decidedByName: true, decisionReason: true, createdAt: true, decidedAt: true } },
      qcDispositions: { orderBy: { createdAt: "desc" }, select: { id: true, number: true, kind: true, status: true, quantityKg: true, reason: true, requestedByName: true, decidedByName: true, decisionReason: true, createdAt: true, decidedAt: true, blendBatchId: true } },
    },
  });
  if (!b) return null;
  const spec = await specForBatch(prisma, b);
  const productId = await batchProductId(prisma, b);
  const firstOfDay = !(await sensoryDoneToday(prisma, spec, productId));
  const roaster = b.roasterId ? await prisma.roaster.findUnique({ where: { id: b.roasterId }, select: { name: true } }) : null;
  const settings = await readQcSettings(prisma);
  return {
    batch: {
      id: b.id, batchNumber: b.batchNumber, status: b.status, ...nameOf(b), roastedKg: kg3(b.roastedBeanQuantity), greenKg: kg3(b.greenBeanQuantity), availableKg: kg3(b.roastedAvailableKg),
      lossPct: b.isBlend ? null : lossPercent(b.greenBeanQuantity, b.roastedBeanQuantity), roastedAt: b.createdAt.toISOString(), qcDeadline: b.qcDeadline?.toISOString() ?? null,
      orderNumber: b.orderItem?.order?.orderNumber ?? null, roaster: roaster?.name ?? null, isBlend: b.isBlend,
      green: b.greenBean ? { serialNumber: b.greenBean.serialNumber, nameEn: b.greenBean.beanType, nameAr: b.greenBean.beanTypeAr } : null,
      hold: b.status === QC_HOLD_STATUS ? { at: b.qcHoldAt?.toISOString() ?? null, recordId: b.qcHoldRecordId, foreign: b.qcHoldForeignObject === true } : null,
      exceptionId: b.qcExceptionId, permittedUse: b.qcPermittedUse, convertedFromProductId: b.convertedFromProductId,
    },
    spec,
    sensoryDueFirstOfDay: firstOfDay,
    minEvaluators: settings.effectiveMinEvaluators,
    records: b.qcRecords.map((r) => ({
      id: r.id, kind: r.kind, at: r.createdAt.toISOString(), decision: r.decision, outcome: r.outcome, whole: r.colorWhole, ground: r.colorGround, wholeVerdict: r.wholeVerdict as Verdict | null, groundVerdict: r.groundVerdict as Verdict | null,
      wholeDevice: r.wholeDevice, wholeScale: r.wholeScale, groundDevice: r.groundDevice, groundScale: r.groundScale,
      defects: { uneven: !!r.defectUneven, scorched: !!r.defectScorched, pale: !!r.defectPale, foreign: !!r.defectForeign } as Defects,
      sensory: r.sensoryResult as SensoryResult | null, sensoryNotes: r.sensoryNotes, sensoryWhy: r.sensoryRequiredWhy, reasons: (r.holdReasons as HoldReason[] | null) ?? [],
      manualDecision: r.manualDecision, manualNote: r.manualNote, cuppingScore: r.cuppingScore, moisturePct: r.moisturePct, densityGL: r.densityGL, cleaningNote: r.cleaningNote, remarks: r.remarks,
      by: r.isExternal ? r.testerName : r.employee?.name ?? r.testerName, byId: r.employee?.id ?? null, spec: r.specSnapshot as SpecSnapshot | null,
    })),
    exceptions: b.qcExceptions.map((e) => ({ ...e, createdAt: e.createdAt.toISOString(), decidedAt: e.decidedAt?.toISOString() ?? null })),
    dispositions: b.qcDispositions.map((d) => ({ ...d, createdAt: d.createdAt.toISOString(), decidedAt: d.decidedAt?.toISOString() ?? null })),
  };
}

// ── The inspection ───────────────────────────────────────────────────────────────────────────
export type InspectionBody = {
  batchId: string; whole: number | null; ground: number | null; wholeDevice: string; wholeScale: string; groundDevice: string; groundScale: string;
  defects: Defects; sensory: SensoryResult | null; sensoryNotes: string | null; manual: "ACCEPT" | "HOLD" | null; manualNote: string | null;
  cuppingScore: number | null; moisturePct: number | null; densityGL: number | null; cleaningNote: string | null;
};

/** The request body, normalised; a refusal for anything malformed. */
export function parseInspection(raw: Record<string, unknown>): InspectionBody {
  const batchId = typeof raw.batchId === "string" ? raw.batchId : "";
  if (!batchId) throw refuse(400, "BATCH_REQUIRED", "اختر الدفعة.", "batchId is required.");
  const w = parseReading(raw.whole), g = parseReading(raw.ground);
  if (!w.ok || !g.ok) throw refuse(400, "READING_INVALID", "القراءة رقم أكبر من 0 وحتى 200.", "A reading is a number above 0, up to 200.");
  const d = (raw.defects ?? {}) as Record<string, unknown>;
  const sensory = raw.sensory === null || raw.sensory === undefined || raw.sensory === "" ? null : SENSORY_RESULTS.includes(raw.sensory as SensoryResult) ? (raw.sensory as SensoryResult) : "INVALID";
  if (sensory === "INVALID") throw refuse(400, "SENSORY_INVALID", "نتيجة التقييم الحسي غير صالحة.", "Invalid sensory result.");
  const cup = parseOptional(raw.cuppingScore, 0, 100), moist = parseOptional(raw.moisturePct, 0, 100), dens = parseOptional(raw.densityGL, 1, 2000);
  if (!cup.ok || !moist.ok || !dens.ok) throw refuse(400, "OPTIONAL_INVALID", "قيمة غير صالحة في الحقول الإضافية.", "Invalid value in the additional fields.");
  const manual = raw.manual === "ACCEPT" || raw.manual === "HOLD" ? raw.manual : null;
  const dev = (v: unknown, dflt: string, max: number) => text(v, max) || dflt;
  return {
    batchId, whole: w.value, ground: g.value,
    wholeDevice: dev(raw.wholeDevice ?? raw.device, DEFAULT_DEVICE, 60), wholeScale: dev(raw.wholeScale ?? raw.scale, DEFAULT_SCALE, 40),
    groundDevice: dev(raw.groundDevice ?? raw.device, DEFAULT_DEVICE, 60), groundScale: dev(raw.groundScale ?? raw.scale, DEFAULT_SCALE, 40),
    defects: { uneven: d.uneven === true, scorched: d.scorched === true, pale: d.pale === true, foreign: d.foreign === true },
    sensory, sensoryNotes: text(raw.sensoryNotes, 1000) || null, manual, manualNote: text(raw.manualNote, 1000) || null,
    cuppingScore: cup.value, moisturePct: moist.value, densityGL: dens.value, cleaningNote: text(raw.cleaningNote, 1000) || null,
  };
}

export function inspectionIntentHash(b: InspectionBody): string {
  const v = [b.batchId, b.whole, b.ground, b.wholeDevice, b.wholeScale, b.groundDevice, b.groundScale, b.defects.uneven, b.defects.scorched, b.defects.pale, b.defects.foreign, b.sensory, b.manual, b.cuppingScore, b.moisturePct, b.densityGL];
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

const SENSORY_REQUIRED_AR: Record<string, string> = {
  FIRST_OF_DAY: "التقييم الحسي مطلوب: أول دفعة من هذا الملف اليوم.",
  DEVIATION: "التقييم الحسي مطلوب: الدفعة منحرفة (لون خارج الهدف أو عيب ظاهر).",
};
const SENSORY_REQUIRED_EN: Record<string, string> = {
  FIRST_OF_DAY: "A sensory evaluation is required: the first batch of this profile today.",
  DEVIATION: "A sensory evaluation is required: the batch deviates (colour off target or a visible defect).",
};

export type InspectionResult = {
  recordId: string; batchId: string; batchNumber: string; outcome: "RELEASED" | "HELD" | "AWAITING_EVALUATORS"; batchStatus: string;
  wholeVerdict: Verdict | null; groundVerdict: Verdict | null; holdReasons: HoldReason[]; foreign: boolean; specState: "APPROVED" | "CALIBRATING";
  at: string; inspector: string; availableKg: number; minEvaluators: number; records: number; replayed: boolean;
};

async function resultOf(recordId: string, replayed: boolean): Promise<InspectionResult> {
  const r = await prisma.qcRecord.findUniqueOrThrow({ where: { id: recordId }, select: { id: true, outcome: true, wholeVerdict: true, groundVerdict: true, holdReasons: true, defectForeign: true, specSnapshot: true, createdAt: true, employee: { select: { name: true } }, batch: { select: { id: true, batchNumber: true, status: true, roastedAvailableKg: true, _count: { select: { qcRecords: true } } } } } });
  const settings = await readQcSettings(prisma);
  return {
    recordId: r.id, batchId: r.batch.id, batchNumber: r.batch.batchNumber, outcome: r.outcome as InspectionResult["outcome"], batchStatus: r.batch.status,
    wholeVerdict: r.wholeVerdict as Verdict | null, groundVerdict: r.groundVerdict as Verdict | null, holdReasons: (r.holdReasons as HoldReason[] | null) ?? [], foreign: r.defectForeign === true,
    specState: (r.specSnapshot as SpecSnapshot).state, at: r.createdAt.toISOString(), inspector: r.employee?.name ?? "", availableKg: kg3(r.batch.roastedAvailableKg),
    minEvaluators: settings.effectiveMinEvaluators, records: r.batch._count.qcRecords, replayed,
  };
}

/**
 * Record one inspection (station or ERP; the caller has run its guard: qc › create_record). Replays
 * by key; refuses a decided batch, a pending exception / disposition, a missing sensory result when
 * required, and a re-inspection after a foreign-object hold without the cleaning written.
 */
export async function recordInspection(actor: Actor, key: string, raw: Record<string, unknown>, opts: { stationId?: string | null } = {}): Promise<InspectionResult> {
  const body = parseInspection(raw);
  const intentHash = inspectionIntentHash(body);
  const prior = await prisma.qcRecord.findUnique({ where: { requestKey: key }, select: { id: true, intentHash: true } });
  if (prior) {
    if (prior.intentHash !== intentHash) throw refuse(422, "IDEMPOTENCY_KEY_REUSED", "مفتاح التكرار استُخدم لفحص مختلف.", "This Idempotency-Key was used for a different inspection.");
    return resultOf(prior.id, true);
  }
  let released = false;
  const recordId = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "RoastingBatch" WHERE "id" = ${body.batchId} FOR UPDATE`;
    const b = await tx.roastingBatch.findUnique({ where: { id: body.batchId }, select: { ...BATCH_SELECT, _count: { select: { qcRecords: true } } } });
    if (!b) throw refuse(404, "NOT_FOUND", "الدفعة غير موجودة.", "Batch not found.");
    const held = b.status === QC_HOLD_STATUS;
    if (b.status !== "Pending QC" && !held) throw refuse(409, "BATCH_DECIDED", "قُرّرت جودة هذه الدفعة. لا يُسجَّل فحص جديد.", "This batch's QC is decided; no new inspection is recorded.");
    if (held) {
      const open = await tx.qcException.count({ where: { batchId: b.id, status: "PENDING" } }) + await tx.qcDisposition.count({ where: { batchId: b.id, status: { in: ["PENDING", "APPROVED"] } } });
      if (open) throw refuse(409, "DECISION_PENDING", "على الدفعة طلب استثناء أو تصرف قيد القرار. انتظر القرار قبل إعادة الفحص.", "An exception or disposition is pending on this batch; wait for it before re-inspecting.");
      if (b.qcHoldForeignObject && (!body.cleaningNote || body.cleaningNote.length < 3)) {
        throw refuse(422, "CLEANING_REQUIRED", "حُجزت الدفعة لأجسام غريبة: اكتب التنظيف الذي أُجري قبل إعادة الفحص.", "Held for foreign objects: write the cleaning done before re-inspecting.");
      }
    }
    const spec = await specForBatch(tx, b);
    const productId = await batchProductId(tx, b);
    const firstOfDay = !(await sensoryDoneToday(tx, spec, productId));
    const v = judgeInspection(spec, { whole: body.whole, ground: body.ground, defects: body.defects, sensory: body.sensory, manual: body.manual, manualNote: body.manualNote }, { firstOfDay });
    if (!v.ok) {
      if (v.code === "READINGS_REQUIRED") throw refuse(422, v.code, "أدخل قراءتي الحبوب والمطحون.", "Enter both the whole-bean and the ground reading.");
      if (v.code === "SENSORY_REQUIRED") throw { ...refuse(422, v.code, SENSORY_REQUIRED_AR[v.why ?? "DEVIATION"], SENSORY_REQUIRED_EN[v.why ?? "DEVIATION"]), why: v.why };
      if (v.code === "MANUAL_DECISION_REQUIRED") throw refuse(422, v.code, "المواصفة قيد المعايرة: اختر القبول أو الحجز يدويًا.", "The spec is under calibration: choose accept or hold by hand.");
      throw refuse(422, v.code, "المواصفة قيد المعايرة: اكتب سبب قرارك اليدوي.", "The spec is under calibration: document your manual decision.");
    }
    const settings = await readQcSettings(tx);
    const min = settings.effectiveMinEvaluators;
    const records = b._count.qcRecords + 1;
    const outcome: InspectionResult["outcome"] = v.hold ? "HELD" : records >= min ? "RELEASED" : "AWAITING_EVALUATORS";
    const loss = b.isBlend ? null : lossPercent(b.greenBeanQuantity, b.roastedBeanQuantity);
    const prevHold = held ? b.qcHoldRecordId : null;
    const rec = await tx.qcRecord.create({
      data: {
        batchId: b.id, kind: "INSPECTION", requestKey: key, intentHash, profileVersionId: spec.versionId, specSnapshot: spec as unknown as Prisma.InputJsonValue,
        coffeeOrigin: b.greenBean?.country ?? "", processing: b.greenBean?.process ?? "", serialNumber: b.greenBean?.serialNumber ?? b.batchNumber,
        colorWhole: body.whole, colorGround: body.ground, wholeDevice: body.wholeDevice, wholeScale: body.wholeScale, groundDevice: body.groundDevice, groundScale: body.groundScale,
        wholeVerdict: v.wholeVerdict, groundVerdict: v.groundVerdict,
        defectUneven: body.defects.uneven, defectScorched: body.defects.scorched, defectPale: body.defects.pale, defectForeign: body.defects.foreign,
        sensoryResult: body.sensory, sensoryNotes: body.sensoryNotes, sensoryRequired: v.sensoryWhy !== null, sensoryRequiredWhy: v.sensoryWhy,
        cuppingScore: body.cuppingScore, moisturePct: body.moisturePct, densityGL: body.densityGL, lossPct: loss,
        manualDecision: spec.state === "CALIBRATING" ? body.manual : null, manualNote: spec.state === "CALIBRATING" ? body.manualNote : null,
        outcome, holdReasons: v.holdReasons as unknown as Prisma.InputJsonValue, reinspectionOfId: prevHold, cleaningNote: held ? body.cleaningNote : null, stationId: opts.stationId ?? null,
        // The legacy panel fields: never inferred development from colour (onProfile = conforming).
        onProfile: v.conforming, underDeveloped: false, overDeveloped: false,
        remarks: body.manualNote ?? body.sensoryNotes, decision: v.conforming ? "Accept" : "Reject", employeeId: actor.id, isExternal: false, testerName: null,
      },
      select: { id: true },
    });
    if (outcome === "HELD") {
      const r = await tx.roastingBatch.updateMany({ where: { id: b.id, status: b.status }, data: { status: QC_HOLD_STATUS, qcHoldAt: new Date(), qcHoldRecordId: rec.id, qcHoldForeignObject: v.foreign } });
      if (r.count !== 1) throw refuse(409, "BATCH_CHANGED", "تغيّرت حالة الدفعة أثناء الفحص. أعد فتحها.", "The batch changed while you inspected it. Open it again.");
      const name = nameOf(b);
      const { notify } = await import("@/lib/notifications/notify");
      await notify(tx, {
        event: "quality.batch_held", dedupeKey: rec.id, actorId: actor.id, entity: { type: "RoastingBatch", id: b.id },
        facts: { batchNumber: b.batchNumber, productName: name.nameAr || name.nameEn, productNameEn: name.nameEn || name.nameAr, foreign: v.foreign ? 1 : "", inspectorName: actor.name, reasonsAr: v.holdReasons.map((x) => HOLD_REASON_WORD[x].ar).join("، "), reasonsEn: v.holdReasons.map((x) => HOLD_REASON_WORD[x].en).join(", ") },
      });
    } else if (outcome === "RELEASED") {
      const applied = await applyQcDecision(tx, {
        batch: { id: b.id, status: b.status, orderItemId: b.orderItemId, productionOrderId: b.productionOrderId, batchNumber: b.batchNumber },
        outcome: "Passed", check: { ok: true, overrideApplied: false, decisionReason: held ? `إعادة فحص مطابقة (${rec.id})` : null, overrideReason: null }, min, actor,
      });
      if (!applied.decided) throw refuse(409, "BATCH_CHANGED", "تغيّرت حالة الدفعة أثناء الفحص. أعد فتحها.", "The batch changed while you inspected it. Open it again.");
      released = true;
    }
    return rec.id;
  }, TX_OPTS);
  if (released) await autoPrepareAfterBatches([body.batchId], "qc_decision", actor);
  return resultOf(recordId, false);
}

/**
 * The legacy panel decision (POST /api/qc/[batchId]/finalize, bulk-finalize) must not pass around
 * an approved spec: a batch roasted to an APPROVED version passes only when its latest inspection
 * was conforming. Batches without a version (every batch before W3, profiles still in calibration)
 * keep the panel exactly as before.
 */
export async function specBlocksPanelPass(db: Db, batchId: string): Promise<string | null> {
  const b = await db.roastingBatch.findUnique({ where: { id: batchId }, select: { profileVersionId: true, batchNumber: true } });
  if (!b?.profileVersionId) return null;
  const last = await db.qcRecord.findFirst({ where: { batchId, kind: "INSPECTION" }, orderBy: { createdAt: "desc" }, select: { outcome: true } });
  if (last && last.outcome !== "HELD") return null;
  return b.batchNumber;
}
