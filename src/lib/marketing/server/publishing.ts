import "server-only";
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { MktError, notFound, url as readUrl, type Actor, can, denied } from "./http";
import { audit, userActor } from "./audit";
import { killed, loadSettings } from "./settings";
import { liveConnection, signMedia } from "./connections";
import { publishToMeta } from "./meta";
import { PLATFORM } from "../platforms";
import { kindOfMime, type MediaType } from "../media";
import { composeCaption } from "../compose";

export { composeCaption };

/**
 * The publishing queue.
 *
 *   SCHEDULED post, due ──► one MktPublishJob per platform variant (idempotency key = the variant)
 *   job ──► adapter: IMPLEMENTED + CONNECTED → official API, verified by reading the post back
 *                    anything else          → MANUAL_REQUIRED: a person publishes and confirms the URL
 *
 * ── Never twice ──
 * The job is claimed with a conditional update (QUEUED → RUNNING), so two workers never run it.
 * A retry is the SAME job: an Instagram container created by an earlier attempt is resumed, not
 * re-created. A POST whose outcome is unknown (timeout, connection lost after sending) is FAILED
 * with that note and is NEVER retried automatically — a person checks the platform first and
 * retries with an explicit "it was not published" confirmation.
 */

const BACKOFF_MIN = [1, 5, 15, 60];
const MAX_ATTEMPTS = 4;

export type PublishReport = { duePosts: number; jobsRun: number; published: number; manual: number; failed: number; skipped: string | null };

export async function runPublisher(now = new Date(), fetchImpl: typeof fetch = fetch): Promise<PublishReport> {
  const report: PublishReport = { duePosts: 0, jobsRun: 0, published: 0, manual: 0, failed: 0, skipped: null };
  const settings = await loadSettings();
  if (killed(settings, "publishing")) return { ...report, skipped: "KILL_SWITCH" };

  // 1. Due posts → jobs.
  const due = await prisma.mktPost.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: now } }, select: { id: true }, take: 50 });
  for (const { id } of due) {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.mktPost.updateMany({ where: { id, status: "SCHEDULED" }, data: { status: "PUBLISHING" } });
      if (moved.count === 0) return;
      report.duePosts++;
      const variants = await tx.mktPostVariant.findMany({ where: { postId: id, status: { in: ["PENDING", "QUEUED"] } } });
      for (const v of variants) {
        await tx.mktPublishJob.upsert({
          where: { idempotencyKey: `variant:${v.id}` },
          create: { variantId: v.id, idempotencyKey: `variant:${v.id}`, status: "QUEUED", runAt: now },
          update: {},
        });
        await tx.mktPostVariant.update({ where: { id: v.id }, data: { status: "QUEUED" } });
      }
      await tx.mktPostChange.create({ data: { postId: id, field: "status", before: "SCHEDULED", after: "PUBLISHING", reason: "حان موعد النشر" } });
    }, TX_OPTS);
  }

  // 2. Run queued jobs, one claim at a time.
  const jobs = await prisma.mktPublishJob.findMany({ where: { status: "QUEUED", runAt: { lte: now } }, orderBy: { runAt: "asc" }, take: 20, select: { id: true } });
  for (const { id } of jobs) {
    const s = await loadSettings();
    if (killed(s, "publishing")) { report.skipped = "KILL_SWITCH"; break; }
    const claimed = await prisma.mktPublishJob.updateMany({ where: { id, status: "QUEUED" }, data: { status: "RUNNING", lockedAt: new Date(), attempts: { increment: 1 } } });
    if (claimed.count === 0) continue;
    report.jobsRun++;
    const outcome = await runJob(id, fetchImpl);
    report[outcome]++;
  }
  return report;
}

