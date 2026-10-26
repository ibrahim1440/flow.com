import "server-only";
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { MktError, notFound, str, oneOf, date, strList, url, type Actor, can, denied } from "./http";
import { audit, userActor } from "./audit";
import { cancelOpenApprovals, openApproval, snapshotHash } from "./approvals-core";
import { approvalRequired, loadSettings } from "./settings";
import { PLATFORM, SOCIAL_PLATFORMS, variantWarnings } from "../platforms";
import { kindOfMime, type MediaType } from "../media";
import { localHour } from "../messaging-rules";

export const POST_OBJECTIVES = ["AWARENESS", "ENGAGEMENT", "TRAFFIC", "CONVERSIONS", "SALES"] as const;
export const CONTENT_TYPES = ["POST", "REEL", "STORY", "VIDEO", "CAROUSEL", "SHORT", "ARTICLE", "PIN"] as const;
/** States in which content may still be edited. Editing an approved/scheduled post sends it back to draft. */
const EDITABLE = ["DRAFT", "IN_REVIEW", "APPROVED", "SCHEDULED", "FAILED"];

const POST_INCLUDE = {
  variants: { orderBy: { platform: "asc" } },
  assets: { orderBy: { position: "asc" }, include: { asset: { select: { id: true, title: true, kind: true, versions: { orderBy: { version: "desc" }, take: 1, select: { id: true, mimeType: true, width: true, height: true } } } } } },
  campaign: { select: { id: true, name: true, utmCampaign: true } },
  product: { select: { id: true, productNameAr: true, productNameEn: true } },
} satisfies Prisma.MktPostInclude;

type PostRow = Prisma.MktPostGetPayload<{ include: typeof POST_INCLUDE }>;

export function serializePost(p: PostRow) {
  return {
    id: p.id, title: p.title, objective: p.objective, audience: p.audience, contentType: p.contentType, caption: p.caption,
    hashtags: p.hashtags, link: p.link, cta: p.cta, scheduledAt: p.scheduledAt, status: p.status, brief: p.brief,
    aiGenerated: p.aiGenerated, createdAt: p.createdAt, updatedAt: p.updatedAt,
    campaign: p.campaign, product: p.product ? { id: p.product.id, name: p.product.productNameAr ?? p.product.productNameEn } : null,
    variants: p.variants.map((v) => ({
      id: v.id, platform: v.platform, caption: v.caption, hashtags: v.hashtags, status: v.status, externalPostId: v.externalPostId,
      externalUrl: v.externalUrl, publishedAt: v.publishedAt, lastError: v.lastError,
    })),
    assets: p.assets.map((a) => ({ assetId: a.assetId, versionId: a.versionId, title: a.asset.title, kind: a.asset.kind, latest: a.asset.versions[0] ?? null })),
  };
}

/** What an approval of this post is bound to (the time is not: moving a slot needs no re-approval). */
export function postSnapshot(p: PostRow) {
  return {
    title: p.title, caption: p.caption, hashtags: p.hashtags, link: p.link, cta: p.cta, contentType: p.contentType,
    variants: p.variants.map((v) => ({ platform: v.platform, caption: v.caption, hashtags: v.hashtags })).sort((a, b) => a.platform.localeCompare(b.platform)),
    assets: p.assets.map((a) => ({ assetId: a.assetId, versionId: a.versionId ?? a.asset.versions[0]?.id ?? null })),
  };
}

function readHashtags(v: unknown): string[] {
  return strList(v, "الوسوم", 60).map((h) => h.replace(/^#+/, "").replace(/\s+/g, "_")).filter(Boolean);
}

function readPlatforms(v: unknown): string[] {
  const list = strList(v, "المنصات", 12);
  for (const p of list) if (!SOCIAL_PLATFORMS.includes(p)) throw new MktError(`المنصة «${p}» غير مدعومة للنشر.`, `Platform ${p} is not a publishing platform.`);
  return list;
}

export async function getPost(id: string) {
  const p = await prisma.mktPost.findUnique({ where: { id }, include: POST_INCLUDE });
  if (!p) throw notFound();
  return p;
}

export async function listPosts(q: { from?: Date | null; to?: Date | null; platform?: string | null; campaignId?: string | null; productId?: string | null; status?: string | null; unscheduled?: boolean }) {
  const where: Prisma.MktPostWhereInput = {
    ...(q.unscheduled ? { scheduledAt: null } : q.from && q.to ? { scheduledAt: { gte: q.from, lt: q.to } } : {}),
    ...(q.campaignId ? { campaignId: q.campaignId } : {}),
    ...(q.productId ? { productId: q.productId } : {}),
    ...(q.status ? { status: q.status } : { status: { not: "CANCELLED" } }),
    ...(q.platform ? { variants: { some: { platform: q.platform } } } : {}),
  };
  const rows = await prisma.mktPost.findMany({ where, include: POST_INCLUDE, orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }], take: 500 });
  return rows.map(serializePost);
}

