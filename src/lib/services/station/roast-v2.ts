/**
 * «محطة التحميص v2» — P0, the accounting and data core (migration 20261223090000_roast_station_v2). No station UI yet.
 *
 * The floor:
 *   · Green is weighed in advance into numbered buckets (a prep session): each bucket is a real immediate StockTransfer from
 *     its site to «منطقة التحميص» (STAGING). A transfer posts nothing (same company, same inventory account).
 *   · A roast CHARGES one bucket into a V2 roaster (RoastRun CHARGED), then DROPS (DROPPED). Roast 1 drops to the cooler,
 *     roast 2 is charged; roast 1 goes to the bucket, roast 2 drops, roast 3 is charged; roast 1 is poured back with
 *     roast 2 and the two are weighed TOGETHER. So the second consecutive drop of the SAME coffee (the product) joins the
 *     first one's basket automatically; «سجّلها لحالها» seals a basket with one roast.
 *   · RECORD weighs a basket: one RoastingBatch (= lot, SINGLE | PAIR) with its roasts as children. The green leaves
 *     STAGING per bucket component (one OUT movement and one cost-out each, lineKey bucket:<id>), ONE GREEN_ISSUED entry
 *     crediting each lot, ONE COMPLETED entry on the lot totals (loss and abnormal loss on the lot): the lot's cost is
 *     the weighted cost across its green lots.
 *   · DISCARD (burnt): the run is DISCARDED, no batch; its green leaves staging and its full cost is expensed at once to
 *     ROAST_DISCARD. A supervisor reviews it within 24 h — never the discarding operator.
 *
 * Owner decisions held here:
 *   · A drop is NEVER refused. The gate is on CHARGE: while more than UNWEIGHED_LIMIT dropped roasts of the roaster are
 *     unweighed, the next charge is refused (409 BASKET_NEEDS_WEIGHING). With the floor's rhythm that is "the 4th roast
 *     cannot be charged while the first two are unweighed" (at the 3rd charge roasts 1 and 2 are dropped and unweighed —
 *     that is the normal pipeline, so it passes). Checked under a per-roaster advisory lock; one roast in the drum and a
 *     bucket charged once are database guards (partial unique indexes).
 *   · Undo works for UNDO_WINDOW_MS by server time, only while nothing is posted: a charge, or a drop. A recorded lot or a
 *     discard is posted, so it is never undone (a correction cancels and re-records).
 *   · Unpairing only before weighing. One green lot per bucket. One operator may run two roasters (no per-operator rule:
 *     the V1 claim rule ONE_ACTIVE_ROAST does not apply to V2 roasters, which never use claims).
 *   · Leftover buckets stay in staging (flagged after STALE_BUCKET_HOURS) and go back with a reverse transfer. A re-weigh
 *     after the label is printed is an ADJUSTMENT at staging; a spill is a write-off.
 *   · Weighted lot cost across green lots; a warning when their unit costs differ by more than COST_SPREAD_WARN.
 *
 * Idempotency: bucket save (GreenBucket.requestKey), charge / drop / discard (RoastRun.chargeKey / dropKey / discardKey),
 * record (RoastingBatch.requestKey + intentHash over the basket, its runs, the weight and the allocations). A replay of
 * the same key answers with what it did; the same key for something else is a 422.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { setAuditContext, type AuditContext } from "@/lib/accounting/audit";
import { ipHashOf } from "@/lib/accounting/ops/purchase-activity";
import { writeSettingsAudit } from "@/lib/services/settings/audit";
import { flushPostings, lockHolders } from "@/lib/accounting/ops/cost-ledger";
import { onRoastCancelled, onRoastDiscard, onRoastLot, type RoastComponent } from "@/lib/accounting/ops/inventory-events";
import { Decimal } from "@/lib/accounting/money";
import { dayText, riyadhDay } from "@/lib/accounting/dates";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { assertAdminRoleGate } from "@/lib/auth-server";
import { STAGING_LOCATION_ID } from "@/lib/inventory/locations";
import { lossVerdict } from "@/lib/station/shared";
import { PROBLEM_TEXT_MAX, chargeBlockedBy, endNeedsTexts, maySetProblemMode, mayEndProblem, problemText } from "@/lib/station/v2/problem";
import { audit } from "@/lib/hr/core";
import { notify } from "@/lib/notifications/notify";
import { isAssignedOperator } from "@/lib/services/roaster-operators";
import { emitAutomationEvent } from "@/lib/automation/emit";
import { nextRoastBatchNumber } from "@/lib/services/batch-number";
import { batchProductId, resolveApprovedVersionId } from "@/lib/services/qc/profiles";
import { roastQueue } from "@/lib/services/roast-queue";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { advisoryKey, recalcProductionOrderStatus } from "@/lib/services/production-planning";
import { assertOrderStillAcceptsProduction, productionGateRefusal } from "@/lib/services/order-operations";
import { checkRoasterForRoast, logRoasterControls } from "@/lib/services/roaster-controls";
import { otherCoffeeCheck } from "@/lib/services/scan-lookup";
import { applyInventoryAdjustment } from "@/lib/services/inventory-adjustment";
import { createTransferTx } from "@/lib/services/stock-transfers";
import { assertLocationHas, productionLocation, setStockLocation } from "@/lib/services/stock-locations";

type Tx = Prisma.TransactionClient;
/** `stationRoasterId`: a paired station device works on its own roaster only (every floor action checks it). */
/** `supervisor`: the station assignment's «مشرف» flag on a paired device (D16: a report supervisor); absent at the desk. */
export type V2Actor = { id: string; name: string; role: string; permissions: Permissions; sessionId?: string; authTime?: Date | string; stationRoasterId?: string | null; supervisor?: boolean };

/** More than this many dropped, unweighed roasts on a roaster → the next charge is refused. */
export const UNWEIGHED_LIMIT = 2;
/**
 * The undo window (owner decision): a step is undone only while it is the roaster's LAST step — no later charge, drop,
 * weighing, «لحالها», unpair or discard on that roaster — and at most this long after it, by server time.
 */
export const UNDO_WINDOW_MS = 180_000;
export const DISCARD_ALERT_SAR = 500;
export const DISCARD_ALERT_PER_SHIFT = 2;
export const DISCARD_REVIEW_HOURS = 24;
export const STALE_BUCKET_HOURS = 72;
/** A charge back-dated to the first refused tap (R6) at most this far. */
export const CHARGE_BACKDATE_MAX_MS = 15 * 60_000;
export const COST_SPREAD_WARN = 0.15;
/** The label colours, one per coffee (stable: the same product always gets the same colour). */
export const BUCKET_COLORS = ["RED", "BLUE", "GREEN", "ORANGE", "PURPLE", "YELLOW", "PINK", "BROWN"] as const;

export type V2Fail = { _appCode: number; code: string; message: string; errorAr: string; errorEn: string } & Record<string, unknown>;
export const fail = (status: number, code: string, ar: string, en: string, extra: Record<string, unknown> = {}): V2Fail =>
  ({ _appCode: status, code, message: ar, errorAr: ar, errorEn: en, ...extra });

const r3 = (n: number) => +n.toFixed(3);
const num = (d: Decimal | Prisma.Decimal | number | string | null | undefined) => (d === null || d === undefined ? 0 : Number(d));
const KEY_RE = /^[A-Za-z0-9_-]{8,120}$/;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const kgOf = (raw: unknown, field: string): number => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 1000) throw fail(400, "KG_INVALID", `${field}: أدخل وزنًا موجبًا بالكيلو.`, `${field}: enter a positive weight in kg.`);
  return r3(n);
};
const textOf = (raw: unknown, min: number, max: number): string | null => {
  const t = typeof raw === "string" ? raw.trim().slice(0, max) : "";
  return t.length >= Math.max(1, min) ? t : null;
};
export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  return BUCKET_COLORS[Math.abs(h) % BUCKET_COLORS.length];
}
export function requireKey(key: unknown): string {
  if (typeof key !== "string" || !KEY_RE.test(key)) throw fail(400, "IDEMPOTENCY_KEY_REQUIRED", "مفتاح التكرار مطلوب لكل إجراء من المحطة.", "An Idempotency-Key is required for every station action.");
  return key;
}
const auditCtx = (actor: V2Actor, reason: string | null = null): AuditContext => ({ actorId: actor.id, ip: null, userAgent: "station-v2", reason });
/** The per-roaster lock: its own namespace (the one-argument 64-bit key space, keyed "roast-v2:roaster:<id>"). */
const roasterLock = (tx: Tx, roasterId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`roast-v2:roaster:${roasterId}`}, 0))`;

/** A paired device works on its own roaster only (403 STATION_ROASTER_MISMATCH). A personal session is not bound. */
function scoped(actor: V2Actor, roasterId: string) {
  if (actor.stationRoasterId && actor.stationRoasterId !== roasterId) {
    throw fail(403, "STATION_ROASTER_MISMATCH", "هذا الجهاز لحمّاصة أخرى.", "This device belongs to another roaster.");
  }
}

/**
 * The lock order every stock operation takes (gate M1): the GreenBean rows FIRST, in id order, and only then the cost
 * holders (lockHolders). The V1 roast and the transfers already lock in that order; a V2 lot, a discard and a correction
 * take the rows here before anything reads a holder, so two of them on the same green lot can never deadlock.
 */
async function lockGreenRows(tx: Tx, ids: string[]) {
  const uniq = [...new Set(ids)].sort();
  if (uniq.length) await tx.$queryRaw`SELECT "id" FROM "GreenBean" WHERE "id" = ANY(${uniq}::text[]) ORDER BY "id" FOR UPDATE`;
}

// ─── Prep: sessions and buckets ──────────────────────────────────────────────────────────────────

/** Open a weighing session (green from `sourceLocationId` — default the production site — to staging). */
export async function openPrepSession(actor: V2Actor, body: Record<string, unknown>) {
  const source = typeof body.sourceLocationId === "string" && body.sourceLocationId ? body.sourceLocationId : (await productionLocation(prisma)).id;
  if (source === STAGING_LOCATION_ID) throw fail(400, "PREP_SOURCE_INVALID", "اختر موقع البن الأخضر، لا منطقة التحميص.", "Choose the green coffee's site, not the staging area.");
  const site = await prisma.stockLocation.findUnique({ where: { id: source }, select: { id: true, isActive: true, type: true } });
  if (!site || !site.isActive || site.type === "TRANSIT") throw fail(404, "STOCK_LOCATION_NOT_FOUND", "الموقع غير موجود أو غير نشط.", "Location not found or inactive.");
  return prisma.greenPrepSession.create({
    data: { businessDay: riyadhDay(), operatorId: actor.id, operatorName: actor.name, sourceLocationId: source, stagingLocationId: STAGING_LOCATION_ID, note: textOf(body.note, 1, 300) },
  });
}

export async function closePrepSession(actor: V2Actor, sessionId: string) {
  const s = await prisma.greenPrepSession.findUnique({ where: { id: sessionId } });
  if (!s) throw fail(404, "PREP_SESSION_NOT_FOUND", "جلسة التجهيز غير موجودة.", "Prep session not found.");
  if (s.status === "CLOSED") return s;
  return prisma.greenPrepSession.update({ where: { id: sessionId }, data: { status: "CLOSED", closedAt: new Date() } });
}

const BUCKET_VIEW = { components: { select: { greenBeanId: true, kg: true } }, greenBean: { select: { id: true, serialNumber: true, labelCode: true } } } as const;

/**
 * «احفظ الدلو»: a bucket of `actualKg` of one green lot, moved to staging by a real immediate transfer — one commit.
 * Idempotent on the key (same lot and weight → the same bucket; anything else → 422).
 */
export async function saveBucket(actor: V2Actor, body: Record<string, unknown>, keyRaw: unknown) {
  const key = requireKey(keyRaw);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const greenBeanId = typeof body.greenBeanId === "string" ? body.greenBeanId : "";
  if (!sessionId || !greenBeanId) throw fail(400, "BUCKET_FIELDS_REQUIRED", "اختر الجلسة واللوت الأخضر.", "Choose the session and the green lot.");
  const actualKg = kgOf(body.actualKg, "الوزن");
  const plannedKg = body.plannedKg === undefined || body.plannedKg === null || body.plannedKg === "" ? null : kgOf(body.plannedKg, "الوزن المخطط");
  const productId = typeof body.productId === "string" && body.productId ? body.productId : null;
  const intent = hash({ sessionId, greenBeanId, actualKg, productId });
  const ctx = auditCtx(actor);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`green-bucket:${key}`}, 0))`;
    const twin = await tx.greenBucket.findUnique({ where: { requestKey: key }, include: BUCKET_VIEW });
    if (twin) {
      if (twin.sessionId !== sessionId || twin.greenBeanId !== greenBeanId || num(twin.actualKg) !== actualKg || (twin.productId ?? null) !== productId) {
        throw fail(422, "IDEMPOTENCY_MISMATCH", "استُخدم مفتاح التكرار لدلو آخر.", "This Idempotency-Key was used for another bucket.");
      }
      return { ...twin, replayed: true };
    }
    const session = (await tx.$queryRaw<{ id: string; status: string; sourceLocationId: string; stagingLocationId: string }[]>`
      SELECT "id", "status", "sourceLocationId", "stagingLocationId" FROM "GreenPrepSession" WHERE "id" = ${sessionId} FOR UPDATE`)[0];
    if (!session) throw fail(404, "PREP_SESSION_NOT_FOUND", "جلسة التجهيز غير موجودة.", "Prep session not found.");
    if (session.status !== "OPEN") throw fail(409, "PREP_SESSION_CLOSED", "جلسة التجهيز مغلقة. افتح جلسة جديدة.", "The prep session is closed. Open a new one.");
    const bean = await tx.greenBean.findUnique({ where: { id: greenBeanId }, select: { id: true, isActive: true, serialNumber: true } });
    if (!bean) throw fail(404, "GREEN_NOT_FOUND", "اللوت الأخضر غير موجود.", "Green lot not found.");
    if (!bean.isActive) throw fail(409, "GREEN_INACTIVE", "اللوت الأخضر غير نشط.", "The green lot is inactive.");
    const [{ max }] = await tx.$queryRaw<{ max: number | null }[]>`SELECT max("seqNo") AS max FROM "GreenBucket" WHERE "sessionId" = ${sessionId}`;
    const seqNo = (max ?? 0) + 1;
    const t = await createTransferTx(tx, {
      fromId: session.sourceLocationId, toId: session.stagingLocationId, mode: "IMMEDIATE", day: riyadhDay(),
      notes: `دلو ${seqNo} · تجهيز البن للتحميص`, requestKey: null,
      lines: [{ itemKind: "GREEN_BEAN", entityId: greenBeanId, qty: actualKg, notes: null }],
    }, actor, ctx);
    const bucket = await tx.greenBucket.create({
      data: {
        sessionId, seqNo, greenBeanId, productId, colorKey: typeof body.colorKey === "string" && body.colorKey ? body.colorKey.slice(0, 20) : colorFor(productId ?? greenBeanId),
        plannedKg, actualKg, locationId: session.stagingLocationId, transferId: t.id, requestKey: key, createdById: actor.id, createdByName: actor.name,
        components: { create: [{ greenBeanId, kg: actualKg }] },
      },
      include: BUCKET_VIEW,
    });
    await flushPostings(tx);
    return { ...bucket, intent, replayed: false };
  }, { ...TX_OPTS, timeout: 60_000 });
}

