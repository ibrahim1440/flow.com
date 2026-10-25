import "server-only";
import { prisma, TX_OPTS } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { MktError, notFound, str, num, oneOf, date, strList, url, dn, type Actor, can, denied } from "./http";
import { audit, userActor } from "./audit";
import { openApproval, snapshotHash } from "./approvals-core";
import { approvalRequired, loadSettings } from "./settings";
import { isValidUtmCampaign, suggestUtmCampaign } from "../utm";
import { PLATFORM } from "../platforms";

export const OBJECTIVES = ["AWARENESS", "ENGAGEMENT", "TRAFFIC", "LEADS", "CONVERSIONS", "SALES", "RETENTION"] as const;
export const CAMPAIGN_STATUSES = ["DRAFT", "PLANNED", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"] as const;

/** Moves a person may make directly. ACTIVE is reached through `requestActivation` (policy). */
const MOVES: Record<string, string[]> = {
  DRAFT: ["PLANNED", "ARCHIVED"],
  PLANNED: ["DRAFT", "ARCHIVED"],
  ACTIVE: ["PAUSED", "COMPLETED"],
  PAUSED: ["COMPLETED", "ARCHIVED"],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
};

function readCampaign(body: Record<string, unknown>, partial: boolean) {
  const data: Prisma.MktCampaignUncheckedUpdateInput = {};
  const has = (k: string) => !partial || k in body;
  if (has("name")) data.name = str(body.name, "اسم الحملة", { max: 160, required: true })!;
  if (has("objective")) data.objective = oneOf(body.objective, OBJECTIVES, "الهدف");
  if (has("channels")) {
    const ch = strList(body.channels, "القنوات", 20);
    for (const c of ch) if (!PLATFORM[c]) throw new MktError(`القناة «${c}» غير معروفة.`, `Unknown channel ${c}.`);
    data.channels = ch;
  }
  if (has("productId")) data.productId = str(body.productId, "المنتج");
  if (has("audience")) data.audience = str(body.audience, "الجمهور", { max: 1000 });
  if (has("offer")) data.offer = str(body.offer, "العرض", { max: 1000 });
  if (has("landingUrl")) data.landingUrl = url(body.landingUrl, "صفحة الهبوط");
  if (has("startAt")) data.startAt = date(body.startAt, "البداية");
  if (has("endAt")) data.endAt = date(body.endAt, "النهاية");
  if (has("plannedBudget")) data.plannedBudget = num(body.plannedBudget, "الميزانية المخططة", { min: 0 });
  if (has("targetCac")) data.targetCac = num(body.targetCac, "هدف تكلفة الاكتساب", { min: 0 });
  if (has("targetRoas")) data.targetRoas = num(body.targetRoas, "هدف العائد", { min: 0, max: 1000 });
  if (has("minSpendForDecision")) data.minSpendForDecision = num(body.minSpendForDecision, "حد الإنفاق للحكم", { min: 0 });
  if (has("minConversionsForDecision")) data.minConversionsForDecision = num(body.minConversionsForDecision, "حد الطلبات للحكم", { min: 0, int: true });
  if (has("notes")) data.notes = str(body.notes, "ملاحظات", { max: 4000 });
  if (has("externalRefs")) {
    const refs = body.externalRefs;
    if (refs !== undefined && refs !== null && (typeof refs !== "object" || Array.isArray(refs))) throw new MktError("معرفات المنصات غير صالحة.", "externalRefs must be an object.");
    data.externalRefs = (refs ?? {}) as Prisma.InputJsonValue;
  }
  return data;
}

export async function listCampaigns(q: { status?: string | null; search?: string | null }) {
  const rows = await prisma.mktCampaign.findMany({
    where: {
      ...(q.status ? { status: q.status } : { status: { not: "ARCHIVED" } }),
      ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { utmCampaign: { contains: q.search.toLowerCase() } }] } : {}),
    },
    orderBy: [{ status: "asc" }, { startAt: "desc" }, { createdAt: "desc" }],
    take: 300,
    include: { product: { select: { id: true, productNameAr: true, productNameEn: true } }, _count: { select: { posts: true, messages: true, storeOrders: true } } },
  });
  const spend = await prisma.mktMetricSnapshot.groupBy({ by: ["campaignId"], where: { campaignId: { in: rows.map((r) => r.id) }, kind: "PAID" }, _sum: { spend: true }, _count: { _all: true } });
  const spendOf = new Map(spend.map((s) => [s.campaignId, s._count._all > 0 ? dn(s._sum.spend) : null]));
  return rows.map((r) => ({ ...serializeCampaign(r), spend: spendOf.get(r.id) ?? null, counts: r._count }));
}