export async function createPost(body: Record<string, unknown>, actor: Actor, opts: { aiGenerated?: boolean } = {}) {
  if (!can(actor, "content_manage")) throw denied();
  const platforms = readPlatforms(body.platforms);
  const assetIds = strList(body.assetIds, "الوسائط", 10);
  const data = {
    title: str(body.title, "اسم المنشور", { max: 200, required: true })!,
    objective: oneOf(body.objective, POST_OBJECTIVES, "الهدف", "AWARENESS"),
    audience: str(body.audience, "الجمهور", { max: 500 }),
    contentType: oneOf(body.contentType, CONTENT_TYPES, "نوع المحتوى", "POST"),
    caption: str(body.caption, "النص", { max: 63000 }) ?? "",
    hashtags: readHashtags(body.hashtags),
    link: url(body.link, "الرابط"),
    cta: str(body.cta, "الدعوة لاتخاذ إجراء", { max: 80 }),
    scheduledAt: date(body.scheduledAt, "موعد النشر"),
    campaignId: str(body.campaignId, "الحملة"),
    productId: str(body.productId, "المنتج"),
    brief: (body.brief && typeof body.brief === "object" ? body.brief : undefined) as Prisma.InputJsonValue | undefined,
    aiGenerated: opts.aiGenerated === true,
  };
  return prisma.$transaction(async (tx) => {
    if (assetIds.length) {
      const found = await tx.mktAsset.count({ where: { id: { in: assetIds }, archived: false } });
      if (found !== assetIds.length) throw new MktError("بعض الوسائط غير موجودة أو مؤرشفة.", "Some assets are missing or archived.");
    }
    const post = await tx.mktPost.create({
      data: {
        ...data, createdById: actor.id, status: "DRAFT",
        variants: { create: platforms.map((platform) => ({ platform })) },
        assets: { create: assetIds.map((assetId, position) => ({ assetId, position })) },
      },
    });
    await tx.mktPostChange.create({ data: { postId: post.id, actorId: actor.id, actorName: actor.name, field: "created", after: data.title } });
    await audit(tx, userActor(actor), "post.created", "MktPost", post.id, { after: { ...data, platforms, assetIds } });
    return post.id;
  }, TX_OPTS).then(getPost).then(serializePost);
}

const TRACKED: (keyof Prisma.MktPostUncheckedUpdateInput)[] = ["title", "objective", "audience", "contentType", "caption", "hashtags", "link", "cta", "campaignId", "productId"];