async function lockBucket(tx: Tx, bucketId: string) {
  const row = (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "GreenBucket" WHERE "id" = ${bucketId} OR "barcode" = ${bucketId} FOR UPDATE`)[0];
  if (!row) throw fail(404, "BUCKET_NOT_FOUND", "الدلو غير موجود.", "Bucket not found.");
  return tx.greenBucket.findUniqueOrThrow({ where: { id: row.id }, include: { ...BUCKET_VIEW, session: { select: { sourceLocationId: true } } } });
}

/** The label was printed (from now on a weight change is an adjustment, not a correction of the prep). */
export async function markLabelPrinted(bucketId: string) {
  const b = await prisma.greenBucket.findFirst({ where: { OR: [{ id: bucketId }, { barcode: bucketId }] }, select: { id: true, labelPrintedAt: true } });
  if (!b) throw fail(404, "BUCKET_NOT_FOUND", "الدلو غير موجود.", "Bucket not found.");
  if (b.labelPrintedAt) return b;
  return prisma.greenBucket.update({ where: { id: b.id }, data: { labelPrintedAt: new Date() }, select: { id: true, labelPrintedAt: true } });
}

/**
 * Re-weigh a prepared bucket: the difference is an ADJUSTMENT at staging (INVENTORY_VARIANCE at the moving average), the
 * bucket and its component take the new weight. A reason is required.
 */
export async function reweighBucket(actor: V2Actor, bucketId: string, body: Record<string, unknown>) {
  const actualKg = kgOf(body.actualKg, "الوزن");
  const reason = textOf(body.reason, 3, 200);
  if (!reason) throw fail(400, "REASON_REQUIRED", "اكتب سبب إعادة الوزن.", "Give the reason for the re-weigh.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor, reason));
    const b = await lockBucket(tx, bucketId);
    if (b.status !== "PREPARED") throw fail(409, "BUCKET_NOT_PREPARED", "لا يُعاد وزن دلو شُحن أو أُرجع.", "Only a prepared bucket is re-weighed.");
    const delta = r3(actualKg - num(b.actualKg));
    if (delta === 0) return { ...b, adjusted: false };
    await applyInventoryAdjustment(tx, actor, {
      kind: "GREEN_BEAN", entityId: b.greenBeanId, target: (cur) => cur + delta, locationId: b.locationId, sourceDocId: b.id,
      reason: `إعادة وزن الدلو ${b.barcode}: ${reason}`, details: { bucketId: b.id, barcode: b.barcode, fromKg: num(b.actualKg), toKg: actualKg },
    });
    await tx.greenBucketComponent.update({ where: { bucketId_greenBeanId: { bucketId: b.id, greenBeanId: b.greenBeanId } }, data: { kg: actualKg } });
    const out = await tx.greenBucket.update({ where: { id: b.id }, data: { actualKg }, include: BUCKET_VIEW });
    await flushPostings(tx);
    return { ...out, adjusted: true, deltaKg: delta };
  }, { ...TX_OPTS, timeout: 60_000 });
}

/** A spill: the bucket's green is written off at staging (an adjustment to zero for it, INVENTORY_VARIANCE). */
export async function writeOffBucket(actor: V2Actor, bucketId: string, body: Record<string, unknown>) {
  const reason = textOf(body.reason, 3, 200);
  if (!reason) throw fail(400, "REASON_REQUIRED", "اكتب سبب الشطب (مثلًا: انسكب).", "Give the reason for the write-off (e.g. spilled).");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor, reason));
    const b = await lockBucket(tx, bucketId);
    if (b.status !== "PREPARED") throw fail(409, "BUCKET_NOT_PREPARED", "يُشطب الدلو الجاهز فقط.", "Only a prepared bucket is written off.");
    const kg = num(b.actualKg);
    await applyInventoryAdjustment(tx, actor, {
      kind: "GREEN_BEAN", entityId: b.greenBeanId, target: (cur) => Math.max(0, cur - kg), locationId: b.locationId, sourceDocId: b.id,
      reason: `شطب الدلو ${b.barcode}: ${reason}`, details: { bucketId: b.id, barcode: b.barcode, kg },
    });
    const out = await tx.greenBucket.update({ where: { id: b.id }, data: { status: "WRITTEN_OFF", writtenOffAt: new Date(), statusReason: reason }, include: BUCKET_VIEW });
    await flushPostings(tx);
    return out;
  }, { ...TX_OPTS, timeout: 60_000 });
}

/** A leftover bucket goes back to the site it came from: a reverse immediate transfer (posts nothing). */
export async function returnBucket(actor: V2Actor, bucketId: string, body: Record<string, unknown> = {}) {
  const note = textOf(body.reason, 1, 200);
  const ctx = auditCtx(actor, note);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const b = await lockBucket(tx, bucketId);
    if (b.status === "RETURNED") return { ...b, replayed: true };
    if (b.status !== "PREPARED") throw fail(409, "BUCKET_NOT_PREPARED", "يُرجَع الدلو الجاهز فقط.", "Only a prepared bucket is returned.");
    const t = await createTransferTx(tx, {
      fromId: b.locationId, toId: b.session.sourceLocationId, mode: "IMMEDIATE", day: riyadhDay(),
      notes: `إرجاع الدلو ${b.barcode}${note ? ` · ${note}` : ""}`, requestKey: null,
      lines: b.components.map((c) => ({ itemKind: "GREEN_BEAN" as const, entityId: c.greenBeanId, qty: num(c.kg), notes: null })),
    }, actor, ctx);
    const out = await tx.greenBucket.update({ where: { id: b.id }, data: { status: "RETURNED", returnedAt: new Date(), returnTransferId: t.id, statusReason: note }, include: BUCKET_VIEW });
    await flushPostings(tx);
    return { ...out, replayed: false };
  }, { ...TX_OPTS, timeout: 60_000 });
}

/** What waits in staging: the prepared buckets, oldest first, each flagged once it has waited STALE_BUCKET_HOURS. */
export async function stagingBuckets(now = new Date()) {
  const rows = await prisma.greenBucket.findMany({
    where: { status: "PREPARED" }, orderBy: { createdAt: "asc" }, take: 500,
    include: { ...BUCKET_VIEW, product: { select: { id: true, productNameEn: true, productNameAr: true } } },
  });
  return rows.map((b) => ({ ...b, ageHours: Math.floor((+now - +b.createdAt) / 3_600_000), stale: +now - +b.createdAt > STALE_BUCKET_HOURS * 3_600_000 }));
}

// ─── The roaster: charge, drop, baskets ──────────────────────────────────────────────────────────

async function v2Roaster(tx: Tx, roasterId: string) {
  const r = await tx.roaster.findUnique({ where: { id: roasterId }, select: { id: true, name: true, status: true, stationMode: true } });
  if (!r || r.status === "RETIRED") throw fail(404, "ROASTER_NOT_FOUND", "الحمّاصة غير موجودة أو خرجت من الخدمة.", "Roaster not found or retired.");
  if (r.stationMode !== "V2") throw fail(409, "ROASTER_NOT_V2", `«${r.name}» تعمل بالمحطة الحالية (v1). فعّل محطة التحميص v2 لها أولًا.`, `«${r.name}» runs the current station (v1). Switch it to roasting station v2 first.`);
  return r;
}

async function nextRunSerial(tx: Tx, at = new Date()): Promise<string> {
  const day = riyadhDay(at);
  const [{ last }] = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO "RoastRunCounter" ("day", "last") VALUES (${day}, 1)
    ON CONFLICT ("day") DO UPDATE SET "last" = "RoastRunCounter"."last" + 1 RETURNING "last"`;
  return `R-${dayText(day).replace(/-/g, "")}-${String(last).padStart(2, "0")}`;
}

const RUN_VIEW = { bucket: { select: { id: true, barcode: true, seqNo: true, greenBeanId: true, actualKg: true, colorKey: true } } } as const;

/**
 * «شحن»: one bucket into the drum. Refused while a roast is in the drum (DRUM_BUSY), while more than UNWEIGHED_LIMIT dropped
 * roasts are unweighed (BASKET_NEEDS_WEIGHING), or when the bucket is not prepared / not covered in staging. The capacity
 * is checked PER ROAST here (risk 1: the V1 check compared the lot total with the roaster's max).
 */
export async function chargeRun(actor: V2Actor, body: Record<string, unknown>, keyRaw: unknown) {
  const key = requireKey(keyRaw);
  const roasterId = typeof body.roasterId === "string" ? body.roasterId : "";
  const bucketRef = typeof body.bucketId === "string" && body.bucketId ? body.bucketId : typeof body.barcode === "string" ? body.barcode.trim().toUpperCase() : "";
  if (!roasterId || !bucketRef) throw fail(400, "CHARGE_FIELDS_REQUIRED", "اختر الحمّاصة وامسح الدلو.", "Choose the roaster and scan the bucket.");
  const slotId = typeof body.scheduledSlotId === "string" && body.scheduledSlotId ? body.scheduledSlotId : null;
  const profile = textOf(body.profile, 1, 120);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor));
    await roasterLock(tx, roasterId);
    const twin = await tx.roastRun.findUnique({ where: { chargeKey: key }, include: RUN_VIEW });
    if (twin) {
      if (twin.roasterId !== roasterId || (twin.bucketId !== bucketRef && twin.bucket.barcode !== bucketRef)) throw fail(422, "IDEMPOTENCY_MISMATCH", "استُخدم مفتاح التكرار لشحنة أخرى.", "This Idempotency-Key was used for another charge.");
      return { ...twin, replayed: true };
    }
    scoped(actor, roasterId);
    const roaster = await v2Roaster(tx, roasterId);
    // D16: an open BLOCKING report refuses the charge; a minor one lets it go and the roast carries its mark.
    const problem = await tx.roastStationEvent.findFirst({ where: { roasterId, status: "OPEN" }, select: { id: true, kind: true, blocking: true, reason: true, reportedAt: true } });
    if (chargeBlockedBy(problem)) throw fail(409, "ROASTER_PROBLEM_OPEN", "يوجد بلاغ مفتوح على الحمّاصة؛ لا شحن حتى يُنهى.", "A problem report is open on this roaster; no charge until it is ended.", { problemId: problem!.id, kind: problem!.kind });
    const minor = problem && !problem.blocking ? problem : null;
    const inDrum = await tx.roastRun.findFirst({ where: { roasterId, status: "CHARGED" }, select: { serial: true } });
    if (inDrum) throw fail(409, "DRUM_BUSY", `في الدرام تحميصة ${inDrum.serial} لم تُفرَّغ بعد.`, `Roast ${inDrum.serial} is still in the drum.`, { serial: inDrum.serial });
    const unweighed = await tx.roastRun.count({ where: { roasterId, status: "DROPPED" } });
    if (unweighed > UNWEIGHED_LIMIT) {
      throw fail(409, "BASKET_NEEDS_WEIGHING", `زِن التحميصات المفرَّغة أولًا: ${unweighed} تحميصات بلا وزن.`, `Weigh the dropped roasts first: ${unweighed} roasts are unweighed.`, { unweighed });
    }
    const b = await lockBucket(tx, bucketRef);
    if (b.status !== "PREPARED") throw fail(409, "BUCKET_NOT_PREPARED", `الدلو ${b.barcode} ${b.status === "CHARGED" ? "شُحن مسبقًا" : "ليس جاهزًا"}.`, `Bucket ${b.barcode} is ${b.status === "CHARGED" ? "already charged" : "not prepared"}.`, { status: b.status });
    // Risk 4: the green check at charge reads staging, where the bucket is.
    for (const c of b.components) await assertLocationHas(tx, { kind: "GREEN_BEAN", entityId: c.greenBeanId, locationId: b.locationId, need: num(c.kg) });
    let slot: { id: string; roasterId: string; productId: string; status: string } | null = null;
    if (slotId) {
      slot = (await tx.$queryRaw<{ id: string; roasterId: string; productId: string; status: string }[]>`
        SELECT "id", "roasterId", "productId", "status" FROM "ScheduledSlot" WHERE "id" = ${slotId} FOR UPDATE`)[0] ?? null;
      if (!slot) throw fail(404, "SLOT_NOT_FOUND", "الخانة غير موجودة.", "Slot not found.");
      if (slot.roasterId !== roasterId) throw fail(409, "SLOT_ROASTER_MISMATCH", "هذه الخانة مخططة على حمّاصة أخرى.", "This slot is planned on another roaster.");
      if (!["PLANNED", "IN_PROGRESS"].includes(slot.status)) throw fail(409, "SLOT_RECORDED", "الخانة سُجّلت أو أُلغيت.", "The slot is recorded or cancelled.");
      const used = await tx.roastRun.findFirst({ where: { scheduledSlotId: slotId, status: { not: "UNDONE" } }, select: { serial: true } });
      if (used) throw fail(409, "SLOT_RECORDED", `الخانة مربوطة بالتحميصة ${used.serial}.`, `The slot is linked to roast ${used.serial}.`);
    }
    const productId = (typeof body.productId === "string" && body.productId) || slot?.productId || b.productId;
    if (!productId) throw fail(400, "PRODUCT_REQUIRED", "اختر القهوة التي تحمّصها.", "Choose the coffee you are roasting.");
    if (slot && slot.productId !== productId) throw fail(409, "COFFEE_MISMATCH", "قهوة التحميصة غير قهوة الخانة.", "The roast's coffee is not the slot's coffee.");
    if (!hasSubPrivilege(actor.permissions, "production", "roast_to_stock")) {
      const lot = await tx.greenBean.findUnique({ where: { id: b.greenBeanId }, select: { id: true, beanType: true, country: true, serialNumber: true } });
      if (lot) {
        const c = await otherCoffeeCheck(lot, productId, false);
        if (!c.ok && c.code === "OTHER_COFFEE") throw fail(409, "OTHER_COFFEE", c.ar, c.en);
      }
    }
    const check = await checkRoasterForRoast(tx, { roasterId, greenKg: num(b.actualKg), ack: body.ack === true, user: actor });
    // An admin who is not an assigned operator is never blocked — the admin role exercised, through its gate (as V1).
    if (check.bypass) await assertAdminRoleGate(actor, "production.roaster_operator_bypass");
    const serial = await nextRunSerial(tx);
    // D12 R6: a charge refused by the gate is retried once the basket is weighed; the drum was really charged at the first
    // refused tap, so the client sends that tap's time and the run keeps it — never in the future, never > 15 min back, and
    // never before the previous roast on this roaster left the drum (two roasts never overlap in the drum).
    const now = Date.now();
    const tapped = typeof body.tappedAt === "string" || typeof body.tappedAt === "number" ? new Date(body.tappedAt as string).getTime() : NaN;
    const prev = await tx.roastRun.findFirst({ where: { roasterId, status: { not: "UNDONE" }, droppedAt: { not: null } }, orderBy: { droppedAt: "desc" }, select: { droppedAt: true } });
    const floorMs = Math.max(now - CHARGE_BACKDATE_MAX_MS, prev?.droppedAt ? +prev.droppedAt : -Infinity);
    const chargedAt = new Date(Number.isFinite(tapped) ? Math.min(now, Math.max(floorMs, tapped)) : now);
    const run = await tx.roastRun.create({
      data: {
        serial, bucketId: b.id, roasterId, productId, operatorId: actor.id, operatorName: actor.name, greenKg: b.actualKg, status: "CHARGED", chargedAt,
        scheduledSlotId: slotId, profile, capacityAck: check.ack?.direction ?? null, adminBypass: check.bypass, chargeKey: key,
        problemId: minor?.id ?? null,
      },
      include: RUN_VIEW,
    });
    await tx.greenBucket.update({ where: { id: b.id }, data: { status: "CHARGED" } });
    if (slot && slot.status === "PLANNED") await tx.scheduledSlot.update({ where: { id: slot.id }, data: { status: "IN_PROGRESS", startedAt: new Date(), startedById: actor.id, updatedById: actor.id } });
    // The station's toast (D16 P4, owner option 2): the mark and how many roasts it now carries.
    const minorProblem = minor ? { id: minor.id, kind: minor.kind, reason: minor.reason, reportedAt: minor.reportedAt, markedRuns: await tx.roastRun.count({ where: { problemId: minor.id, status: { not: "UNDONE" } } }) } : null;
    return { ...run, roaster: { id: roaster.id, name: roaster.name }, minorProblem, replayed: false };
  }, TX_OPTS);
}