export function serializeCampaign(r: Prisma.MktCampaignGetPayload<{ include: { product: { select: { id: true; productNameAr: true; productNameEn: true } } } }> | Prisma.MktCampaignGetPayload<object>) {
  const p = (r as { product?: { id: string; productNameAr: string | null; productNameEn: string } | null }).product ?? null;
  return {
    id: r.id, name: r.name, objective: r.objective, status: r.status, channels: r.channels, productId: r.productId,
    product: p ? { id: p.id, name: p.productNameAr ?? p.productNameEn } : null,
    audience: r.audience, offer: r.offer, landingUrl: r.landingUrl, utmCampaign: r.utmCampaign,
    startAt: r.startAt, endAt: r.endAt, plannedBudget: dn(r.plannedBudget), currency: r.currency,
    targetCac: dn(r.targetCac), targetRoas: dn(r.targetRoas), minSpendForDecision: dn(r.minSpendForDecision),
    minConversionsForDecision: r.minConversionsForDecision, externalRefs: r.externalRefs, notes: r.notes,
    ownerId: r.ownerId, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export async function getCampaign(id: string) {
  const r = await prisma.mktCampaign.findUnique({ where: { id }, include: { product: { select: { id: true, productNameAr: true, productNameEn: true } } } });
  if (!r) throw notFound();
  return serializeCampaign(r);
}

export async function createCampaign(body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "campaigns_manage")) throw denied();
  const data = readCampaign(body, false) as Prisma.MktCampaignUncheckedCreateInput;
  let utm = str(body.utmCampaign, "رمز الحملة", { max: 80 })?.toLowerCase() ?? suggestUtmCampaign(String(data.name));
  if (!isValidUtmCampaign(utm)) throw new MktError("رمز الحملة يقبل حروفاً إنجليزية صغيرة وأرقاماً وشرطات فقط.", "utm_campaign: lowercase a-z, 0-9, - and _ only.");
  utm = utm.slice(0, 80);
  checkDates(data.startAt as Date | null, data.endAt as Date | null);
  return prisma.$transaction(async (tx) => {
    const row = await tx.mktCampaign.create({ data: { ...data, utmCampaign: utm, status: "DRAFT", ownerId: actor.id, createdById: actor.id } });
    await audit(tx, userActor(actor), "campaign.created", "MktCampaign", row.id, { after: serializeCampaign(row) });
    return serializeCampaign(row);
  }, TX_OPTS);
}

function checkDates(s: Date | null | undefined, e: Date | null | undefined) {
  if (s && e && e < s) throw new MktError("تاريخ النهاية قبل البداية.", "End is before start.");
}

export async function updateCampaign(id: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "campaigns_manage")) throw denied();
  const data = readCampaign(body, true);
  return prisma.$transaction(async (tx) => {
    const before = await tx.mktCampaign.findUnique({ where: { id } });
    if (!before) throw notFound();
    if (before.status === "ARCHIVED") throw new MktError("الحملة مؤرشفة ولا تُعدّل.", "Archived campaigns are read-only.", 409);
    checkDates((data.startAt as Date | undefined) ?? before.startAt, (data.endAt as Date | undefined) ?? before.endAt);
    const row = await tx.mktCampaign.update({ where: { id }, data });
    // An edit after an activation request invalidates it: the approver saw the old version.
    await tx.mktApproval.updateMany({ where: { subjectType: "CAMPAIGN", subjectId: id, status: "PENDING" }, data: { status: "CANCELLED", decisionNote: "عُدّلت الحملة بعد الطلب" } });
    await audit(tx, userActor(actor), "campaign.updated", "MktCampaign", id, { before: serializeCampaign(before), after: serializeCampaign(row) });
    return serializeCampaign(row);
  }, TX_OPTS);
}

export function activationSnapshot(c: { name: string; objective: string; plannedBudget: unknown; startAt: Date | null; endAt: Date | null; channels: string[]; landingUrl: string | null; targetCac: unknown; targetRoas: unknown }) {
  return { name: c.name, objective: c.objective, plannedBudget: c.plannedBudget === null ? null : String(c.plannedBudget), startAt: c.startAt, endAt: c.endAt, channels: [...c.channels].sort(), landingUrl: c.landingUrl, targetCac: c.targetCac === null ? null : String(c.targetCac), targetRoas: c.targetRoas === null ? null : String(c.targetRoas) };
}