async function runJob(jobId: string, fetchImpl: typeof fetch): Promise<"published" | "manual" | "failed"> {
  const job = await prisma.mktPublishJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { variant: { include: { post: { include: { assets: { orderBy: { position: "asc" }, include: { asset: { include: { versions: { orderBy: { version: "desc" }, take: 1 } } } } }, campaign: true } } } } },
  });
  const v = job.variant;
  const post = v.post;
  const def = PLATFORM[v.platform];
  const caption = composeCaption(v.caption ?? post.caption, v.hashtags.length ? v.hashtags : post.hashtags, post.link, post.cta);

  const manual = async (why: string) => {
    await prisma.$transaction(async (tx) => {
      await tx.mktPublishJob.update({ where: { id: jobId }, data: { status: "MANUAL_REQUIRED", lastError: why, lockedAt: null } });
      await tx.mktPostVariant.update({ where: { id: v.id }, data: { status: "MANUAL_REQUIRED", lastError: why } });
      await audit(tx, { kind: "SYSTEM" }, "publish.manual_required", "MktPostVariant", v.id, { note: why });
      await rollUp(tx, post.id);
    }, TX_OPTS);
    return "manual" as const;
  };

  if (def?.organic?.adapter !== "IMPLEMENTED" || (v.platform !== "FACEBOOK" && v.platform !== "INSTAGRAM")) return manual("لا يوجد نشر آلي لهذه المنصة في هذا الإصدار — انشره يدوياً ثم أكّد الرابط.");
  const conn = await liveConnection(v.platform);
  if (!conn) return manual("الحساب غير متصل أو لم يُتحقق منه — انشره يدوياً أو اربط الحساب.");
  const targetId = conn.config[v.platform === "FACEBOOK" ? "pageId" : "igUserId"];
  if (!targetId) return manual("معرف الصفحة/الحساب غير مضبوط في التكاملات.");

  const image = post.assets.map((a) => a.asset.versions[0]).find((ver) => ver && kindOfMime(ver.mimeType as MediaType) === "image");
  const video = post.assets.some((a) => a.asset.versions[0] && kindOfMime(a.asset.versions[0].mimeType as MediaType) === "video");
  if (video) return manual("نشر الفيديو آلياً غير مطبّق في هذا الإصدار.");
  const imageUrl = image ? signMedia(image.id) : null;
  if (image && !imageUrl) return manual("رابط الوسائط العام غير متاح (APP_PUBLIC_URL أو MARKETING_TOKEN_KEY غير مضبوط).");

  const containerId = job.externalId?.startsWith("container:") ? job.externalId.slice(10) : null;
  let result = await publishToMeta({ platform: v.platform, token: conn.token, targetId, caption, link: post.link, imageUrl, containerId }, fetchImpl);
  if (result.kind === "CONTAINER") {
    await prisma.mktPublishJob.update({ where: { id: jobId }, data: { externalId: `container:${result.containerId}` } });
    result = await publishToMeta({ platform: v.platform, token: conn.token, targetId, caption, link: post.link, imageUrl, containerId: result.containerId }, fetchImpl);
  }

  if (result.kind === "PUBLISHED") {
    const r = result;
    await prisma.$transaction(async (tx) => {
      await tx.mktPublishJob.update({ where: { id: jobId }, data: { status: "SUCCEEDED", externalId: r.externalId, lastError: null, lockedAt: null } });
      await tx.mktPostVariant.update({ where: { id: v.id }, data: { status: "PUBLISHED", externalPostId: r.externalId, externalUrl: r.url, publishedAt: new Date(), lastError: null } });
      await audit(tx, { kind: "SYSTEM" }, "publish.published", "MktPostVariant", v.id, { after: { platform: v.platform, externalId: r.externalId, url: r.url } });
      await rollUp(tx, post.id);
    }, TX_OPTS);
    return "published";
  }
  const f = result as Extract<typeof result, { kind: "FAILED" }>;
  const retry = f.retry && job.attempts < MAX_ATTEMPTS;
  const note = f.unknownOutcome ? `${f.detail} — قد يكون نُشر؛ تحقق من المنصة قبل إعادة المحاولة.` : f.detail;
  await prisma.$transaction(async (tx) => {
    await tx.mktPublishJob.update({
      where: { id: jobId },
      data: retry ? { status: "QUEUED", runAt: new Date(Date.now() + BACKOFF_MIN[Math.min(job.attempts - 1, BACKOFF_MIN.length - 1)] * 60_000), lastError: note, lockedAt: null } : { status: "FAILED", lastError: note, lockedAt: null },
    });
    await tx.mktPostVariant.update({ where: { id: v.id }, data: { status: retry ? "QUEUED" : "FAILED", lastError: note } });
    await audit(tx, { kind: "SYSTEM" }, retry ? "publish.retry_scheduled" : "publish.failed", "MktPostVariant", v.id, { note });
    if (!retry) await rollUp(tx, post.id);
  }, TX_OPTS);
  return "failed";
}

/** The post's status from its variants. */
export async function rollUp(tx: Prisma.TransactionClient, postId: string) {
  const vs = await tx.mktPostVariant.findMany({ where: { postId }, select: { status: true } });
  const done = vs.filter((v) => v.status === "PUBLISHED" || v.status === "MANUAL_DONE").length;
  const failed = vs.filter((v) => v.status === "FAILED").length;
  const open = vs.length - done - failed - vs.filter((v) => v.status === "CANCELLED").length;
  const status = open > 0 ? "PUBLISHING" : done > 0 && failed === 0 ? "PUBLISHED" : done > 0 ? "PARTIAL" : failed > 0 ? "FAILED" : "CANCELLED";
  const p = await tx.mktPost.findUnique({ where: { id: postId }, select: { status: true } });
  if (p && p.status !== status) {
    await tx.mktPost.update({ where: { id: postId }, data: { status } });
    await tx.mktPostChange.create({ data: { postId, field: "status", before: p.status, after: status, reason: "نتيجة النشر" } });
  }
}