type BasketRow = { id: string; status: string; coffeeKey: string; single: boolean; runs: { id: string; droppedAt: Date | null }[] };
async function openBasketOf(tx: Tx, roasterId: string): Promise<BasketRow | null> {
  const row = (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "RoastBasket" WHERE "roasterId" = ${roasterId} AND "status" = 'OPEN' FOR UPDATE`)[0];
  if (!row) return null;
  return tx.roastBasket.findUniqueOrThrow({ where: { id: row.id }, select: { id: true, status: true, coffeeKey: true, single: true, runs: { where: { status: "DROPPED" }, select: { id: true, droppedAt: true }, orderBy: { droppedAt: "asc" } } } });
}
const sealBasket = (tx: Tx, id: string, single: boolean, at: Date = new Date()) => tx.roastBasket.update({ where: { id }, data: { status: "SEALED", single, sealedAt: at } });

/**
 * «نزّل»: never refused. The roast joins the roaster's OPEN basket when that basket holds one roast of the same coffee
 * (and is not «لحالها») — the pair, sealed; otherwise the open basket (if any) is sealed as a single and this roast opens
 * a new one. A replay of the key, or a drop of a roast already dropped, answers with the roast as it is.
 */
export async function dropRun(actor: V2Actor, runId: string, body: Record<string, unknown>, keyRaw: unknown) {
  const key = requireKey(keyRaw);
  const coolerPosition = Number.isInteger(body.coolerPosition) ? (body.coolerPosition as number) : null;
  const pre = await prisma.roastRun.findUnique({ where: { id: runId }, select: { roasterId: true } });
  if (!pre) throw fail(404, "RUN_NOT_FOUND", "التحميصة غير موجودة.", "Roast not found.");
  scoped(actor, pre.roasterId);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor));
    await roasterLock(tx, pre.roasterId);
    const twin = await tx.roastRun.findUnique({ where: { dropKey: key }, include: { ...RUN_VIEW, basket: true } });
    if (twin) {
      if (twin.id !== runId) throw fail(422, "IDEMPOTENCY_MISMATCH", "استُخدم مفتاح التكرار لتحميصة أخرى.", "This Idempotency-Key was used for another roast.");
      return { ...twin, replayed: true };
    }
    await tx.$queryRaw`SELECT "id" FROM "RoastRun" WHERE "id" = ${runId} FOR UPDATE`;
    const run = await tx.roastRun.findUniqueOrThrow({ where: { id: runId } });
    scoped(actor, run.roasterId);
    if (run.status !== "CHARGED") {
      const cur = await tx.roastRun.findUniqueOrThrow({ where: { id: runId }, include: { ...RUN_VIEW, basket: true } });
      return { ...cur, replayed: true };
    }
    const now = new Date();
    const coffeeKey = run.productId;
    const open = await openBasketOf(tx, run.roasterId);
    let basketId: string;
    if (open && open.runs.length === 0) {
      basketId = open.id;
      await tx.roastBasket.update({ where: { id: open.id }, data: { coffeeKey, productId: run.productId, single: false } });
    } else if (open && open.coffeeKey === coffeeKey && open.runs.length === 1 && !open.single) {
      basketId = open.id;
      await sealBasket(tx, open.id, false, now);
    } else {
      if (open) await sealBasket(tx, open.id, open.runs.length === 1, now);
      basketId = (await tx.roastBasket.create({ data: { roasterId: run.roasterId, coffeeKey, productId: run.productId, status: "OPEN" }, select: { id: true } })).id;
    }
    const out = await tx.roastRun.update({
      where: { id: runId }, data: { status: "DROPPED", droppedAt: now, coolerPosition, basketId, dropKey: key },
      include: { ...RUN_VIEW, basket: true },
    });
    return { ...out, replayed: false };
  }, TX_OPTS);
}

async function lockBasket(tx: Tx, basketId: string) {
  const row = (await tx.$queryRaw<{ id: string; roasterId: string }[]>`SELECT "id", "roasterId" FROM "RoastBasket" WHERE "id" = ${basketId} FOR UPDATE`)[0];
  if (!row) throw fail(404, "BASKET_NOT_FOUND", "السلّة غير موجودة.", "Basket not found.");
  return tx.roastBasket.findUniqueOrThrow({
    where: { id: row.id },
    include: { runs: { where: { status: { in: ["DROPPED", "RECORDED"] } }, orderBy: { droppedAt: "asc" }, include: { bucket: { include: { components: true } } } } },
  });
}

/** «سجّلها لحالها»: an open basket with one roast is sealed as a single (it no longer waits for a pair). */
export async function sealSingle(actor: V2Actor, basketId: string) {
  const pre = await prisma.roastBasket.findUnique({ where: { id: basketId }, select: { roasterId: true } });
  if (!pre) throw fail(404, "BASKET_NOT_FOUND", "السلّة غير موجودة.", "Basket not found.");
  scoped(actor, pre.roasterId);
  return prisma.$transaction(async (tx) => {
    await roasterLock(tx, pre.roasterId);
    const b = await lockBasket(tx, basketId);
    if (b.status === "SEALED" && b.single) return b;
    if (b.status !== "OPEN" || b.runs.length !== 1) throw fail(409, "BASKET_NOT_SINGLE", "تُسجَّل منفردةً السلّةُ المفتوحة التي فيها تحميصة واحدة.", "Only an open basket with one roast is recorded alone.");
    await sealBasket(tx, b.id, true);
    return lockBasket(tx, b.id);
  }, TX_OPTS);
}

/** «افصل»: a pair not yet weighed becomes two singles (the later roast moves to a basket of its own). */
export async function unpairBasket(actor: V2Actor, basketId: string) {
  const pre = await prisma.roastBasket.findUnique({ where: { id: basketId }, select: { roasterId: true } });
  if (!pre) throw fail(404, "BASKET_NOT_FOUND", "السلّة غير موجودة.", "Basket not found.");
  scoped(actor, pre.roasterId);
  return prisma.$transaction(async (tx) => {
    await roasterLock(tx, pre.roasterId);
    const b = await lockBasket(tx, basketId);
    if (b.status === "RECORDED") throw fail(409, "BASKET_RECORDED", "وُزنت السلّة فلا تُفصل. صحّح بإلغاء الدفعة وإعادة تسجيلها.", "The basket is weighed, so it is not unpaired. Correct it by cancelling and re-recording the lot.");
    const dropped = b.runs.filter((r) => r.status === "DROPPED");
    if (dropped.length !== 2) throw fail(409, "BASKET_NOT_PAIR", "السلّة ليست زوجًا.", "The basket is not a pair.");
    const later = dropped[1];
    const solo = await tx.roastBasket.create({ data: { roasterId: b.roasterId, coffeeKey: b.coffeeKey, productId: b.productId, status: "SEALED", single: true, sealedAt: new Date() }, select: { id: true } });
    await tx.roastRun.update({ where: { id: later.id }, data: { basketId: solo.id } });
    await sealBasket(tx, b.id, true);
    return { basket: await lockBasket(tx, b.id), split: await lockBasket(tx, solo.id) };
  }, TX_OPTS);
}

// ─── Record a lot ────────────────────────────────────────────────────────────────────────────────

/** The record's intent: the basket, its runs, the weight and the allocations (none in P0). */
export function recordIntentHash(a: { basketId: string; runIds: string[]; roastedKg: number; allocations?: unknown }) {
  return hash({ basketId: a.basketId, runIds: [...a.runIds].sort(), roastedKg: r3(a.roastedKg), allocations: a.allocations ?? null });
}

/** The weighted cost spread across the green lots of a lot: (max unit − min unit) / min unit. */
export function costSpread(units: number[]): number {
  const u = units.filter((x) => x > 0);
  if (u.length < 2) return 0;
  const min = Math.min(...u), max = Math.max(...u);
  return (max - min) / min;
}

type LockedBasket = Awaited<ReturnType<typeof lockBasket>>;
type LockedRun = LockedBasket["runs"][number];

/**
 * A «أمر تحميص للمخزون» is done once the green of its (non-rejected) lots reaches the green it asked for — then COMPLETED
 * (terminal; the V1 queue, green readiness and V2 prep stop counting it).
 */
async function completeStockOrderIfDone(tx: Tx, productionOrderId: string) {
  const po = await tx.productionOrder.findUnique({ where: { id: productionOrderId }, select: { status: true, sourceOrderItemId: true, expectedGreenBeanKg: true } });
  if (!po || po.sourceOrderItemId || po.status === "COMPLETED" || po.status === "CANCELLED") return;
  const agg = await tx.roastingBatch.aggregate({ where: { productionOrderId, isBlend: false, status: { notIn: ["Rejected", "Corrected"] } }, _sum: { greenBeanQuantity: true } });
  if ((agg._sum.greenBeanQuantity ?? 0) + 0.0005 >= po.expectedGreenBeanKg) await tx.productionOrder.update({ where: { id: productionOrderId }, data: { status: "COMPLETED" } });
}

/**
 * The lot itself, inside the caller's transaction: its order line (or the shelf), the batch, the green out of STAGING per
 * component, the entries, the runs / basket / slots marked. Shared by «وزن» and by the supervisor's correction (which
 * re-records a reversed lot with `correctsBatchId`).
 */
async function writeLot(tx: Tx, actor: V2Actor, a: { basket: LockedBasket; runs: LockedRun[]; roastedKg: number; lossReason: string | null; key: string; intentHash: string; correctsBatchId: string | null; stockOrderId?: string | null }) {
  const { basket, runs, roastedKg, lossReason, key, intentHash } = a;
  const productId = runs[0].productId;
  const components: { greenBeanId: string; kg: number; bucketId: string; barcode: string }[] = runs.flatMap((r) => r.bucket.components.map((c) => ({ greenBeanId: c.greenBeanId, kg: num(c.kg), bucketId: r.bucketId, barcode: r.bucket.barcode })));
  const greenKg = r3(components.reduce((s, c) => s + c.kg, 0));
  if (roastedKg > greenKg) throw fail(400, "ROASTED_ABOVE_GREEN", `الوزن المحمص (${roastedKg}) أكبر من الأخضر (${greenKg}).`, `The roasted weight (${roastedKg}) is above the green (${greenKg}).`);
  const product = await tx.coffeeProduct.findUnique({ where: { id: productId }, select: { expectedRoastLoss: true } });
  const loss = lossVerdict(greenKg, roastedKg, product?.expectedRoastLoss ?? null);
  if (loss?.tone === "above" && !lossReason) throw fail(422, "LOSS_REASON_REQUIRED", "الفاقد فوق الحد: اختر سبب الفاقد.", "The loss is above the boundary: choose the loss reason.", { lossPct: +loss.pct.toFixed(2), limit: loss.limit });

  // Where the coffee goes: the oldest line of this coffee still to roast (serialised with every roast of the product).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7762, ${advisoryKey(`product:${productId}`)}::int)`;
  const [coffee] = await roastQueue(tx, { productId });
  let orderItemId: string | null = coffee?.allocateTo?.orderItemId ?? null;
  if (orderItemId) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7762, ${advisoryKey(orderItemId)}::int)`;
    const subject = await tx.orderItem.findUnique({ where: { id: orderItemId }, select: { preparationDecision: true, order: { select: { status: true, approvalStatus: true } } } });
    if (!subject || productionGateRefusal(subject, "start")) orderItemId = null;
  }
  let productionOrderId: string | null = null;
  if (orderItemId) {
    const pos = await tx.productionOrder.findMany({ where: { sourceOrderItemId: orderItemId, status: { in: ["PENDING", "IN_PRODUCTION"] } }, select: { id: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1 });
    productionOrderId = pos[0]?.id ?? null;
  } else {
    // D14 (gate F2): a lot for no order item goes to the coffee's oldest open «أمر تحميص للمخزون» (a correction keeps the
    // order its original lot was for), so the stock order is used up instead of being re-suggested every day.
    if (a.stockOrderId) productionOrderId = a.stockOrderId;
    else {
      const stock = await tx.productionOrder.findMany({
        where: { sourceOrderItemId: null, status: { in: ["PENDING", "IN_PRODUCTION"] }, productSku: { productId } },
        select: { id: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1,
      });
      productionOrderId = stock[0]?.id ?? null;
    }
  }

  // The green lots: the largest share names the lot; the cost spread warns.
  const byLot = new Map<string, number>();
  for (const c of components) byLot.set(c.greenBeanId, r3((byLot.get(c.greenBeanId) ?? 0) + c.kg));
  const mainLot = [...byLot.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  await lockGreenRows(tx, [...byLot.keys()]);
  const holders = await lockHolders(tx, [...byLot.keys()].map((id) => ({ kind: "GREEN_BEAN" as const, entityId: id })));
  const spread = costSpread([...holders.values()].map((h) => Number(h.avgCost)));
  const warnings: string[] = [];
  if (spread > COST_SPREAD_WARN) warnings.push(`COST_SPREAD:${(spread * 100).toFixed(1)}`);

  const batchNumber = await nextRoastBatchNumber(tx);
  const roastProductId = await batchProductId(tx, { productId: orderItemId ? null : productId, orderItemId });
  const firstSlot = runs.find((r) => r.scheduledSlotId)?.scheduledSlotId ?? null;
  const batch = await tx.roastingBatch.create({
    data: {
      orderItemId, productId: orderItemId ? undefined : productId, greenBeanId: mainLot, greenBeanQuantity: greenKg, roastedBeanQuantity: roastedKg,
      roastedAvailableKg: roastedKg, wasteQuantity: r3(greenKg - roastedKg), roastProfile: runs[0].profile ?? null, batchNumber, status: "Pending QC",
      qcDeadline: new Date(Date.now() + 48 * 3_600_000), productionOrderId, roasterId: basket.roasterId, requestKey: key, intentHash,
      profileVersionId: await resolveApprovedVersionId(tx, roastProductId ?? productId, mainLot),
      lotKind: runs.length === 2 ? "PAIR" : "SINGLE", isMixedGreen: byLot.size > 1, basketId: basket.id, scheduledSlotId: firstSlot, correctsBatchId: a.correctsBatchId,
    },
  });

  // The green leaves STAGING per component (risk 2: several lots; risk 4: staging, not the roaster's site).
  const staging = runs[0].bucket.locationId;
  await setStockLocation(tx, staging);
  const parts: RoastComponent[] = [];
  for (const c of components) {
    await assertLocationHas(tx, { kind: "GREEN_BEAN", entityId: c.greenBeanId, locationId: staging, need: c.kg });
    const dec = await tx.greenBean.updateMany({ where: { id: c.greenBeanId, quantityKg: { gte: c.kg } }, data: { quantityKg: { decrement: c.kg } } });
    if (dec.count === 0) throw fail(409, "GREEN_SHORT", "رصيد البن الأخضر لا يكفي.", "Insufficient green stock.");
    const after = (await tx.greenBean.findUniqueOrThrow({ where: { id: c.greenBeanId }, select: { quantityKg: true } })).quantityKg;
    const m = await tx.inventoryMovement.create({
      data: {
        type: "OUT", category: "RAW_MATERIAL", referenceEntityId: c.greenBeanId, quantityChanged: -c.kg, previousQuantity: after + c.kg, newQuantity: after,
        sourceDocType: "ROASTING_BATCH", sourceDocId: batch.id, userId: actor.id, locationId: staging,
        notes: [`دلو ${c.barcode}`, `تحميصات ${runs.map((r) => r.serial).join(" + ")}`, lossReason ? `سبب الفاقد: ${lossReason}` : null, !orderItemId ? "إلى الرف (لا طلب ينتظر هذه القهوة)" : null].filter(Boolean).join(" · "),
      },
    });
    parts.push({ greenBeanId: c.greenBeanId, kg: c.kg, lineKey: `bucket:${c.bucketId}`, movementId: m.id });
  }
  const cost = await onRoastLot(tx, { batchId: batch.id, batchNumber, components: parts, roastedKg, productId: roastProductId ?? productId, actor: actor.id });

  const now = new Date();
  await tx.roastRun.updateMany({ where: { id: { in: runs.map((r) => r.id) } }, data: { status: "RECORDED" } });
  await tx.roastBasket.update({ where: { id: basket.id }, data: { status: "RECORDED", recordedAt: now, sealedAt: basket.sealedAt ?? now, single: runs.length === 1 } });
  const slotIds = runs.map((r) => r.scheduledSlotId).filter((x): x is string => !!x);
  if (slotIds.length) await tx.scheduledSlot.updateMany({ where: { id: { in: slotIds } }, data: { status: "RECORDED", recordedAt: now, outcome: "ROASTED", updatedById: actor.id } });

  if (orderItemId) await recalcOrderItemStatus(orderItemId, tx);
  if (productionOrderId) {
    await recalcProductionOrderStatus(productionOrderId, tx);
    if (!orderItemId) await completeStockOrderIfDone(tx, productionOrderId);
  }
  if (orderItemId) await assertOrderStillAcceptsProduction(tx, orderItemId, "start");
  for (const r of runs) {
    if (!r.capacityAck && !r.adminBypass) continue;
    const roaster = await tx.roaster.findUniqueOrThrow({ where: { id: r.roasterId }, select: { id: true, name: true, nominalCapacityKg: true, minBatchKg: true, maxBatchKg: true } });
    await logRoasterControls(tx, {
      roaster: { id: roaster.id, name: roaster.name, nominalKg: num(roaster.nominalCapacityKg), minKg: num(roaster.minBatchKg), maxKg: num(roaster.maxBatchKg) },
      ack: r.capacityAck ? { direction: r.capacityAck as "BELOW_MIN" | "ABOVE_MAX" } : null, bypass: r.adminBypass,
    }, { batch, requestKey: r.chargeKey, greenKg: num(r.greenKg), user: { id: r.operatorId, name: r.operatorName ?? r.operatorId, role: actor.role }, sourceInterface: "STATION" });
  }
  await emitAutomationEvent(tx, { eventType: "production.batch_roasted", subjectType: "RoastingBatch", subjectId: batch.id, actorId: actor.id });
  await flushPostings(tx);
  return {
    batch, replayed: false, warnings,
    cost: { greenValue: cost.greenValue.toFixed(2), roastedCost: cost.roastedCost.toFixed(2), abnormalCost: cost.abnormalCost.toFixed(2), lossPct: cost.lossPct.toFixed(2), spreadPct: +(spread * 100).toFixed(1) },
    runs: runs.map((r) => r.serial),
  };
}

/**
 * «وزن»: one RoastingBatch from a basket (SINGLE | PAIR). The coffee goes to the oldest order line of the product that still
 * needs roasting (the roast queue), else to the shelf — the roast physically happened, so it is recorded either way.
 */
export async function recordBasket(actor: V2Actor, basketId: string, body: Record<string, unknown>, keyRaw: unknown) {
  const key = requireKey(keyRaw);
  const roastedKg = kgOf(body.roastedKg, "الوزن المحمص");
  const lossReason = textOf(body.lossReason, 1, 200);
  const pre = await prisma.roastBasket.findUnique({ where: { id: basketId }, select: { roasterId: true, runs: { where: { status: { in: ["DROPPED", "RECORDED"] } }, select: { id: true } } } });
  if (!pre) throw fail(404, "BASKET_NOT_FOUND", "السلّة غير موجودة.", "Basket not found.");
  scoped(actor, pre.roasterId);
  const intentHash = recordIntentHash({ basketId, runIds: pre.runs.map((r) => r.id), roastedKg, allocations: body.allocations });
  const replay = async () => {
    const done = await prisma.roastingBatch.findUnique({ where: { requestKey: key } });
    if (!done) return null;
    if (done.intentHash !== intentHash) throw fail(422, "IDEMPOTENCY_MISMATCH", "استُخدم مفتاح التكرار لوزن آخر.", "This Idempotency-Key was used for another weighing.");
    return { batch: done, replayed: true, warnings: [] as string[], cost: null, runs: [] as string[] };
  };
  const early = await replay();
  if (early) return early;

  const result = await prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor));
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7763, ${advisoryKey(`roast-key:${key}`)}::int)`;
    if (await tx.roastingBatch.findUnique({ where: { requestKey: key }, select: { id: true } })) return null;
    await roasterLock(tx, pre.roasterId);
    const basket = await lockBasket(tx, basketId);
    if (basket.status === "RECORDED") throw fail(409, "BASKET_RECORDED", "وُزنت هذه السلّة.", "This basket is already weighed.");
    if (basket.status === "CANCELLED") throw fail(409, "BASKET_CANCELLED", "السلّة ملغاة.", "The basket is cancelled.");
    const runs = basket.runs.filter((r) => r.status === "DROPPED");
    if (!runs.length || runs.length > 2) throw fail(409, "BASKET_EMPTY", "لا تحميصات مفرَّغة في السلّة.", "No dropped roast in the basket.");
    if (recordIntentHash({ basketId, runIds: runs.map((r) => r.id), roastedKg, allocations: body.allocations }) !== intentHash) {
      throw fail(409, "BASKET_CHANGED", "تغيّرت السلّة أثناء الوزن. أعد المحاولة.", "The basket changed while weighing. Try again.");
    }
    return writeLot(tx, actor, { basket, runs, roastedKg, lossReason, key, intentHash, correctsBatchId: null });
  }, { ...TX_OPTS, timeout: 60_000 });
  if (!result) {
    const again = await replay();
    if (again) return again;
    throw fail(503, "RECORD_UNCONFIRMED", "تعذّر تأكيد الوزن. أعد المحاولة بالطلب نفسه.", "The weighing could not be confirmed. Retry with the same request.");
  }
  return result;
}

