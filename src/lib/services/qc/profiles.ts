// QC station W3 — roast profiles and their versioned QC specification (owner decision 1).
//
// A profile is one product (optionally one green coffee) roasted one way. Its versions:
//   DRAFT    development — TRIAL readings (whole and ground, device, scale, sensory) guide the
//            target and tolerance the QC manager sets; nothing is judged against a draft;
//   APPROVED the reference: whole target ± tol, ground target ± tol, device, scale, sensory
//            requirements — frozen (DB trigger). Approval needs a sensory evaluation «مطابق» and at
//            least one trial reading; the previously approved version is RETIRED in the same step;
//   RETIRED  kept for the record (past batches and inspections still name it).
// Who: qc › manage_profiles (a duty of its own, never a role default; not privileged).
// Batches link to the APPROVED version at record time (resolveApprovedVersionId, called by the roast
// POST); without one the batch's QC is «المواصفة قيد المعايرة».
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { DEFAULT_DEVICE, DEFAULT_SCALE, parseReading, snapshotOf, SENSORY_RESULTS, type SensoryResult, type SpecSnapshot } from "@/lib/qc/spec";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = { id: string; name: string };

export const refuse = (status: number, code: string, ar: string, en: string) => ({ _appCode: status, code, message: ar, errorEn: en });
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const longText = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const VERSION_SELECT = {
  id: true, version: true, status: true, wholeTarget: true, wholeTol: true, groundTarget: true, groundTol: true, device: true, scale: true,
  sensoryRequirements: true, approvedAt: true, approvedByName: true, profile: { select: { id: true, name: true } },
} as const;

/** The APPROVED version a new batch of this product / green coffee is roasted to (null = none: «قيد المعايرة»). */
export async function resolveApprovedVersionId(db: Db, productId: string | null | undefined, greenBeanId: string | null | undefined): Promise<string | null> {
  if (!productId) return null;
  const rows = await db.roastProfileVersion.findMany({
    where: { status: "APPROVED", profile: { productId, status: "ACTIVE", OR: [{ greenBeanId: greenBeanId ?? "__none__" }, { greenBeanId: null }] } },
    select: { id: true, profile: { select: { greenBeanId: true } } },
  });
  // The profile of this very green coffee wins over the product-wide one.
  const exact = rows.find((r) => greenBeanId && r.profile.greenBeanId === greenBeanId);
  return (exact ?? rows.find((r) => r.profile.greenBeanId === null))?.id ?? null;
}

/** The product a batch is (stock batch: its own; order-backed: its order line's SKU). */
export async function batchProductId(db: Db, b: { productId: string | null; orderItemId: string | null }): Promise<string | null> {
  if (b.productId) return b.productId;
  if (!b.orderItemId) return null;
  const oi = await db.orderItem.findUnique({ where: { id: b.orderItemId }, select: { productSku: { select: { productId: true } } } });
  return oi?.productSku?.productId ?? null;
}