/** A person published it on the platform; they give the live URL as evidence. */
export async function confirmManual(variantId: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "publish")) throw denied();
  const link = readUrl(body.url, "رابط المنشور");
  if (!link) throw new MktError("أدخل رابط المنشور المنشور فعلياً.", "The live URL is required.", 400, "MKT_REQUIRED");
  return prisma.$transaction(async (tx) => {
    const v = await tx.mktPostVariant.findUnique({ where: { id: variantId } });
    if (!v) throw notFound();
    if (!["MANUAL_REQUIRED", "FAILED"].includes(v.status)) throw new MktError("هذه المنصة لا تنتظر تأكيداً يدوياً.", "Not awaiting manual confirmation.", 409);
    await tx.mktPostVariant.update({ where: { id: variantId }, data: { status: "MANUAL_DONE", externalUrl: link, publishedAt: new Date(), manualConfirmedById: actor.id, lastError: null } });
    await tx.mktPublishJob.updateMany({ where: { variantId, status: { in: ["MANUAL_REQUIRED", "FAILED"] } }, data: { status: "SUCCEEDED", lastError: "أُكّد يدوياً" } });
    await tx.mktPostChange.create({ data: { postId: v.postId, actorId: actor.id, actorName: actor.name, field: `variant:${v.platform}`, before: v.status, after: "MANUAL_DONE", reason: link } });
    await audit(tx, userActor(actor), "publish.manual_confirmed", "MktPostVariant", variantId, { after: { url: link } });
    await rollUp(tx, v.postId);
  }, TX_OPTS);
}

/** Retry a failed job. When the outcome was unknown, the person must state it was not published. */
export async function retryJob(variantId: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "publish")) throw denied();
  return prisma.$transaction(async (tx) => {
    const job = await tx.mktPublishJob.findFirst({ where: { variantId }, include: { variant: true } });
    if (!job) throw notFound();
    if (job.status !== "FAILED") throw new MktError("لا يمكن إعادة المحاولة إلا لعملية فاشلة.", "Only failed jobs can be retried.", 409);
    if (job.lastError?.includes("قد يكون نُشر") && body.confirmNotPublished !== true) {
      throw new MktError("نتيجة المحاولة السابقة غير معروفة؛ تأكد من المنصة أن المنشور لم يُنشر ثم أكّد ذلك.", "Confirm it was not published first.", 409, "MKT_CONFIRM_NOT_PUBLISHED");
    }
    await tx.mktPublishJob.update({ where: { id: job.id }, data: { status: "QUEUED", runAt: new Date(), attempts: 0, lastError: null } });
    await tx.mktPostVariant.update({ where: { id: variantId }, data: { status: "QUEUED", lastError: null } });
    await tx.mktPost.update({ where: { id: job.variant.postId }, data: { status: "PUBLISHING" } });
    await audit(tx, userActor(actor), "publish.retried", "MktPostVariant", variantId, { note: body.confirmNotPublished === true ? "confirmed not published" : null });
  }, TX_OPTS);
}

export async function publishingQueue() {
  const rows = await prisma.mktPostVariant.findMany({
    where: { status: { in: ["QUEUED", "PUBLISHING", "MANUAL_REQUIRED", "FAILED"] } },
    include: { post: { select: { id: true, title: true, scheduledAt: true, caption: true, hashtags: true, link: true, cta: true } }, jobs: { select: { attempts: true, runAt: true, status: true, lastError: true } } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  const recent = await prisma.mktPostVariant.findMany({
    where: { status: { in: ["PUBLISHED", "MANUAL_DONE"] } },
    include: { post: { select: { id: true, title: true } } },
    orderBy: { publishedAt: "desc" },
    take: 30,
  });
  return {
    open: rows.map((v) => ({
      variantId: v.id, platform: v.platform, status: v.status, lastError: v.lastError, post: { id: v.post.id, title: v.post.title, scheduledAt: v.post.scheduledAt },
      job: v.jobs[0] ?? null, preparedText: composeCaption(v.caption ?? v.post.caption, v.hashtags.length ? v.hashtags : v.post.hashtags, v.post.link, v.post.cta),
    })),
    recent: recent.map((v) => ({ variantId: v.id, platform: v.platform, status: v.status, url: v.externalUrl, publishedAt: v.publishedAt, post: v.post })),
  };
}