// ─── Correction: cancel and re-record ────────────────────────────────────────────────────────────

/**
 * A supervisor's correction of a weighed lot (posted entries are never edited): the original lot is reversed PER
 * COMPONENT — each bucket's green back into STAGING at the value it left with (onRoastCancelled `components`), the roasted
 * stock out — and marked «Corrected» (its order line and slot released, its basket freed); then the same basket is
 * re-recorded as a NEW lot with `correctsBatchId` and the corrected weight. Refused once anything downstream used the lot
 * (packed, blended, QC hold / exception / disposition, a QC record, any roasted kg drawn). A reason is required.
 * Idempotent on the key (the new lot's requestKey).
 */
export async function correctLot(actor: V2Actor, batchId: string, body: Record<string, unknown>, keyRaw: unknown, via: "desk" | "station" = "desk") {
  const key = requireKey(keyRaw);
  const roastedKg = kgOf(body.roastedKg, "الوزن المحمص");
  const reason = textOf(body.reason, 3, 300);
  if (!reason) throw fail(400, "REASON_REQUIRED", "اكتب سبب التصحيح.", "Give the reason for the correction.");
  const lossReason = textOf(body.lossReason, 1, 200);
  const intentHash = hash({ correct: batchId, roastedKg });
  const replay = async () => {
    const done = await prisma.roastingBatch.findUnique({ where: { requestKey: key } });
    if (!done) return null;
    if (done.intentHash !== intentHash) throw fail(422, "IDEMPOTENCY_MISMATCH", "استُخدم مفتاح التكرار لتصحيح آخر.", "This Idempotency-Key was used for another correction.");
    return { batch: done, corrected: batchId, replayed: true };
  };
  const early = await replay();
  if (early) return early;
  const pre = await prisma.roastingBatch.findUnique({ where: { id: batchId }, select: { roasterId: true, lotKind: true, status: true } });
  if (!pre) throw fail(404, "BATCH_NOT_FOUND", "الدفعة غير موجودة.", "Lot not found.");
  if (!pre.lotKind || !pre.roasterId) throw fail(409, "NOT_A_V2_LOT", "هذه ليست دفعة من محطة التحميص v2.", "This is not a roasting station v2 lot.");
  if (pre.status === "Corrected") throw fail(409, "LOT_ALREADY_CORRECTED", "صُحّحت هذه الدفعة مسبقًا.", "This lot was already corrected.");
  scoped(actor, pre.roasterId);
  const out = await prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor, reason));
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7763, ${advisoryKey(`roast-key:${key}`)}::int)`;
    if (await tx.roastingBatch.findUnique({ where: { requestKey: key }, select: { id: true } })) return null;
    await roasterLock(tx, pre.roasterId!);
    await tx.$queryRaw`SELECT "id" FROM "RoastingBatch" WHERE "id" = ${batchId} FOR UPDATE`;
    const old = await tx.roastingBatch.findUniqueOrThrow({
      where: { id: batchId },
      include: { _count: { select: {
        packagingOperations: true, blendInputs: true, blendOutputs: true, qcRecords: true, qcExceptions: true, qcDispositions: true, finishedGoodsLots: true,
        packedLots: true, packagingSources: true, cuppingSessions: true, cuppingSessionBatches: true, qcInvites: { where: { status: "PENDING" } },
      } } },
    });
    if (old.status === "Corrected" || !old.basketId) throw fail(409, "LOT_ALREADY_CORRECTED", "صُحّحت هذه الدفعة مسبقًا.", "This lot was already corrected.");
    const c = old._count;
    const used = c.packagingOperations + c.blendInputs + c.blendOutputs + c.qcRecords + c.qcExceptions + c.qcDispositions + c.finishedGoodsLots + c.packedLots + c.packagingSources
      + c.cuppingSessions + c.cuppingSessionBatches + c.qcInvites;
    if (used > 0 || old.qcHoldAt || Math.abs(old.roastedAvailableKg - old.roastedBeanQuantity) > 0.0005) {
      throw fail(409, "LOT_IN_USE", "استُخدمت الدفعة بعد وزنها (تعبئة أو خلط أو جودة)، فلا تُصحَّح من المحطة.", "The lot was used after it was weighed (packed, blended or in QC), so it is not corrected at the station.");
    }
    const basket = await lockBasket(tx, old.basketId);
    const runs = basket.runs.filter((r) => r.status === "RECORDED");
    if (!runs.length) throw fail(409, "BASKET_EMPTY", "لا تحميصات في سلّة هذه الدفعة.", "The lot's basket holds no roast.");
    scoped(actor, basket.roasterId);
    const recorder = await tx.inventoryMovement.findFirst({ where: { sourceDocType: "ROASTING_BATCH", sourceDocId: old.id, type: "OUT" }, select: { userId: true } });
    const own = runs.some((r) => r.operatorId === actor.id) || recorder?.userId === actor.id;
    if (via === "station") {
      // The owner's decision: the roaster corrects his own weighing at the station — the one who recorded it or any
      // operator of that roaster (or the roaster's paired device) — the same Riyadh business day only; afterwards it is
      // the supervisor's desk correction. A reason is required and the supervisors are told (below).
      if (+riyadhDay(old.date) !== +riyadhDay()) {
        throw fail(403, "CORRECTION_DAY_PASSED", "انتهى يوم العمل الذي وُزنت فيه الدفعة؛ يصحّحها المشرف.", "The business day the lot was weighed in has ended; a supervisor corrects it.");
      }
      const operator = own || actor.stationRoasterId === basket.roasterId || await isAssignedOperator(tx, basket.roasterId, actor.id);
      if (!operator && actor.role !== "admin") throw fail(403, "NOT_ROASTER_OPERATOR", "يصحّح الوزن من سجّله أو مشغّل هذه الحمّاصة.", "The weight is corrected by the one who recorded it or an operator of this roaster.");
      if (!operator) {
        // An admin who is not an operator of the roaster: the admin role exercised — its gate, then logged (as the desk path).
        await assertAdminRoleGate(actor, "production.lot_station_correction");
        await tx.authAuditLog.create({ data: { userId: actor.id, action: "ROAST_LOT_ADMIN_STATION_CORRECTION", result: "SUCCESS", sourceInterface: "STATION", ipHash: await ipHashOf(null), metadata: { batchId: old.id, batchNumber: old.batchNumber, reason, adminOverride: true } } });
      }
    } else if (own && actor.role !== "admin") {
      // L4 (the gate's decision): at the desk a supervisor does not correct a lot they roasted or recorded; an admin may, logged.
      throw fail(403, "SELF_CORRECTION", "لا يصحّح الدفعة من حمّصها أو وزنها. يصحّحها مشرف آخر.", "A lot is not corrected by the person who roasted or weighed it. Another supervisor corrects it.");
    }
    if (own && via === "desk") {
      // The admin role exercised: the admin-role gate (a verified individual; SIMPLE MODE waives that), then logged.
      await assertAdminRoleGate(actor, "production.lot_self_correction");
      await tx.authAuditLog.create({ data: { userId: actor.id, action: "ROAST_LOT_SELF_CORRECTION", result: "SUCCESS", sourceInterface: "STATION", ipHash: await ipHashOf(null), metadata: { batchId: old.id, batchNumber: old.batchNumber, reason, adminOverride: true } } });
    }
    // The record path's order (round-2 gate): the product's lock (7762) first, then the GreenBean rows, then the holders.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7762, ${advisoryKey(`product:${runs[0].productId}`)}::int)`;
    await lockGreenRows(tx, runs.flatMap((r) => r.bucket.components.map((x) => x.greenBeanId)));
    const staging = runs[0].bucket.locationId;

    // 1. The original lot reversed per component: the green back into staging at its issue value.
    await setStockLocation(tx, staging);
    const parts: RoastComponent[] = [];
    for (const r of runs) {
      for (const comp of r.bucket.components) {
        const kg = num(comp.kg);
        await tx.greenBean.update({ where: { id: comp.greenBeanId }, data: { quantityKg: { increment: kg } } });
        const after = (await tx.greenBean.findUniqueOrThrow({ where: { id: comp.greenBeanId }, select: { quantityKg: true } })).quantityKg;
        const m = await tx.inventoryMovement.create({
          data: {
            type: "IN", category: "RAW_MATERIAL", referenceEntityId: comp.greenBeanId, quantityChanged: kg, previousQuantity: after - kg, newQuantity: after,
            sourceDocType: "ROASTING_BATCH", sourceDocId: old.id, userId: actor.id, locationId: staging, notes: `تصحيح الدفعة ${old.batchNumber} · دلو ${r.bucket.barcode} · ${reason}`,
          },
        });
        parts.push({ greenBeanId: comp.greenBeanId, kg, lineKey: `bucket:${r.bucketId}`, movementId: m.id });
      }
    }
    const oldProduct = await batchProductId(tx, { productId: old.productId, orderItemId: old.orderItemId });
    await onRoastCancelled(tx, { batchId: old.id, batchNumber: old.batchNumber, greenBeanId: old.greenBeanId, greenKg: old.greenBeanQuantity, restock: true, productId: oldProduct, reason, actor: actor.id, components: parts });
    await tx.roastingBatch.update({
      where: { id: old.id },
      data: { status: "Corrected", roastedAvailableKg: 0, basketId: null, orderItemId: null, productionOrderId: null, scheduledSlotId: null, qcFinalDecisionReason: `صُحّحت: ${reason}`.slice(0, 500) },
    });
    if (old.orderItemId) await recalcOrderItemStatus(old.orderItemId, tx);
    if (old.productionOrderId) await recalcProductionOrderStatus(old.productionOrderId, tx);

    // 2. The same basket re-recorded as a new lot.
    const oldStock = old.productionOrderId && !old.orderItemId ? old.productionOrderId : null;
    const lot = await writeLot(tx, actor, { basket, runs, roastedKg, lossReason, key, intentHash, correctsBatchId: old.id, stockOrderId: oldStock });
    // Every correction is told to the production supervisors: the old and new weight and the loss.
    const greenKg = r3(runs.reduce((sum, r) => sum + r.bucket.components.reduce((x, c) => x + num(c.kg), 0), 0));
    const lossPct = greenKg > 0 ? ((greenKg - roastedKg) / greenKg) * 100 : 0;
    await notify(tx, {
      event: "production.lot_corrected", actorId: actor.id, dedupeKey: lot.batch.id, entity: { type: "RoastingBatch", id: lot.batch.id },
      facts: { batchNumber: old.batchNumber, newBatchNumber: lot.batch.batchNumber, oldKg: num(old.roastedBeanQuantity).toFixed(2), newKg: roastedKg.toFixed(2), lossPct: lossPct.toFixed(1), reason, byName: actor.name, via },
    });
    return { ...lot, corrected: old.id, reason };
  }, { ...TX_OPTS, timeout: 60_000 });
  if (!out) {
    const again = await replay();
    if (again) return again;
    throw fail(503, "RECORD_UNCONFIRMED", "تعذّر تأكيد التصحيح. أعد المحاولة بالطلب نفسه.", "The correction could not be confirmed. Retry with the same request.");
  }
  return out;
}