export async function updatePost(id: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "content_manage")) throw denied();
  const reason = str(body.reason, "سبب التعديل", { max: 500 });
  return prisma.$transaction(async (tx) => {
    const p = await tx.mktPost.findUnique({ where: { id }, include: POST_INCLUDE });
    if (!p) throw notFound();
    if (!EDITABLE.includes(p.status)) throw new MktError("لا يمكن تعديل منشور قيد النشر أو منشور أو ملغى.", "This post can no longer be edited.", 409);
    const data: Prisma.MktPostUncheckedUpdateInput = {};
    if ("title" in body) data.title = str(body.title, "اسم المنشور", { max: 200, required: true })!;
    if ("objective" in body) data.objective = oneOf(body.objective, POST_OBJECTIVES, "الهدف");
    if ("audience" in body) data.audience = str(body.audience, "الجمهور", { max: 500 });
    if ("contentType" in body) data.contentType = oneOf(body.contentType, CONTENT_TYPES, "نوع المحتوى");
    if ("caption" in body) data.caption = str(body.caption, "النص", { max: 63000 }) ?? "";
    if ("hashtags" in body) data.hashtags = readHashtags(body.hashtags);
    if ("link" in body) data.link = url(body.link, "الرابط");
    if ("cta" in body) data.cta = str(body.cta, "الدعوة لاتخاذ إجراء", { max: 80 });
    if ("campaignId" in body) data.campaignId = str(body.campaignId, "الحملة");
    if ("productId" in body) data.productId = str(body.productId, "المنتج");
    if ("brief" in body) data.brief = (body.brief && typeof body.brief === "object" ? body.brief : null) as Prisma.InputJsonValue;
    if ("platforms" in body) {
      const want = readPlatforms(body.platforms);
      const have = p.variants.map((v) => v.platform);
      const drop = have.filter((x) => !want.includes(x));
      if (p.variants.some((v) => drop.includes(v.platform) && ["PUBLISHED", "MANUAL_DONE", "PUBLISHING"].includes(v.status))) throw new MktError("لا يمكن حذف منصة نُشر عليها المنشور.", "Cannot drop a platform already published.", 409);
      await tx.mktPostVariant.deleteMany({ where: { postId: id, platform: { in: drop } } });
      for (const platform of want.filter((x) => !have.includes(x))) await tx.mktPostVariant.create({ data: { postId: id, platform } });
    }
    if (Array.isArray(body.variants)) {
      for (const v of body.variants as Record<string, unknown>[]) {
        const platform = String(v.platform ?? "");
        if (!p.variants.some((x) => x.platform === platform) && !(Array.isArray(body.platforms) && (body.platforms as string[]).includes(platform))) continue;
        await tx.mktPostVariant.update({ where: { postId_platform: { postId: id, platform } }, data: { caption: str(v.caption, "نص المنصة", { max: 63000 }), hashtags: readHashtags(v.hashtags) } });
      }
    }
    if ("assetIds" in body) {
      const assetIds = strList(body.assetIds, "الوسائط", 10);
      const found = await tx.mktAsset.count({ where: { id: { in: assetIds } } });
      if (found !== assetIds.length) throw new MktError("بعض الوسائط غير موجودة.", "Some assets are missing.");
      await tx.mktPostAsset.deleteMany({ where: { postId: id } });
      for (const [position, assetId] of assetIds.entries()) await tx.mktPostAsset.create({ data: { postId: id, assetId, position } });
    }

    const after = await tx.mktPost.update({ where: { id }, data, include: POST_INCLUDE });
    const contentChanged = snapshotHash(postSnapshot(p)) !== snapshotHash(postSnapshot(after));
    for (const f of TRACKED) {
      const b = JSON.stringify((p as Record<string, unknown>)[f] ?? null);
      const a = JSON.stringify((after as Record<string, unknown>)[f] ?? null);
      if (b !== a) await tx.mktPostChange.create({ data: { postId: id, actorId: actor.id, actorName: actor.name, field: String(f), before: b.slice(0, 2000), after: a.slice(0, 2000), reason } });
    }
    if (contentChanged && ["IN_REVIEW", "APPROVED", "SCHEDULED", "FAILED"].includes(p.status)) {
      // The approver saw different content: back to draft, and nothing queued may go out.
      await cancelOpenApprovals(tx, "POST", id, "عُدّل المحتوى بعد الطلب");
      await tx.mktPublishJob.updateMany({ where: { variant: { postId: id }, status: { in: ["QUEUED", "FAILED"] } }, data: { status: "CANCELLED" } });
      await tx.mktPostVariant.updateMany({ where: { postId: id, status: { in: ["QUEUED", "FAILED", "PENDING"] } }, data: { status: "PENDING", lastError: null } });
      await tx.mktPost.update({ where: { id }, data: { status: "DRAFT" } });
      await tx.mktPostChange.create({ data: { postId: id, actorId: actor.id, actorName: actor.name, field: "status", before: p.status, after: "DRAFT", reason: "تعديل المحتوى يلغي الاعتماد" } });
    }
    await audit(tx, userActor(actor), "post.updated", "MktPost", id, { before: postSnapshot(p), after: postSnapshot(after), note: reason });
    return id;
  }, TX_OPTS).then(getPost).then(serializePost);
}