/** The spec a batch is judged against: its own linked version, else «قيد المعايرة» (with the profile in development, for the words). */
export async function specForBatch(db: Db, b: { profileVersionId: string | null; productId: string | null; orderItemId: string | null; greenBeanId: string | null }): Promise<SpecSnapshot> {
  if (b.profileVersionId) {
    const v = await db.roastProfileVersion.findUnique({ where: { id: b.profileVersionId }, select: VERSION_SELECT });
    if (v) return snapshotOf(v);
  }
  const productId = await batchProductId(db, b);
  if (!productId) return snapshotOf(null);
  const profiles = await db.roastProfile.findMany({ where: { productId, status: "ACTIVE", OR: [{ greenBeanId: b.greenBeanId ?? "__none__" }, { greenBeanId: null }] }, select: { id: true, name: true, greenBeanId: true, versions: { where: { status: "DRAFT" }, select: { version: true }, orderBy: { version: "desc" }, take: 1 } } });
  const p = profiles.find((x) => b.greenBeanId && x.greenBeanId === b.greenBeanId) ?? profiles.find((x) => x.greenBeanId === null) ?? null;
  return snapshotOf(null, { profileId: p?.id ?? null, profileName: p?.name ?? null, draftVersion: p?.versions[0]?.version ?? null });
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────
export async function listProfiles() {
  const rows = await prisma.roastProfile.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    include: {
      product: { select: { id: true, productNameEn: true, productNameAr: true } },
      greenBean: { select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true } },
      versions: { orderBy: { version: "desc" }, include: { trials: { orderBy: { createdAt: "desc" }, take: 50 } } },
    },
  });
  const products = await prisma.coffeeProduct.findMany({ where: { isActive: true }, select: { id: true, productNameEn: true, productNameAr: true }, orderBy: { productNameEn: "asc" } });
  const greens = await prisma.greenBean.findMany({ where: { isActive: true }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true }, orderBy: { receivedDate: "desc" }, take: 200 });
  return {
    profiles: rows.map((p) => ({
      id: p.id, name: p.name, notes: p.notes, status: p.status, product: p.product, greenBean: p.greenBean, createdByName: p.createdByName, createdAt: p.createdAt.toISOString(),
      versions: p.versions.map((v) => ({
        id: v.id, version: v.version, status: v.status, wholeTarget: v.wholeTarget, wholeTol: v.wholeTol, groundTarget: v.groundTarget, groundTol: v.groundTol,
        device: v.device, scale: v.scale, sensoryRequirements: v.sensoryRequirements, notes: v.notes,
        approvalSensory: v.approvalSensory, approvalSensoryNotes: v.approvalSensoryNotes, approvedAt: v.approvedAt?.toISOString() ?? null, approvedByName: v.approvedByName,
        retiredAt: v.retiredAt?.toISOString() ?? null, createdAt: v.createdAt.toISOString(), createdByName: v.createdByName,
        trials: v.trials.map((t) => ({ id: t.id, colorWhole: t.colorWhole, colorGround: t.colorGround, device: t.device, scale: t.scale, sensoryResult: t.sensoryResult, notes: t.notes, recordedByName: t.recordedByName, createdAt: t.createdAt.toISOString() })),
        trialStats: trialStats(v.trials),
      })),
    })),
    products, greens,
  };
}