/**
 * The daily scheduler (the workspace cron): one notification per bucket that has waited in staging longer than
 * STALE_BUCKET_HOURS — to the production supervisors, once per bucket (the notification's dedupe key).
 */
export async function notifyStaleBuckets(now = new Date()) {
  const rows = await prisma.greenBucket.findMany({
    where: { status: "PREPARED", createdAt: { lt: new Date(+now - STALE_BUCKET_HOURS * 3_600_000) } },
    take: 200, orderBy: { createdAt: "asc" },
    select: { id: true, barcode: true, seqNo: true, actualKg: true, createdAt: true, greenBean: { select: { serialNumber: true } } },
  });
  let inserted = 0;
  for (const b of rows) {
    const r = await notify(prisma, {
      event: "production.staging_stale", dedupeKey: b.id, entity: { type: "GreenBucket", id: b.id },
      facts: { barcode: b.barcode, kg: num(b.actualKg), lot: b.greenBean.serialNumber, hours: Math.floor((+now - +b.createdAt) / 3_600_000) },
    });
    inserted += r.inserted;
  }
  return { stale: rows.length, inserted };
}

// ─── Discard, review, undo ───────────────────────────────────────────────────────────────────────

/**
 * «تالف» (burnt): the run is DISCARDED — no batch. Its bucket's green leaves staging (one OUT movement and one cost-out per
 * component) and the full cost goes to ROAST_DISCARD at once. Supervisors are told (danger when the value is over
 * DISCARD_ALERT_SAR or the roaster's shift — its Riyadh day — has more than DISCARD_ALERT_PER_SHIFT discards).
 */