/** Drag-and-drop on the calendar: only the time moves. A reason is required once the post is approved. */
export async function reschedulePost(id: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "content_manage")) throw denied();
  const when = date(body.scheduledAt, "موعد النشر");
  const reason = str(body.reason, "سبب التغيير", { max: 500 });
  return prisma.$transaction(async (tx) => {
    const p = await tx.mktPost.findUnique({ where: { id } });
    if (!p) throw notFound();
    if (!EDITABLE.includes(p.status)) throw new MktError("لا يمكن تغيير موعد منشور قيد النشر أو منشور أو ملغى.", "Cannot move this post.", 409);
    if (when && when.getTime() < Date.now() - 60_000 && ["APPROVED", "SCHEDULED"].includes(p.status)) throw new MktError("لا يمكن جدولة منشور معتمد في وقت مضى.", "Cannot schedule an approved post in the past.");
    if (["APPROVED", "SCHEDULED", "IN_REVIEW"].includes(p.status) && !reason) throw new MktError("اذكر سبب تغيير الموعد.", "A reason is required.", 400, "MKT_REASON_REQUIRED");
    let status = p.status;
    if (p.status === "SCHEDULED" && !when) status = "APPROVED";
    if (p.status === "APPROVED" && when) status = "SCHEDULED";
    await tx.mktPost.update({ where: { id }, data: { scheduledAt: when, status } });
    await tx.mktPostChange.create({ data: { postId: id, actorId: actor.id, actorName: actor.name, field: "scheduledAt", before: p.scheduledAt?.toISOString() ?? null, after: when?.toISOString() ?? null, reason } });
    await audit(tx, userActor(actor), "post.rescheduled", "MktPost", id, { before: { scheduledAt: p.scheduledAt }, after: { scheduledAt: when }, note: reason });
    return id;
  }, TX_OPTS).then(getPost).then(serializePost);
}

export type Readiness = { blocking: string[]; warnings: string[]; perPlatform: Record<string, string[]> };

/** The readiness notes, in the viewer's language (Arabic unless asked otherwise). */
export async function readiness(p: PostRow, lang: "ar" | "en" = "ar"): Promise<Readiness> {
  const T = (ar: string, en: string) => (lang === "en" ? en : ar);
  const blocking: string[] = [];
  const warnings: string[] = [];
  const perPlatform: Record<string, string[]> = {};
  if (p.variants.length === 0) blocking.push(T("اختر منصة واحدة على الأقل.", "Choose at least one platform."));
  if (!p.caption.trim() && p.variants.every((v) => !v.caption?.trim()) && p.assets.length === 0) blocking.push(T("المنشور بلا نص ولا وسائط.", "The post has no text and no media."));
  if (p.scheduledAt && p.scheduledAt.getTime() < Date.now() - 60_000) warnings.push(T("موعد النشر في الماضي؛ سيُنشر عند أول تشغيل لقائمة النشر.", "The publish time is in the past; it will go out on the next run of the publishing queue."));
  if (!p.scheduledAt) warnings.push(T("لا يوجد موعد نشر؛ سيبقى معتمداً دون جدولة.", "No publish time; it will stay approved but unscheduled."));
  const kinds = p.assets.map((a) => (a.asset.versions[0] ? kindOfMime(a.asset.versions[0].mimeType as MediaType) : a.asset.kind === "COPY" ? "text" : "unknown"));
  for (const v of p.variants) {
    const w = variantWarnings(v.platform, v.caption ?? p.caption, v.hashtags.length ? v.hashtags : p.hashtags, kinds, lang);
    if (w.length) perPlatform[v.platform] = w;
    if (PLATFORM[v.platform]?.organic?.adapter !== "IMPLEMENTED") (perPlatform[v.platform] ??= []).push(T("النشر على هذه المنصة يدوي: سيُجهّز المحتوى ويُطلب تأكيد الرابط بعد نشره.", "Publishing on this platform is manual: the content is prepared, and the link is confirmed after it is posted."));
  }
  if (p.link && !p.campaignId) warnings.push(T("المنشور يحتوي رابطاً دون حملة؛ لن يُتتبع أثره في المبيعات.", "The post has a link but no campaign; its effect on sales will not be tracked."));
  const dup = p.caption.trim()
    ? await prisma.mktPost.findFirst({ where: { id: { not: p.id }, status: { not: "CANCELLED" }, caption: p.caption }, select: { title: true } })
    : null;
  if (dup) warnings.push(T(`النص مطابق لمنشور آخر («${dup.title}»).`, `The text matches another post ("${dup.title}").`));
  return { blocking, warnings, perPlatform };
}