/** Mean / min / max of the trial readings (a guide for the target and tolerance; decides nothing). */
export function trialStats(trials: { colorWhole: number; colorGround: number }[]) {
  if (!trials.length) return null;
  const st = (xs: number[]) => ({ mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10, min: Math.min(...xs), max: Math.max(...xs) });
  return { n: trials.length, whole: st(trials.map((t) => t.colorWhole)), ground: st(trials.map((t) => t.colorGround)) };
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────
export async function createProfile(actor: Actor, raw: Record<string, unknown>) {
  const productId = typeof raw.productId === "string" ? raw.productId : "";
  const greenBeanId = typeof raw.greenBeanId === "string" && raw.greenBeanId ? raw.greenBeanId : null;
  const product = productId ? await prisma.coffeeProduct.findUnique({ where: { id: productId }, select: { id: true, productNameEn: true, productNameAr: true } }) : null;
  if (!product) throw refuse(400, "PRODUCT_REQUIRED", "اختر المنتج.", "Choose the product.");
  if (greenBeanId && !(await prisma.greenBean.findUnique({ where: { id: greenBeanId }, select: { id: true } }))) throw refuse(400, "GREEN_INVALID", "البن الأخضر غير موجود.", "Green coffee not found.");
  const name = text(raw.name, 120) || product.productNameAr || product.productNameEn;
  const dup = await prisma.roastProfile.findFirst({ where: { productId, greenBeanId }, select: { id: true } });
  if (dup) throw refuse(409, "PROFILE_EXISTS", "يوجد ملف تحميص لهذا المنتج وهذا البن. أضف إصدارًا جديدًا له.", "A profile exists for this product and green coffee. Add a version to it.");
  return prisma.$transaction(async (tx) => {
    const p = await tx.roastProfile.create({ data: { productId, greenBeanId, name, notes: longText(raw.notes, 1000) || null, createdById: actor.id, createdByName: actor.name } });
    const v = await tx.roastProfileVersion.create({ data: { profileId: p.id, version: 1, device: DEFAULT_DEVICE, scale: DEFAULT_SCALE, createdById: actor.id, createdByName: actor.name } });
    return { profile: p, version: v };
  }, TX_OPTS);
}

/** A new DRAFT version (the spec of the newest version copied as the starting point). One draft at a time. */
export async function createVersion(actor: Actor, profileId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "RoastProfile" WHERE "id" = ${profileId} FOR UPDATE`;
    const p = await tx.roastProfile.findUnique({ where: { id: profileId }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
    if (!p || p.status !== "ACTIVE") throw refuse(404, "NOT_FOUND", "ملف التحميص غير موجود.", "Profile not found.");
    if (await tx.roastProfileVersion.findFirst({ where: { profileId, status: "DRAFT" }, select: { id: true } })) throw refuse(409, "DRAFT_EXISTS", "يوجد إصدار قيد التطوير لهذا الملف. أكمله أولًا.", "This profile already has a draft version.");
    const last = p.versions[0];
    return tx.roastProfileVersion.create({
      data: {
        profileId, version: (last?.version ?? 0) + 1,
        wholeTarget: last?.wholeTarget ?? null, wholeTol: last?.wholeTol ?? null, groundTarget: last?.groundTarget ?? null, groundTol: last?.groundTol ?? null,
        device: last?.device ?? DEFAULT_DEVICE, scale: last?.scale ?? DEFAULT_SCALE, sensoryRequirements: last?.sensoryRequirements ?? null,
        createdById: actor.id, createdByName: actor.name,
      },
    });
  }, TX_OPTS);
}

function num(raw: unknown, field: string, min: number, max: number): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < min || n > max) throw refuse(400, "SPEC_INVALID", `قيمة غير صالحة: ${field}.`, `Invalid value: ${field}.`);
  return Math.round(n * 10) / 10;
}

/** Edit a DRAFT's target / tolerance / device / scale / sensory requirements (an approved spec is frozen). */
export async function updateDraft(actor: Actor, versionId: string, raw: Record<string, unknown>) {
  const v = await prisma.roastProfileVersion.findUnique({ where: { id: versionId }, select: { status: true } });
  if (!v) throw refuse(404, "NOT_FOUND", "الإصدار غير موجود.", "Version not found.");
  if (v.status !== "DRAFT") throw refuse(409, "VERSION_FROZEN", "الإصدار المعتمد لا يُعدَّل. أنشئ إصدارًا جديدًا.", "An approved version is frozen. Create a new version.");
  const data: Prisma.RoastProfileVersionUpdateInput = {};
  const w = num(raw.wholeTarget, "هدف الحبوب", 1, 200); if (w !== undefined) data.wholeTarget = w;
  const wt = num(raw.wholeTol, "سماحية الحبوب", 0, 50); if (wt !== undefined) data.wholeTol = wt;
  const g = num(raw.groundTarget, "هدف المطحون", 1, 200); if (g !== undefined) data.groundTarget = g;
  const gt = num(raw.groundTol, "سماحية المطحون", 0, 50); if (gt !== undefined) data.groundTol = gt;
  if (raw.device !== undefined) data.device = text(raw.device, 60) || null;
  if (raw.scale !== undefined) data.scale = text(raw.scale, 40) || null;
  if (raw.sensoryRequirements !== undefined) data.sensoryRequirements = longText(raw.sensoryRequirements, 1000) || null;
  if (raw.notes !== undefined) data.notes = longText(raw.notes, 1000) || null;
  const r = await prisma.roastProfileVersion.updateMany({ where: { id: versionId, status: "DRAFT" }, data: data as Prisma.RoastProfileVersionUpdateManyMutationInput });
  if (r.count !== 1) throw refuse(409, "VERSION_FROZEN", "الإصدار المعتمد لا يُعدَّل. أنشئ إصدارًا جديدًا.", "An approved version is frozen. Create a new version.");
  void actor;
  return prisma.roastProfileVersion.findUniqueOrThrow({ where: { id: versionId } });
}

/** A TRIAL reading of a DRAFT version (development). */
export async function addTrial(actor: Actor, versionId: string, raw: Record<string, unknown>) {
  const v = await prisma.roastProfileVersion.findUnique({ where: { id: versionId }, select: { status: true, device: true, scale: true } });
  if (!v) throw refuse(404, "NOT_FOUND", "الإصدار غير موجود.", "Version not found.");
  if (v.status !== "DRAFT") throw refuse(409, "VERSION_FROZEN", "قراءات التجربة للإصدار قيد التطوير فقط.", "Trial readings belong to a draft version only.");
  const w = parseReading(raw.colorWhole), g = parseReading(raw.colorGround);
  if (!w.ok || !g.ok || w.value === null || g.value === null) throw refuse(400, "READINGS_REQUIRED", "أدخل قراءتي الحبوب والمطحون (أكبر من 0 وحتى 200).", "Enter both readings (above 0, up to 200).");
  const sensory = SENSORY_RESULTS.includes(raw.sensoryResult as SensoryResult) ? (raw.sensoryResult as SensoryResult) : null;
  const batchId = typeof raw.batchId === "string" && raw.batchId ? raw.batchId : null;
  if (batchId && !(await prisma.roastingBatch.findUnique({ where: { id: batchId }, select: { id: true } }))) throw refuse(400, "BATCH_INVALID", "الدفعة غير موجودة.", "Batch not found.");
  return prisma.roastProfileTrial.create({
    data: {
      versionId, batchId, colorWhole: w.value, colorGround: g.value, device: text(raw.device, 60) || v.device || DEFAULT_DEVICE, scale: text(raw.scale, 40) || v.scale || DEFAULT_SCALE,
      sensoryResult: sensory, notes: longText(raw.notes, 1000) || null, recordedById: actor.id, recordedByName: actor.name,
    },
  });
}

/**
 * Approve a DRAFT: the spec must be complete, at least one trial recorded, and the approval's own
 * sensory evaluation «مطابق» (owner decision 2: sensory is required for profile approval). The
 * profile's current APPROVED version becomes RETIRED in the same transaction. Notifies production.
 */
export async function approveVersion(actor: Actor, versionId: string, raw: Record<string, unknown>) {
  const sensory = raw.sensoryResult;
  const notes = longText(raw.sensoryNotes, 1000);
  if (!SENSORY_RESULTS.includes(sensory as SensoryResult)) throw refuse(422, "SENSORY_REQUIRED", "اعتماد الإصدار يتطلب التقييم الحسي.", "Approving a version requires the sensory evaluation.");
  if (sensory !== "CONFORMING") throw refuse(409, "SENSORY_NOT_CONFORMING", "لا يُعتمد إصدار تقييمه الحسي غير مطابق.", "A version whose sensory evaluation is not conforming cannot be approved.");
  if (notes.length < 3) throw refuse(400, "SENSORY_NOTES_REQUIRED", "اكتب ملاحظات التقييم الحسي.", "Write the sensory evaluation notes.");
  const out = await prisma.$transaction(async (tx) => {
    const v0 = await tx.roastProfileVersion.findUnique({ where: { id: versionId }, select: { profileId: true } });
    if (!v0) throw refuse(404, "NOT_FOUND", "الإصدار غير موجود.", "Version not found.");
    await tx.$queryRaw`SELECT "id" FROM "RoastProfile" WHERE "id" = ${v0.profileId} FOR UPDATE`;
    const v = await tx.roastProfileVersion.findUniqueOrThrow({ where: { id: versionId }, include: { _count: { select: { trials: true } }, profile: { include: { product: { select: { productNameEn: true, productNameAr: true } } } } } });
    if (v.status !== "DRAFT") throw refuse(409, "VERSION_NOT_DRAFT", "هذا الإصدار ليس قيد التطوير.", "This version is not a draft.");
    if (v.wholeTarget === null || v.wholeTol === null || v.groundTarget === null || v.groundTol === null || !v.device || !v.scale) {
      throw refuse(422, "SPEC_INCOMPLETE", "أكمل الهدف والسماحية للحبوب والمطحون والجهاز والمقياس قبل الاعتماد.", "Complete both targets and tolerances, the device and the scale before approving.");
    }
    if (v._count.trials < 1) throw refuse(422, "TRIALS_REQUIRED", "سجّل قراءة تجربة واحدة على الأقل قبل الاعتماد.", "Record at least one trial reading before approving.");
    const now = new Date();
    const retired = await tx.roastProfileVersion.updateMany({ where: { profileId: v.profileId, status: "APPROVED" }, data: { status: "RETIRED", retiredAt: now, retiredById: actor.id } });
    const done = await tx.roastProfileVersion.update({
      where: { id: versionId },
      data: { status: "APPROVED", approvalSensory: "CONFORMING", approvalSensoryNotes: notes, approvedAt: now, approvedById: actor.id, approvedByName: actor.name },
    });
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, {
      event: "production.profile_approved", dedupeKey: done.id, actorId: actor.id, entity: { type: "RoastProfileVersion", id: done.id },
      facts: { profileName: v.profile.name, version: done.version, productName: v.profile.product.productNameAr || v.profile.product.productNameEn, whole: `${done.wholeTarget} ± ${done.wholeTol}`, ground: `${done.groundTarget} ± ${done.groundTol}`, scale: done.scale },
    });
    return { version: done, retired: retired.count };
  }, TX_OPTS);
  return out;
}