export async function discardRun(actor: V2Actor, runId: string, body: Record<string, unknown>, keyRaw: unknown) {
  const key = requireKey(keyRaw);
  const reason = textOf(body.reason, 3, 200);
  if (!reason) throw fail(400, "REASON_REQUIRED", "اكتب سبب التلف.", "Give the reason for the discard.");
  const pre = await prisma.roastRun.findUnique({ where: { id: runId }, select: { roasterId: true } });
  if (!pre) throw fail(404, "RUN_NOT_FOUND", "التحميصة غير موجودة.", "Roast not found.");
  scoped(actor, pre.roasterId);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor, reason));
    await roasterLock(tx, pre.roasterId);
    const twin = await tx.roastRun.findUnique({ where: { discardKey: key } });
    if (twin) {
      if (twin.id !== runId) throw fail(422, "IDEMPOTENCY_MISMATCH", "استُخدم مفتاح التكرار لتحميصة أخرى.", "This Idempotency-Key was used for another roast.");
      return { run: twin, replayed: true, alert: false };
    }
    await tx.$queryRaw`SELECT "id" FROM "RoastRun" WHERE "id" = ${runId} FOR UPDATE`;
    const run = await tx.roastRun.findUniqueOrThrow({ where: { id: runId }, include: { bucket: { include: { components: true } } } });
    if (!["CHARGED", "DROPPED"].includes(run.status)) throw fail(409, "RUN_NOT_OPEN", run.status === "DISCARDED" ? "سُجّلت هذه التحميصة تالفة." : "وُزنت هذه التحميصة أو أُلغيت.", run.status === "DISCARDED" ? "This roast is already discarded." : "This roast is weighed or undone.");
    scoped(actor, run.roasterId);
    await lockGreenRows(tx, run.bucket.components.map((c) => c.greenBeanId));
    const staging = run.bucket.locationId;
    await setStockLocation(tx, staging);
    const parts: RoastComponent[] = [];
    for (const c of run.bucket.components) {
      const kg = num(c.kg);
      await assertLocationHas(tx, { kind: "GREEN_BEAN", entityId: c.greenBeanId, locationId: staging, need: kg });
      const dec = await tx.greenBean.updateMany({ where: { id: c.greenBeanId, quantityKg: { gte: kg } }, data: { quantityKg: { decrement: kg } } });
      if (dec.count === 0) throw fail(409, "GREEN_SHORT", "رصيد البن الأخضر لا يكفي.", "Insufficient green stock.");
      const after = (await tx.greenBean.findUniqueOrThrow({ where: { id: c.greenBeanId }, select: { quantityKg: true } })).quantityKg;
      const m = await tx.inventoryMovement.create({
        data: {
          type: "OUT", category: "RAW_MATERIAL", referenceEntityId: c.greenBeanId, quantityChanged: -kg, previousQuantity: after + kg, newQuantity: after,
          sourceDocType: "ROAST_RUN", sourceDocId: run.id, userId: actor.id, locationId: staging, notes: `تالف تحميص ${run.serial} · دلو ${run.bucket.barcode} · ${reason}`,
        },
      });
      parts.push({ greenBeanId: c.greenBeanId, kg, lineKey: `bucket:${run.bucketId}`, movementId: m.id });
    }
    const productId = await batchProductId(tx, { productId: run.productId, orderItemId: null });
    const { value } = await onRoastDiscard(tx, { runId: run.id, serial: run.serial, components: parts, productId, reason, actor: actor.id });
    const now = new Date();
    if (run.basketId) {
      const left = await tx.roastRun.count({ where: { basketId: run.basketId, status: "DROPPED", id: { not: run.id } } });
      const b = await tx.roastBasket.findUniqueOrThrow({ where: { id: run.basketId }, select: { status: true } });
      if (left === 0 && b.status !== "RECORDED") await tx.roastBasket.update({ where: { id: run.basketId }, data: { status: "CANCELLED" } });
      else if (b.status === "SEALED") await tx.roastBasket.update({ where: { id: run.basketId }, data: { single: true } });
    }
    const out = await tx.roastRun.update({
      where: { id: run.id },
      data: { status: "DISCARDED", discardedAt: now, discardedById: actor.id, discardReason: reason, discardValue: value, discardKey: key, basketId: null },
    });
    if (run.scheduledSlotId) await tx.scheduledSlot.update({ where: { id: run.scheduledSlotId }, data: { status: "RECORDED", recordedAt: now, outcome: "DISCARDED", updatedById: actor.id } });
    const dayStart = new Date(+riyadhDay(now) - 3 * 3_600_000);
    const shiftCount = await tx.roastRun.count({ where: { roasterId: run.roasterId, status: "DISCARDED", discardedAt: { gte: dayStart } } });
    const alert = value.gt(DISCARD_ALERT_SAR) || shiftCount > DISCARD_ALERT_PER_SHIFT;
    await notify(tx, {
      event: "production.roast_discard", actorId: actor.id, dedupeKey: run.id, entity: { type: "RoastRun", id: run.id },
      facts: { serial: run.serial, kg: num(run.greenKg), value: value.toFixed(2), reason, byName: actor.name, shiftCount, alert: alert ? "1" : "" },
    });
    await flushPostings(tx);
    return { run: out, replayed: false, alert, shiftCount, value: value.toFixed(2) };
  }, { ...TX_OPTS, timeout: 60_000 });
}

/** A supervisor's review of a discard — never the operator who discarded it (403 SELF_REVIEW; the database CHECK too). */
export async function reviewDiscard(actor: V2Actor, runId: string, body: Record<string, unknown>) {
  const note = textOf(body.note, 0, 300);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor, note));
    await tx.$queryRaw`SELECT "id" FROM "RoastRun" WHERE "id" = ${runId} FOR UPDATE`;
    const run = await tx.roastRun.findUnique({ where: { id: runId } });
    if (!run) throw fail(404, "RUN_NOT_FOUND", "التحميصة غير موجودة.", "Roast not found.");
    scoped(actor, run.roasterId);
    if (run.status !== "DISCARDED") throw fail(409, "RUN_NOT_DISCARDED", "التحميصة ليست تالفة.", "The roast is not discarded.");
    if (run.discardedById === actor.id || run.operatorId === actor.id) throw fail(403, "SELF_REVIEW", "لا يراجع التلف من سجّله أو حمّص التحميصة. يراجعه مشرف آخر.", "A discard is not reviewed by the person who recorded it or roasted it. Another supervisor reviews it.");
    if (run.reviewedAt) return run;
    return tx.roastRun.update({ where: { id: runId }, data: { reviewedAt: new Date(), reviewedById: actor.id, reviewNote: note || null } });
  }, TX_OPTS);
}

/** Discards waiting for a review, oldest first; `overdue` past DISCARD_REVIEW_HOURS. */
export async function discardsToReview(now = new Date(), roasterId: string | null = null) {
  const rows = await prisma.roastRun.findMany({ where: { status: "DISCARDED", reviewedAt: null, ...(roasterId ? { roasterId } : {}) }, orderBy: { discardedAt: "asc" }, take: 200, include: RUN_VIEW });
  return rows.map((r) => ({ ...r, overdue: !!r.discardedAt && +now - +r.discardedAt > DISCARD_REVIEW_HOURS * 3_600_000 }));
}

/**
 * «تراجع»: the last step of a roast, within UNDO_WINDOW_MS by server time and only while nothing is posted — a CHARGE
 * (the run is UNDONE, its bucket PREPARED again, its slot PLANNED) or a DROP (back in the drum; out of its basket).
 * Idempotent (gate M2): an Idempotency-Key AND the step the screen showed (`expect`: DROP | CHARGE). The same key again
 * answers with the run as it is; another step than the one expected is 409 STEP_CHANGED — so a double tap never undoes
 * the drop and then the charge.
 */
export async function undoRun(actor: V2Actor, runId: string, body: Record<string, unknown>, keyRaw: unknown, now = new Date()) {
  const key = requireKey(keyRaw);
  const expect = body.expect === "DROP" || body.expect === "CHARGE" ? body.expect : null;
  if (!expect) throw fail(400, "EXPECT_REQUIRED", "حدّد الخطوة التي تتراجع عنها.", "Say which step you are undoing (expect: DROP or CHARGE).");
  const pre = await prisma.roastRun.findUnique({ where: { id: runId }, select: { roasterId: true } });
  if (!pre) throw fail(404, "RUN_NOT_FOUND", "التحميصة غير موجودة.", "Roast not found.");
  scoped(actor, pre.roasterId);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor, "undo"));
    await roasterLock(tx, pre.roasterId);
    const twin = await tx.roastRun.findUnique({ where: { undoKey: key } });
    if (twin) {
      if (twin.id !== runId) throw fail(422, "IDEMPOTENCY_MISMATCH", "استُخدم مفتاح التكرار لتحميصة أخرى.", "This Idempotency-Key was used for another roast.");
      return { run: twin, undid: null, replayed: true };
    }
    await tx.$queryRaw`SELECT "id" FROM "RoastRun" WHERE "id" = ${runId} FOR UPDATE`;
    const run = await tx.roastRun.findUniqueOrThrow({ where: { id: runId } });
    const step = run.status === "CHARGED" ? "CHARGE" : run.status === "DROPPED" ? "DROP" : null;
    if (!step) throw fail(409, "NOTHING_TO_UNDO", "لا خطوة يمكن التراجع عنها (الوزن والتلف مرحّلان).", "Nothing can be undone (a weighing or a discard is posted).");
    if (step !== expect) throw fail(409, "STEP_CHANGED", "تغيّرت حالة التحميصة؛ حدّث الشاشة.", `The roast's step changed (it is at ${step}, not ${expect}); refresh the screen.`, { step });
    const expired = () => fail(409, "UNDO_EXPIRED", "انتهت مهلة التراجع (3 دقائق).", "The undo window (3 minutes) has passed.");
    // «حتى الخطوة التالية»: the step must still be the roaster's last one — every other step of the roaster (its other
    // runs' charge / drop / discard, its baskets' «لحالها» / unpair / weighing) is at or before it.
    // A charge's step time is when the server recorded it (createdAt): its chargedAt may be back-dated to the first
    // refused tap (R6), which must not make the weighing that unblocked it look like a later step.
    const at = step === "CHARGE" ? run.createdAt : run.droppedAt!;
    const [{ last }] = await tx.$queryRaw<{ last: Date | null }[]>`
      SELECT GREATEST(
        (SELECT max(GREATEST("createdAt", coalesce("droppedAt", '-infinity'::timestamp), coalesce("discardedAt", '-infinity'::timestamp)))
           FROM "RoastRun" WHERE "roasterId" = ${run.roasterId} AND "status" <> 'UNDONE' AND "id" <> ${run.id}),
        (SELECT max(GREATEST(coalesce("sealedAt", '-infinity'::timestamp), coalesce("recordedAt", '-infinity'::timestamp)))
           FROM "RoastBasket" WHERE "roasterId" = ${run.roasterId})
      ) AS last`;
    if (last && +last > +at) throw fail(409, "STEP_CHANGED", "جاءت خطوة بعدها على الحمّاصة؛ لا تراجع عنها الآن.", "A later step happened on this roaster, so this one can no longer be undone.", { step, laterStepAt: last });
    if (step === "CHARGE") {
      if (+now - +run.createdAt > UNDO_WINDOW_MS) throw expired();
      await tx.greenBucket.update({ where: { id: run.bucketId }, data: { status: "PREPARED" } });
      if (run.scheduledSlotId) await tx.scheduledSlot.updateMany({ where: { id: run.scheduledSlotId, status: "IN_PROGRESS" }, data: { status: "PLANNED", startedAt: null, startedById: null, updatedById: actor.id } });
      const out = await tx.roastRun.update({ where: { id: runId }, data: { status: "UNDONE", undoneAt: now, undoneById: actor.id, scheduledSlotId: null, undoKey: key } });
      return { run: out, undid: "CHARGE" as const, replayed: false };
    }
    if (!run.droppedAt || +now - +run.droppedAt > UNDO_WINDOW_MS) throw expired();
    const inDrum = await tx.roastRun.findFirst({ where: { roasterId: run.roasterId, status: "CHARGED" }, select: { serial: true } });
    if (inDrum) throw fail(409, "UNDO_DRUM_BUSY", `شُحنت التحميصة ${inDrum.serial} بعدها؛ تراجع عنها أولًا.`, `Roast ${inDrum.serial} was charged after it; undo that one first.`);
    if (run.basketId) {
      const b = await tx.roastBasket.findUniqueOrThrow({ where: { id: run.basketId }, select: { id: true, status: true } });
      const others = await tx.roastRun.count({ where: { basketId: b.id, status: "DROPPED", id: { not: run.id } } });
      if (others === 0) await tx.roastBasket.update({ where: { id: b.id }, data: { status: "CANCELLED" } });
      else if (b.status === "SEALED") {
        const open = await tx.roastBasket.findFirst({ where: { roasterId: run.roasterId, status: "OPEN" }, select: { id: true } });
        await tx.roastBasket.update({ where: { id: b.id }, data: open ? { single: true } : { status: "OPEN", single: false, sealedAt: null } });
      }
    }
    const out = await tx.roastRun.update({ where: { id: runId }, data: { status: "CHARGED", droppedAt: null, dropKey: null, coolerPosition: null, basketId: null, undoKey: key } });
    return { run: out, undid: "DROP" as const, replayed: false };
  }, TX_OPTS);
}

// ─── «إبلاغ عن مشكلة» (V1 R7 semantics, without claims) ─────────────────────────────────────────────

export const PROBLEM_KINDS_V2 = ["PAUSE", "MALFUNCTION"] as const;
export const PROBLEM_REASONS_V2 = ["BURNER_STOPPED", "IRREGULAR_HEAT", "COOLING_PROBLEM", "OTHER"] as const;
const PROBLEM_KIND_AR: Record<string, string> = { PAUSE: "إيقاف مؤقت", MALFUNCTION: "عطل في الحمّاصة" };
const PROBLEM_KIND_EN: Record<string, string> = { PAUSE: "paused", MALFUNCTION: "roaster malfunction" };
const PROBLEM_REASON_AR: Record<string, string> = { BURNER_STOPPED: "توقّف الموقد", IRREGULAR_HEAT: "حرارة غير منتظمة", COOLING_PROBLEM: "مشكلة في التبريد", OTHER: "أخرى" };

/**
 * A problem on a V2 roaster (PAUSE | MALFUNCTION): who, when, why, the roast in question (optional — a problem can come
 * between roasts) and the roaster's state. The schedule / roaster managers are told (production.station_problem, once per
 * key). No stock moves and the roaster's status is not changed (D13: an admin action). While it is OPEN a charge is
 * refused; dropping, weighing, «لحالها», a discard and an undo stay allowed (the beans must still come out and be weighed).
 */