/** «إرسال للاعتماد» / «جدولة»: readiness, then approval per policy, else straight to the schedule. */
export async function submitPost(id: string, actor: Actor, note: string | null) {
  if (!can(actor, "publish")) throw denied("لا تملك صلاحية إرسال المحتوى للنشر.");
  const settings = await loadSettings();
  const p = await getPost(id);
  if (!["DRAFT", "FAILED"].includes(p.status)) throw new MktError("المنشور ليس مسودة.", "Only drafts can be submitted.", 409);
  const r = await readiness(p);
  if (r.blocking.length) throw new MktError(r.blocking.join(" "), "The post is not ready.", 400, "MKT_NOT_READY");
  const needs = approvalRequired(settings, p.aiGenerated ? "aiPublish" : "publish");
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.mktPost.findUnique({ where: { id }, include: POST_INCLUDE });
    if (!fresh || !["DRAFT", "FAILED"].includes(fresh.status)) throw new MktError("تغيّرت حالة المنشور.", "Post status changed.", 409);
    if (needs) {
      const a = await openApproval(tx, { subjectType: "POST", subjectId: id, action: p.aiGenerated ? "ai_publish" : "publish", payload: postSnapshot(fresh), actor, note });
      await tx.mktPost.update({ where: { id }, data: { status: "IN_REVIEW" } });
      await tx.mktPostChange.create({ data: { postId: id, actorId: actor.id, actorName: actor.name, field: "status", before: fresh.status, after: "IN_REVIEW", reason: note } });
      return { status: "IN_REVIEW", approvalId: a.id };
    }
    const status = fresh.scheduledAt ? "SCHEDULED" : "APPROVED";
    await tx.mktPost.update({ where: { id }, data: { status } });
    await tx.mktPostChange.create({ data: { postId: id, actorId: actor.id, actorName: actor.name, field: "status", before: fresh.status, after: status, reason: "لا تتطلب السياسة اعتماداً" } });
    await audit(tx, userActor(actor), "post.submitted", "MktPost", id, { after: { status } });
    return { status, approvalId: null };
  }, TX_OPTS);
}

export async function applyPostApproval(tx: Prisma.TransactionClient, approval: { subjectId: string; payloadHash: string }, approver: { id: string; name: string }) {
  const p = await tx.mktPost.findUnique({ where: { id: approval.subjectId }, include: POST_INCLUDE });
  if (!p) throw notFound();
  if (p.status !== "IN_REVIEW") throw new MktError("المنشور لم يعد بانتظار الاعتماد.", "The post is no longer in review.", 409, "MKT_STALE_APPROVAL");
  if (snapshotHash(postSnapshot(p)) !== approval.payloadHash) throw new MktError("تغيّر المحتوى بعد طلب الاعتماد.", "The content changed after the request.", 409, "MKT_STALE_APPROVAL");
  const status = p.scheduledAt ? "SCHEDULED" : "APPROVED";
  await tx.mktPost.update({ where: { id: p.id }, data: { status } });
  await tx.mktPostChange.create({ data: { postId: p.id, actorId: approver.id, actorName: approver.name, field: "status", before: "IN_REVIEW", after: status, reason: "اعتماد" } });
}

export async function rejectPostApproval(tx: Prisma.TransactionClient, subjectId: string, approver: { id: string; name: string }, note: string | null) {
  const p = await tx.mktPost.findUnique({ where: { id: subjectId } });
  if (p?.status === "IN_REVIEW") {
    await tx.mktPost.update({ where: { id: subjectId }, data: { status: "DRAFT" } });
    await tx.mktPostChange.create({ data: { postId: subjectId, actorId: approver.id, actorName: approver.name, field: "status", before: "IN_REVIEW", after: "DRAFT", reason: note ?? "رُفض الاعتماد" } });
  }
}

export async function cancelPost(id: string, actor: Actor, reason: string | null) {
  if (!can(actor, "content_manage")) throw denied();
  return prisma.$transaction(async (tx) => {
    const p = await tx.mktPost.findUnique({ where: { id }, include: { variants: true } });
    if (!p) throw notFound();
    if (["PUBLISHED", "PUBLISHING", "CANCELLED"].includes(p.status)) throw new MktError("لا يمكن إلغاء هذا المنشور.", "Cannot cancel this post.", 409);
    await cancelOpenApprovals(tx, "POST", id, "أُلغي المنشور");
    await tx.mktPublishJob.updateMany({ where: { variant: { postId: id }, status: { in: ["QUEUED", "FAILED", "MANUAL_REQUIRED"] } }, data: { status: "CANCELLED" } });
    await tx.mktPostVariant.updateMany({ where: { postId: id, status: { notIn: ["PUBLISHED", "MANUAL_DONE"] } }, data: { status: "CANCELLED" } });
    await tx.mktPost.update({ where: { id }, data: { status: "CANCELLED" } });
    await tx.mktPostChange.create({ data: { postId: id, actorId: actor.id, actorName: actor.name, field: "status", before: p.status, after: "CANCELLED", reason } });
    await audit(tx, userActor(actor), "post.cancelled", "MktPost", id, { before: { status: p.status }, note: reason });
  }, TX_OPTS);
}