export async function setCampaignStatus(id: string, to: string, actor: Actor, note: string | null) {
  if (!can(actor, "campaigns_manage")) throw denied();
  const target = oneOf(to, CAMPAIGN_STATUSES, "الحالة");
  const settings = await loadSettings();
  return prisma.$transaction(async (tx) => {
    const c = await tx.mktCampaign.findUnique({ where: { id } });
    if (!c) throw notFound();
    if (target === "ACTIVE") {
      if (!["DRAFT", "PLANNED", "PAUSED"].includes(c.status)) throw new MktError("لا يمكن تفعيل الحملة من حالتها الحالية.", "Cannot activate from this status.", 409);
      if (approvalRequired(settings, "campaignCreate")) {
        const a = await openApproval(tx, { subjectType: "CAMPAIGN", subjectId: id, action: "activate", payload: activationSnapshot(c), actor, note });
        return { status: c.status, approval: { id: a.id, status: a.status } };
      }
      const row = await tx.mktCampaign.update({ where: { id }, data: { status: "ACTIVE" } });
      await audit(tx, userActor(actor), "campaign.status", "MktCampaign", id, { before: { status: c.status }, after: { status: "ACTIVE" }, note });
      return { status: row.status, approval: null };
    }
    if (target === "PAUSED" && c.status === "ACTIVE" && approvalRequired(settings, "campaignPause")) {
      // Pausing the RECORD here does not touch the ad platform; the policy still applies because
      // in Phase 3 the same act pauses the live campaign.
      const a = await openApproval(tx, { subjectType: "CAMPAIGN", subjectId: id, action: "pause", payload: { status: c.status }, actor, note });
      return { status: c.status, approval: { id: a.id, status: a.status } };
    }
    if (!MOVES[c.status]?.includes(target)) throw new MktError("هذا الانتقال غير مسموح.", "Transition not allowed.", 409);
    const row = await tx.mktCampaign.update({ where: { id }, data: { status: target } });
    await audit(tx, userActor(actor), "campaign.status", "MktCampaign", id, { before: { status: c.status }, after: { status: target }, note });
    return { status: row.status, approval: null };
  }, TX_OPTS);
}

/** Applied by an approval. Re-checks that the campaign is still what was approved. */
export async function applyCampaignApproval(tx: Prisma.TransactionClient, approval: { subjectId: string; action: string; payloadHash: string }, approver: { id: string; name: string }) {
  const c = await tx.mktCampaign.findUnique({ where: { id: approval.subjectId } });
  if (!c) throw notFound();
  if (approval.action === "activate") {
    if (snapshotHash(activationSnapshot(c)) !== approval.payloadHash) throw new MktError("تغيّرت الحملة بعد طلب الاعتماد؛ اطلب الاعتماد من جديد.", "The campaign changed after the request.", 409, "MKT_STALE_APPROVAL");
    if (!["DRAFT", "PLANNED", "PAUSED"].includes(c.status)) throw new MktError("حالة الحملة تغيّرت.", "Campaign status changed.", 409, "MKT_STALE_APPROVAL");
    await tx.mktCampaign.update({ where: { id: c.id }, data: { status: "ACTIVE" } });
    await audit(tx, { kind: "USER", id: approver.id, name: approver.name }, "campaign.status", "MktCampaign", c.id, { before: { status: c.status }, after: { status: "ACTIVE" }, note: "by approval" });
  } else if (approval.action === "pause") {
    if (c.status !== "ACTIVE") throw new MktError("الحملة ليست نشطة.", "Campaign is not active.", 409, "MKT_STALE_APPROVAL");
    await tx.mktCampaign.update({ where: { id: c.id }, data: { status: "PAUSED" } });
    await audit(tx, { kind: "USER", id: approver.id, name: approver.name }, "campaign.status", "MktCampaign", c.id, { before: { status: "ACTIVE" }, after: { status: "PAUSED" }, note: "by approval" });
  }
}

export async function upsertEconomics(productId: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "campaigns_manage") && !can(actor, "revenue_view")) throw denied();
  const product = await prisma.coffeeProduct.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw notFound();
  const gm = num(body.grossMarginPct, "هامش الربح", { min: 0, max: 100 });
  const data = {
    avgOrderValue: num(body.avgOrderValue, "متوسط قيمة الطلب", { min: 0 }),
    vatIncluded: body.vatIncluded === true,
    grossMarginPct: gm === null ? null : gm / 100,
    variableCostPerOrder: num(body.variableCostPerOrder, "التكاليف المتغيرة", { min: 0 }),
    targetCac: num(body.targetCac, "هدف تكلفة الاكتساب", { min: 0 }),
    repurchaseCycleDays: num(body.repurchaseCycleDays, "دورة إعادة الشراء", { min: 1, max: 365, int: true }),
    updatedById: actor.id,
  };
  return prisma.$transaction(async (tx) => {
    const before = await tx.mktProductEconomics.findUnique({ where: { productId } });
    const row = await tx.mktProductEconomics.upsert({ where: { productId }, create: { productId, ...data }, update: data });
    await audit(tx, userActor(actor), "economics.updated", "MktProductEconomics", productId, { before, after: row });
    return row;
  }, TX_OPTS);
}