export async function reportProblemV2(actor: V2Actor, roasterId: string, body: Record<string, unknown>, keyRaw: unknown) {
  const key = requireKey(keyRaw);
  const kind = PROBLEM_KINDS_V2.includes(body.kind as never) ? (body.kind as string) : null;
  if (!kind) throw fail(400, "PROBLEM_KIND_REQUIRED", "اختر نوع المشكلة.", "Choose what kind of problem this is.");
  const reason = PROBLEM_REASONS_V2.includes(body.reason as never) ? (body.reason as string) : null;
  if (!reason) throw fail(400, "PROBLEM_REASON_REQUIRED", "اختر ماذا حدث.", "Choose what happened.");
  const note = textOf(body.note, 1, 300);
  const runId = typeof body.runId === "string" && body.runId ? body.runId : null;
  scoped(actor, roasterId);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor, `problem ${kind} ${reason}`));
    await roasterLock(tx, roasterId);
    const twin = await tx.roastStationEvent.findUnique({ where: { reportKey: key } });
    if (twin) {
      if (twin.roasterId !== roasterId || twin.kind !== kind || twin.reason !== reason) throw fail(422, "IDEMPOTENCY_MISMATCH", "استُخدم مفتاح التكرار لبلاغ آخر.", "This Idempotency-Key was used for another report.");
      return { problem: twin, replayed: true };
    }
    await v2Roaster(tx, roasterId);
    const open = await tx.roastStationEvent.findFirst({ where: { roasterId, status: "OPEN" }, select: { id: true } });
    if (open) throw fail(409, "PROBLEM_ALREADY_OPEN", "يوجد بلاغ مفتوح على الحمّاصة؛ أنهِه أولًا.", "A problem is already open on this roaster; end it first.", { problemId: open.id });
    let runSerial: string | null = null;
    if (runId) {
      const run = await tx.roastRun.findUnique({ where: { id: runId }, select: { roasterId: true, serial: true } });
      if (!run || run.roasterId !== roasterId) throw fail(404, "RUN_NOT_FOUND", "التحميصة غير موجودة على هذه الحمّاصة.", "Roast not found on this roaster.");
      runSerial = run.serial;
    }
    const [drum, unweighed] = await Promise.all([
      tx.roastRun.findFirst({ where: { roasterId, status: "CHARGED" }, select: { serial: true } }),
      tx.roastRun.count({ where: { roasterId, status: "DROPPED" } }),
    ]);
    const problem = await tx.roastStationEvent.create({
      data: {
        roasterId, kind, reason, note, runId, reportedById: actor.id, reportedByName: actor.name, reportKey: key,
        roasterState: { drum: drum?.serial ?? null, unweighed, run: runSerial },
      },
    });
    await notify(tx, {
      event: "production.station_problem", dedupeKey: key, actorId: actor.id, entity: { type: "RoastStationEvent", id: problem.id },
      facts: {
        kindAr: PROBLEM_KIND_AR[kind], kindEn: PROBLEM_KIND_EN[kind], byName: actor.name,
        reason: [PROBLEM_REASON_AR[reason], runSerial ? `التحميصة ${runSerial}` : null, drum ? `في الدرام ${drum.serial}` : null, unweighed ? `${unweighed} تحميصات في التبريد بلا وزن` : null, note].filter(Boolean).join(" · "),
      },
    });
    return { problem, replayed: false };
  }, TX_OPTS);
}

/**
 * D16 P2 — right after «إرسال»: «إيقاف التحميص» (blocking, the default of every new report) or «متابعة التحميص · مشكلة
 * بسيطة» (blocking = false: charging goes on, each roast carries the mark). To minor: the reporter or a supervisor, never a
 * PAUSE (CHECK). Back to «إيقاف التحميص» (gate M1, safety): anyone at the roaster — the minor banner offers it. Every
 * change is audited (ROAST_PROBLEM_STOPPED / ROAST_PROBLEM_MINOR). Setting the same value again is a no-op (safe to retry).
 */
export async function setProblemModeV2(actor: V2Actor, roasterId: string, problemId: string, body: Record<string, unknown>, keyRaw: unknown) {
  requireKey(keyRaw);
  if (typeof body.blocking !== "boolean") throw fail(400, "PROBLEM_MODE_REQUIRED", "اختر: إيقاف التحميص أو متابعته.", "Choose: stop roasting or keep roasting.");
  const blocking = body.blocking;
  scoped(actor, roasterId);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor, blocking ? "problem: stop roasting" : "problem: keep roasting (minor)"));
    await roasterLock(tx, roasterId);
    const p = await tx.roastStationEvent.findUnique({ where: { id: problemId } });
    if (!p || p.roasterId !== roasterId) throw fail(404, "PROBLEM_NOT_FOUND", "البلاغ غير موجود على هذه الحمّاصة.", "Problem not found on this roaster.");
    if (p.status !== "OPEN") throw fail(409, "PROBLEM_NOT_OPEN", "البلاغ أُنهي.", "The report was ended.");
    if (p.kind === "PAUSE" && !blocking) throw fail(409, "PAUSE_ALWAYS_STOPS", "الإيقاف المؤقت يوقف التحميص دائمًا.", "A pause always stops roasting.");
    if (!maySetProblemMode(actor, p, blocking)) throw fail(403, "SUPERVISOR_REQUIRED", "يحوّل البلاغ إلى بسيط من أبلغ عنه أو المشرف.", "Only the reporter or a supervisor makes a report minor.");
    if (p.blocking === blocking) return { problem: p, replayed: true };
    const out = await tx.roastStationEvent.update({ where: { id: p.id }, data: { blocking } });
    await audit(tx, {
      action: blocking ? "ROAST_PROBLEM_STOPPED" : "ROAST_PROBLEM_MINOR", entityType: "RoastStationEvent", entityId: p.id, actorId: actor.id,
      before: { blocking: p.blocking }, after: { blocking, roasterId, kind: p.kind, reason: p.reason, byName: actor.name },
    });
    return { problem: out, replayed: false };
  }, TX_OPTS);
}

/**
 * «إنهاء البلاغ» / «استئناف»: ends an OPEN report. A PAUSE is ended by the roaster too (as before); anything else by a
 * supervisor (D16, owner decision 1: the station «مشرف» flag, manage_roasters, manage_schedule or the administrator), who
 * writes «إيش كانت المشكلة؟» (cause) and «إيش الحل؟» (fix) — both required, ≤ 500 characters. The same call serves the
 * station and the ERP «بلاغات المحامص» page.
 */
export async function resumeProblemV2(actor: V2Actor, roasterId: string, problemId: string, body: Record<string, unknown>, keyRaw: unknown) {
  const key = requireKey(keyRaw);
  const note = textOf(body.note, 1, 300);
  for (const f of ["cause", "fix"] as const) {
    if (typeof body[f] === "string" && (body[f] as string).trim().length > PROBLEM_TEXT_MAX) throw fail(400, "PROBLEM_TEXT_TOO_LONG", `النص أطول من ${PROBLEM_TEXT_MAX} حرف.`, `The text is longer than ${PROBLEM_TEXT_MAX} characters.`, { field: f });
  }
  const cause = problemText(body.cause);
  const fix = problemText(body.fix);
  scoped(actor, roasterId);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, auditCtx(actor, "problem resumed"));
    await roasterLock(tx, roasterId);
    const twin = await tx.roastStationEvent.findUnique({ where: { resolveKey: key } });
    if (twin) {
      if (twin.id !== problemId) throw fail(422, "IDEMPOTENCY_MISMATCH", "استُخدم مفتاح التكرار لبلاغ آخر.", "This Idempotency-Key was used for another report.");
      return { problem: twin, replayed: true };
    }
    const p = await tx.roastStationEvent.findUnique({ where: { id: problemId } });
    if (!p || p.roasterId !== roasterId) throw fail(404, "PROBLEM_NOT_FOUND", "البلاغ غير موجود على هذه الحمّاصة.", "Problem not found on this roaster.");
    if (p.status === "RESOLVED") return { problem: p, replayed: true };
    if (!mayEndProblem(actor, p.kind)) {
      throw fail(403, "SUPERVISOR_REQUIRED", "يُنهي هذا البلاغ المشرف.", "This report is ended by a supervisor.");
    }
    if (endNeedsTexts(p.kind) && (!cause || !fix)) {
      throw fail(400, "PROBLEM_CAUSE_FIX_REQUIRED", "اكتب إيش كانت المشكلة وإيش الحل.", "Write what the problem was and how it was fixed.", { missing: [!cause ? "cause" : null, !fix ? "fix" : null].filter(Boolean) });
    }
    const out = await tx.roastStationEvent.update({ where: { id: p.id }, data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: actor.id, resolveKey: key, resolveNote: note, resolveCause: cause, resolveFix: fix } });
    return { problem: out, replayed: false };
  }, TX_OPTS);
}

/**
 * D16 E1 «بلاغات المحامص» (ERP): the open reports first (oldest first), then the ended ones of the last 30 days (newest
 * first, at most 50) — with the roasts each minor report marked, and who ended it with the cause and the fix.
 */