export async function postHistory(id: string) {
  return prisma.mktPostChange.findMany({ where: { postId: id }, orderBy: { at: "desc" }, take: 200 });
}

// ── Plan insights: gaps, duplicates, objective mix, best hours ─────────────────────────────

export async function planInsights(from: Date, to: Date, timezone: string) {
  const posts = await prisma.mktPost.findMany({ where: { scheduledAt: { gte: from, lt: to }, status: { not: "CANCELLED" } }, select: { id: true, title: true, caption: true, objective: true, scheduledAt: true, variants: { select: { platform: true } } } });
  const days = new Set(posts.map((p) => dayKey(p.scheduledAt!, timezone)));
  const gaps: string[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += 86_400_000) {
    const k = dayKey(new Date(t), timezone);
    if (!days.has(k)) gaps.push(k);
  }
  const mix: Record<string, number> = {};
  for (const p of posts) mix[p.objective] = (mix[p.objective] ?? 0) + 1;
  const norm = (s: string) => s.replace(/[#\s\p{P}]+/gu, " ").trim().toLowerCase();
  const dupes: { a: string; b: string; similarity: number }[] = [];
  for (let i = 0; i < posts.length; i++) for (let j = i + 1; j < posts.length; j++) {
    const a = norm(posts[i].caption), b = norm(posts[j].caption);
    if (!a || !b) continue;
    const sim = jaccard(a, b);
    if (sim >= 0.8) dupes.push({ a: posts[i].title, b: posts[j].title, similarity: Math.round(sim * 100) });
  }
  return { total: posts.length, gaps: [...new Set(gaps)], objectiveMix: mix, duplicates: dupes.slice(0, 20) };
}

function dayKey(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function jaccard(a: string, b: string): number {
  const A = new Set(a.split(" ")), B = new Set(b.split(" "));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

/**
 * Suggested hours per platform from this account's own published posts: average engagements of
 * POST-level snapshots by the local hour of publication. Needs at least 5 measured posts per
 * platform; below that the answer is «بيانات غير كافية», never a generic "best time".
 */
export async function bestHours(timezone: string) {
  const variants = await prisma.mktPostVariant.findMany({ where: { publishedAt: { not: null }, externalPostId: { not: null } }, select: { platform: true, publishedAt: true, externalPostId: true }, take: 2000, orderBy: { publishedAt: "desc" } });
  const metrics = await prisma.mktMetricSnapshot.groupBy({ by: ["platform", "externalId"], where: { level: "POST", externalId: { in: variants.map((v) => v.externalPostId!) } }, _sum: { engagements: true } });
  const eng = new Map(metrics.map((m) => [`${m.platform}:${m.externalId}`, m._sum.engagements]));
  const out: Record<string, { measured: number; hours: { hour: number; avgEngagements: number; posts: number }[] | null }> = {};
  const by = new Map<string, Map<number, number[]>>();
  for (const v of variants) {
    const e = eng.get(`${v.platform}:${v.externalPostId}`);
    if (e === null || e === undefined) continue;
    const h = localHour(v.publishedAt!, timezone);
    const m = by.get(v.platform) ?? new Map<number, number[]>();
    (m.get(h) ?? m.set(h, []).get(h)!).push(e);
    by.set(v.platform, m);
  }
  for (const [platform, hours] of by) {
    const measured = [...hours.values()].reduce((n, l) => n + l.length, 0);
    out[platform] = {
      measured,
      hours: measured < 5 ? null : [...hours.entries()].map(([hour, l]) => ({ hour, posts: l.length, avgEngagements: Math.round(l.reduce((a, b) => a + b, 0) / l.length) })).sort((a, b) => b.avgEngagements - a.avgEngagements).slice(0, 3),
    };
  }
  return out;
}