export async function listProblemsV2(now = new Date()) {
  const select = {
    id: true, roasterId: true, kind: true, reason: true, note: true, blocking: true, status: true, roasterState: true,
    reportedById: true, reportedByName: true, reportedAt: true, resolvedAt: true, resolvedById: true, resolveNote: true, resolveCause: true, resolveFix: true,
    roaster: { select: { id: true, name: true, manufacturerModel: true } },
    run: { select: { serial: true } },
    markedRuns: { where: { status: { not: "UNDONE" } }, orderBy: { chargedAt: "asc" as const }, select: { id: true, serial: true } },
  } satisfies Prisma.RoastStationEventSelect;
  const [open, closed] = await Promise.all([
    prisma.roastStationEvent.findMany({ where: { status: "OPEN" }, orderBy: { reportedAt: "asc" }, select }),
    prisma.roastStationEvent.findMany({ where: { status: "RESOLVED", resolvedAt: { gte: new Date(+now - 30 * 86_400_000) } }, orderBy: { resolvedAt: "desc" }, take: 50, select }),
  ]);
  const ids = [...new Set(closed.map((p) => p.resolvedById).filter((x): x is string => !!x))];
  const names = new Map((ids.length ? await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((e) => [e.id, e.name]));
  const view = (p: (typeof open)[number]) => ({
    ...p, ageMinutes: Math.floor((+(p.resolvedAt ?? now) - +p.reportedAt) / 60_000), resolvedByName: p.resolvedById ? names.get(p.resolvedById) ?? null : null,
  });
  return { open: open.map(view), closed: closed.map(view), serverTime: now.toISOString() };
}

// ─── The station screens (D12): one read for the floor, the prep plan and a session's buckets ──────────

const productLite = { id: true, productNameEn: true, productNameAr: true } as const;
const FLOOR_RUN = { bucket: { select: { id: true, barcode: true, seqNo: true, actualKg: true, colorKey: true, greenBeanId: true } }, product: { select: productLite } } as const;

/**
 * Everything the V2 floor screen shows (R1–R13) in one read: the drum, the roasts in cooling / in the basket (grouped by
 * basket), the open problem, the prepared buckets (the next one pre-selected: the same coffee as the drum or the last
 * roast, lowest number first), the plan pill, and the last step if it can still be undone.
 */
export async function floorView(roasterId: string, now = new Date()) {
  const roaster = await prisma.roaster.findUnique({ where: { id: roasterId }, select: { id: true, name: true, manufacturerModel: true, status: true, stationMode: true, defaultTargetKg: true } });
  if (!roaster) throw fail(404, "ROASTER_NOT_FOUND", "الحمّاصة غير موجودة.", "Roaster not found.");
  const [open, baskets, problem, prepared, lastRuns] = await Promise.all([
    prisma.roastRun.findMany({ where: { roasterId, status: { in: ["CHARGED", "DROPPED"] } }, orderBy: { chargedAt: "asc" }, include: FLOOR_RUN }),
    prisma.roastBasket.findMany({ where: { roasterId, status: { in: ["OPEN", "SEALED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, single: true, productId: true } }),
    prisma.roastStationEvent.findFirst({ where: { roasterId, status: "OPEN" } }),
    prisma.greenBucket.findMany({ where: { status: "PREPARED" }, orderBy: [{ createdAt: "asc" }], take: 300, select: { id: true, barcode: true, seqNo: true, actualKg: true, colorKey: true, productId: true, createdAt: true, product: { select: productLite } } }),
    prisma.roastRun.findMany({ where: { roasterId, status: { not: "UNDONE" } }, orderBy: { chargedAt: "desc" }, take: 1, select: { productId: true } }),
  ]);
  const drum = open.find((r) => r.status === "CHARGED") ?? null;
  const dropped = open.filter((r) => r.status === "DROPPED").sort((a, b) => +a.droppedAt! - +b.droppedAt!);
  const coffee = drum?.productId ?? lastRuns[0]?.productId ?? prepared[0]?.productId ?? null;
  const sameCoffee = prepared.filter((b) => b.productId === coffee).sort((a, b) => a.seqNo - b.seqNo);
  const next = sameCoffee[0] ?? prepared[0] ?? null;
  // The last step of the roaster, if it is still undoable (owner decision: until the next action, at most 3 min).
  const steps: { kind: "CHARGE" | "DROP"; runId: string; at: Date }[] = [];
  for (const r of open) {
    steps.push({ kind: "CHARGE", runId: r.id, at: r.createdAt });
    if (r.droppedAt) steps.push({ kind: "DROP", runId: r.id, at: r.droppedAt });
  }
  const [lastOther] = await prisma.$queryRaw<{ last: Date | null }[]>`
    SELECT GREATEST(
      (SELECT max(coalesce("discardedAt", '-infinity'::timestamp)) FROM "RoastRun" WHERE "roasterId" = ${roasterId}),
      (SELECT max(GREATEST(coalesce("sealedAt", '-infinity'::timestamp), coalesce("recordedAt", '-infinity'::timestamp))) FROM "RoastBasket" WHERE "roasterId" = ${roasterId})
    ) AS last`;
  const last = steps.sort((a, b) => +b.at - +a.at)[0] ?? null;
  const undoable = last && +now - +last.at <= UNDO_WINDOW_MS && !(lastOther?.last && +lastOther.last > +last.at) ? { kind: last.kind, runId: last.runId, at: last.at } : null;
  const todayStart = new Date(+riyadhDay(now) - 3 * 3_600_000);
  const planBuckets = coffee ? await prisma.greenBucket.aggregate({ where: { productId: coffee, createdAt: { gte: todayStart } }, _sum: { actualKg: true } }) : null;
  // «آخر الدفعات»: today's lots on this roaster — the roaster corrects his own weighing the same business day.
  const lots = await prisma.roastingBatch.findMany({
    where: { roasterId, lotKind: { not: null }, status: { not: "Corrected" }, date: { gte: todayStart } },
    orderBy: { date: "desc" }, take: 8,
    select: { id: true, batchNumber: true, date: true, roastedBeanQuantity: true, greenBeanQuantity: true, roastedAvailableKg: true, qcHoldAt: true, correctsBatchId: true, product: { select: productLite } },
  });
  return {
    lotsToday: lots.map((l) => ({
      id: l.id, batchNumber: l.batchNumber, at: l.date, roastedKg: l.roastedBeanQuantity, greenKg: l.greenBeanQuantity, product: l.product, corrected: !!l.correctsBatchId,
      inUse: !!l.qcHoldAt || Math.abs(l.roastedAvailableKg - l.roastedBeanQuantity) > 0.0005,
    })),
    roaster: { ...roaster, defaultTargetKg: num(roaster.defaultTargetKg) },
    drum,
    dropped: dropped.map((r) => ({ ...r, basket: baskets.find((b) => b.id === r.basketId) ?? null })),
    baskets: baskets.map((b) => ({ ...b, runIds: dropped.filter((r) => r.basketId === b.id).map((r) => r.id) })).filter((b) => b.runIds.length),
    unweighed: dropped.length,
    openProblem: problem ? { ...problem, ageMinutes: Math.floor((+now - +problem.reportedAt) / 60_000), markedRuns: problem.blocking ? 0 : await prisma.roastRun.count({ where: { problemId: problem.id, status: { not: "UNDONE" } } }) } : null,
    prepared, next,
    plan: coffee ? { productId: coffee, product: sameCoffee[0]?.product ?? drum?.product ?? (await prisma.coffeeProduct.findUnique({ where: { id: coffee }, select: productLite })), remaining: sameCoffee.length, totalKg: num(planBuckets?._sum.actualKg ?? 0) } : null,
    undoable,
    canCharge: !drum && !chargeBlockedBy(problem) && dropped.length <= UNWEIGHED_LIMIT && roaster.stationMode === "V2",
    serverTime: now.toISOString(),
  };
}

/**
 * The prep plan (P1): today's roast queue per coffee — the roasted kilograms still to make, turned into green with the
 * coffee's expected loss — and the buckets suggested (N × the roaster's default charge, the last one the remainder).
 */
export async function prepPlan(bucketKg?: number) {
  const queue = await roastQueue(prisma, {});
  const v2 = await prisma.roaster.findFirst({ where: { stationMode: "V2", status: { not: "RETIRED" } }, orderBy: { isDefault: "desc" }, select: { defaultTargetKg: true } });
  const per = bucketKg && bucketKg > 0 ? bucketKg : v2 ? num(v2.defaultTargetKg) : 5;
  const todayStart = new Date(+riyadhDay() - 3 * 3_600_000);
  const done = await prisma.greenBucket.groupBy({ by: ["productId"], where: { createdAt: { gte: todayStart }, status: { not: "RETURNED" } }, _count: { _all: true }, _sum: { actualKg: true } });
  // «أمر تحميص للمخزون» (D14, gate F1/F2): per coffee, the green its open stock orders still ask for — their expected
  // green less the green already roasted against them (writeLot links those lots), less the green already in buckets
  // or in the drum beyond what the coffee's orders take. It joins the coffee's line (orders + stock), or makes its own.
  const stock = await prisma.productionOrder.findMany({
    where: { status: { in: ["PENDING", "IN_PRODUCTION"] }, sourceOrderItemId: null },
    select: { id: true, expectedGreenBeanKg: true, productSku: { select: { product: { select: { id: true, productNameEn: true, productNameAr: true, expectedRoastLoss: true, defaultGreenBean: { select: { id: true, serialNumber: true, quantityKg: true } } } } } } },
  });
  const roastedFor = stock.length
    ? await prisma.roastingBatch.groupBy({ by: ["productionOrderId"], where: { productionOrderId: { in: stock.map((o) => o.id) }, isBlend: false, status: { notIn: ["Rejected", "Corrected"] } }, _sum: { greenBeanQuantity: true } })
    : [];
  const stockLines = new Map<string, { remainKg: number; p: NonNullable<(typeof stock)[number]["productSku"]>["product"] }>();
  for (const o of stock) {
    const pr = o.productSku?.product;
    if (!pr) continue;
    const roasted = roastedFor.find((x) => x.productionOrderId === o.id)?._sum.greenBeanQuantity ?? 0;
    const cur = stockLines.get(pr.id) ?? { remainKg: 0, p: pr };
    cur.remainKg += Math.max(0, Number(o.expectedGreenBeanKg ?? 0) - roasted);
    stockLines.set(pr.id, cur);
  }
  const ids = [...stockLines.keys()];
  const [waiting, inDrum] = ids.length
    ? await Promise.all([
        prisma.greenBucket.groupBy({ by: ["productId"], where: { productId: { in: ids }, status: "PREPARED" }, _sum: { actualKg: true } }),
        prisma.roastRun.groupBy({ by: ["productId"], where: { productId: { in: ids }, status: { in: ["CHARGED", "DROPPED"] } }, _sum: { greenKg: true } }),
      ])
    : [[], []];
  const lossOf = (pct: number | null | undefined) => Math.min(40, Math.max(0, pct || 15)) / 100;
  const stockKgOf = (productId: string) => {
    const x = stockLines.get(productId);
    if (!x || x.remainKg <= 0) return 0;
    const c = queue.find((q) => q.productId === productId);
    const demandGreen = c && c.demandKg > 0 ? c.demandKg / (1 - lossOf(c.expectedRoastLoss)) : 0;
    const inflight = num(waiting.find((w) => w.productId === productId)?._sum.actualKg ?? 0) + num(inDrum.find((w) => w.productId === productId)?._sum.greenKg ?? 0);
    const v = r3(Math.max(0, x.remainKg - Math.max(0, inflight - demandGreen)));
    return v >= 0.05 ? v : 0;
  };
  const lineOf = (base: { productId: string; nameAr: string; nameEn: string; demandKg: number; orderGreenKg: number; orders: number[]; green: { id: string; serialNumber: string; quantityKg: number } | null }) => {
    const stockKg = stockKgOf(base.productId);
    const greenKg = r3(base.orderGreenKg + stockKg);
    const count = Math.max(1, Math.ceil(greenKg / per - 1e-9));
    const d = done.find((x) => x.productId === base.productId);
    const { orderGreenKg: _o, ...rest } = base;
    void _o;
    return {
      ...rest, greenKg, stockKg, bucketKg: per, buckets: count, lastKg: r3(greenKg - per * (count - 1)),
      preparedToday: d?._count._all ?? 0, preparedKgToday: num(d?._sum.actualKg ?? 0), colorKey: colorFor(base.productId),
    };
  };
  const fromQueue = queue.filter((c) => c.demandKg > 0 || done.some((d) => d.productId === c.productId) || stockKgOf(c.productId) > 0).map((c) => lineOf({
    productId: c.productId, nameAr: c.productNameAr ?? c.productNameEn, nameEn: c.productNameEn, demandKg: c.demandKg,
    orderGreenKg: c.demandKg > 0 ? r3(c.demandKg / (1 - lossOf(c.expectedRoastLoss))) : 0, orders: c.orders.map((o) => o.orderNumber), green: c.green,
  }));
  const fromStock = [...stockLines.values()].filter((x) => !fromQueue.some((l) => l.productId === x.p.id) && stockKgOf(x.p.id) > 0).map((x) => lineOf({
    productId: x.p.id, nameAr: x.p.productNameAr ?? x.p.productNameEn, nameEn: x.p.productNameEn, demandKg: 0, orderGreenKg: 0, orders: [], green: x.p.defaultGreenBean,
  }));
  return [...fromQueue.filter((l) => l.greenKg > 0 || l.preparedToday > 0), ...fromStock];
}

/** A prep session's buckets (P3): every bucket with its state, and the leftovers of earlier days still in staging. */
export async function sessionBuckets(sessionId: string, now = new Date()) {
  const session = await prisma.greenPrepSession.findUnique({ where: { id: sessionId } });
  if (!session) throw fail(404, "PREP_SESSION_NOT_FOUND", "جلسة التحضير غير موجودة.", "Prep session not found.");
  const buckets = await prisma.greenBucket.findMany({
    where: { sessionId }, orderBy: { seqNo: "asc" },
    select: { id: true, barcode: true, seqNo: true, plannedKg: true, actualKg: true, status: true, colorKey: true, createdAt: true, labelPrintedAt: true, product: { select: productLite }, greenBean: { select: { serialNumber: true } }, runs: { where: { status: { not: "UNDONE" } }, select: { status: true, serial: true } } },
  });
  const leftovers = (await stagingBuckets(now)).filter((b) => b.sessionId !== sessionId);
  return { session, buckets, leftovers };
}

// ─── Reads and the roaster flag ──────────────────────────────────────────────────────────────────

/** A V2 roaster's floor: the roast in the drum, the baskets waiting for the scale, and whether a charge would pass. */
export async function roasterState(roasterId: string) {
  const roaster = await prisma.roaster.findUnique({ where: { id: roasterId }, select: { id: true, name: true, stationMode: true, status: true, minBatchKg: true, maxBatchKg: true, nominalCapacityKg: true } });
  if (!roaster) throw fail(404, "ROASTER_NOT_FOUND", "الحمّاصة غير موجودة.", "Roaster not found.");
  const [drum, baskets, unweighed, problem] = await Promise.all([
    prisma.roastRun.findFirst({ where: { roasterId, status: "CHARGED" }, include: RUN_VIEW }),
    prisma.roastBasket.findMany({ where: { roasterId, status: { in: ["OPEN", "SEALED"] } }, orderBy: { createdAt: "asc" }, include: { runs: { where: { status: "DROPPED" }, orderBy: { droppedAt: "asc" }, include: RUN_VIEW } } }),
    prisma.roastRun.count({ where: { roasterId, status: "DROPPED" } }),
    prisma.roastStationEvent.findFirst({ where: { roasterId, status: "OPEN" } }),
  ]);
  const openProblem = problem ? { ...problem, ageMinutes: Math.floor((Date.now() - +problem.reportedAt) / 60_000) } : null;
  return { roaster, drum, baskets, unweighed, openProblem, canCharge: !drum && !chargeBlockedBy(problem) && unweighed <= UNWEIGHED_LIMIT && roaster.stationMode === "V2" };
}

/** Switch a roaster between the V1 and V2 stations. Back to V1 only with nothing open on it. */
/**
 * The roaster's station: V1 (the previous screen) or V2. From the station (a supervisor at a device: bound to its
 * roaster) or from the roaster's settings page (`via: "desk"`, no station scope) — the same guards either way. Logged in
 * AuthAuditLog (ROASTER_STATION_MODE, with where it came from) and, from the desk, in the roaster's change history.
 */
export async function setStationMode(actor: V2Actor, roasterId: string, modeRaw: unknown, via: "station" | "desk" = "station") {
  const mode = modeRaw === "V2" ? "V2" : modeRaw === "V1" ? "V1" : null;
  if (!mode) throw fail(400, "MODE_INVALID", "اختر v1 أو v2.", "Choose V1 or V2.");
  return prisma.$transaction(async (tx) => {
    scoped(actor, roasterId);
    await setAuditContext(tx, auditCtx(actor, `stationMode → ${mode}`));
    await roasterLock(tx, roasterId);
    const r = await tx.roaster.findUnique({ where: { id: roasterId }, select: { id: true, stationMode: true } });
    if (!r) throw fail(404, "ROASTER_NOT_FOUND", "الحمّاصة غير موجودة.", "Roaster not found.");
    if (r.stationMode === mode) return r;
    if (mode === "V1") {
      // Back to V1 only with nothing of V2 left open on the roaster: V1 ignores V2 problems, runs and baskets.
      const problem = await tx.roastStationEvent.findFirst({ where: { roasterId, status: "OPEN" }, select: { id: true, kind: true } });
      if (problem) throw fail(409, "ROASTER_PROBLEM_OPEN", "يوجد بلاغ مفتوح على الحمّاصة؛ أنهِه قبل تغيير المحطة.", "A problem report is open on this roaster; end it before switching the station.", { problemId: problem.id, kind: problem.kind });
      const open = await tx.roastRun.count({ where: { roasterId, status: { in: ["CHARGED", "DROPPED"] } } });
      const baskets = await tx.roastBasket.count({ where: { roasterId, status: { in: ["OPEN", "SEALED"] }, runs: { some: { status: "DROPPED" } } } });
      if (open || baskets) throw fail(409, "ROASTER_V2_BUSY", `على الحمّاصة ${open} تحميصات في الدرام أو التبريد لم تُوزن. زِنها أو سجّلها تالفة أولًا.`, `The roaster has ${open} roast(s) in the drum or cooling not weighed. Weigh or discard them first.`, { open, baskets });
    } else {
      const claim = await tx.scheduledSlot.count({ where: { roasterId, status: "IN_PROGRESS" } });
      if (claim) throw fail(409, "ROASTER_HAS_ACTIVE_SLOT", "على الحمّاصة خانة قيد التحميص في المحطة الحالية. أنهِها أولًا.", "A slot is being roasted on the current station. Finish it first.");
    }
    const out = await tx.roaster.update({ where: { id: roasterId }, data: { stationMode: mode, updatedById: actor.id } });
    await tx.authAuditLog.create({ data: { userId: actor.id, action: "ROASTER_STATION_MODE", result: "SUCCESS", sourceInterface: via === "desk" ? "WEB" : "STATION", ipHash: await ipHashOf(null), metadata: { roasterId, from: r.stationMode, to: mode, via } } });
    if (via === "desk") {
      await writeSettingsAudit(tx, { section: "production", action: "ROASTER_UPDATED", entityType: "Roaster", entityId: roasterId, changed: ["stationMode"], before: { stationMode: r.stationMode }, after: { stationMode: mode }, actor: { id: actor.id, name: actor.name } });
    }
    return { id: out.id, stationMode: out.stationMode };
  }, TX_OPTS);
}
