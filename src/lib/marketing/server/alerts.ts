import "server-only";
import { prisma } from "@/lib/db";
import { listBudgets } from "./budgets";
import { loadSettings } from "./settings";
import { PLATFORM } from "../platforms";

type Raised = { kind: string; severity: "INFO" | "WARNING" | "CRITICAL"; title: string; detail?: string; subjectType?: string; subjectId?: string; dedupeKey: string };

/** The kinds this job owns: an open alert of these kinds that is not raised again is resolved. */
const MANAGED = ["BUDGET_PACE", "BUDGET_EXCEEDED", "PUBLISH_FAILED", "MANUAL_OVERDUE", "CONNECTION", "APPROVAL_AGING", "DATA_STALE", "UNKNOWN_UTM", "STORE_SILENT", "MESSAGE_FAILURES"];

export async function raiseAlerts(now = new Date()) {
  const s = await loadSettings();
  const raised: Raised[] = [];
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone, year: "numeric", month: "2-digit" }).format(now).slice(0, 7);
  const budget = await listBudgets(month, now).catch(() => null);
  for (const l of budget?.lines ?? []) {
    const name = l.scope === "TOTAL" ? "الميزانية الكلية" : l.scope === "CAMPAIGN" ? `حملة ${l.campaign?.name ?? ""}` : l.scope === "PLATFORM" ? PLATFORM[l.scopeRef ?? ""]?.ar ?? l.scopeRef : `منتج`;
    if (l.pacing.status === "EXCEEDED") raised.push({ kind: "BUDGET_EXCEEDED", severity: "CRITICAL", title: `تجاوز الإنفاق ميزانية ${name}`, detail: `المخطط ${l.planned} والفعلي ${l.pacing.actual}`, subjectType: "MktBudget", subjectId: l.id, dedupeKey: `budget-exceeded:${l.id}` });
    else if (l.pacing.status === "OVER_PACE") raised.push({ kind: "BUDGET_PACE", severity: "WARNING", title: `وتيرة إنفاق ${name} أعلى من الخطة`, detail: `المتوقع حتى نهاية الفترة ${l.pacing.forecast} مقابل ${l.planned}`, subjectType: "MktBudget", subjectId: l.id, dedupeKey: `budget-pace:${l.id}` });
  }
  const failed = await prisma.mktPostVariant.findMany({ where: { status: "FAILED" }, select: { id: true, platform: true, post: { select: { id: true, title: true } } }, take: 50 });
  for (const v of failed) raised.push({ kind: "PUBLISH_FAILED", severity: "CRITICAL", title: `فشل نشر «${v.post.title}» على ${PLATFORM[v.platform]?.ar ?? v.platform}`, subjectType: "MktPost", subjectId: v.post.id, dedupeKey: `publish-failed:${v.id}` });
  const overdue = await prisma.mktPostVariant.findMany({ where: { status: "MANUAL_REQUIRED", post: { scheduledAt: { lt: new Date(now.getTime() - 2 * 3600_000) } } }, select: { id: true, platform: true, post: { select: { id: true, title: true } } }, take: 50 });
  for (const v of overdue) raised.push({ kind: "MANUAL_OVERDUE", severity: "WARNING", title: `«${v.post.title}» بانتظار النشر اليدوي على ${PLATFORM[v.platform]?.ar ?? v.platform}`, subjectType: "MktPost", subjectId: v.post.id, dedupeKey: `manual-overdue:${v.id}` });
  const conns = await prisma.mktConnection.findMany({ where: { status: { in: ["EXPIRED", "ERROR", "CONNECTED"] } } });
  for (const c of conns) {
    const soon = c.tokenExpiresAt && c.tokenExpiresAt.getTime() - now.getTime() < 7 * 86_400_000;
    if (c.status !== "CONNECTED" || soon) raised.push({ kind: "CONNECTION", severity: c.status === "CONNECTED" ? "WARNING" : "CRITICAL", title: `${PLATFORM[c.platform]?.ar ?? c.platform}: ${c.status === "EXPIRED" ? "انتهت صلاحية الربط" : c.status === "ERROR" ? "خطأ في الربط" : "الربط ينتهي خلال أسبوع"}`, detail: c.lastError ?? undefined, subjectType: "MktConnection", subjectId: c.platform, dedupeKey: `connection:${c.platform}` });
  }
  const aging = await prisma.mktApproval.count({ where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - 24 * 3600_000) } } });
  if (aging) raised.push({ kind: "APPROVAL_AGING", severity: "WARNING", title: `${aging} طلب اعتماد معلّق منذ أكثر من يوم`, dedupeKey: "approval-aging" });
  const active = await prisma.mktCampaign.findMany({ where: { status: "ACTIVE", channels: { hasSome: ["META_ADS", "TIKTOK_ADS", "SNAP_ADS", "GOOGLE_ADS", "X_ADS"] } }, select: { id: true, name: true } });
  for (const c of active) {
    const last = await prisma.mktMetricSnapshot.findFirst({ where: { campaignId: c.id }, orderBy: { day: "desc" }, select: { day: true } });
    if (!last || last.day.getTime() < now.getTime() - 3 * 86_400_000) raised.push({ kind: "DATA_STALE", severity: "WARNING", title: `لا بيانات أداء حديثة لحملة «${c.name}»`, detail: last ? `آخر يوم: ${last.day.toISOString().slice(0, 10)}` : "لم تُسجل أي بيانات", subjectType: "MktCampaign", subjectId: c.id, dedupeKey: `stale:${c.id}` });
  }
  const unknown = await prisma.mktStoreOrder.groupBy({ by: ["utmCampaign"], where: { campaignId: null, utmCampaign: { not: null }, placedAt: { gte: new Date(now.getTime() - 14 * 86_400_000) } }, _count: { _all: true } });
  for (const u of unknown) raised.push({ kind: "UNKNOWN_UTM", severity: "INFO", title: `طلبات برمز حملة غير معرّف «${u.utmCampaign}»`, detail: `${u._count._all} طلب — أنشئ الحملة بهذا الرمز أو صحّح الروابط`, dedupeKey: `utm:${u.utmCampaign}` });
  const store = await prisma.mktConnection.findUnique({ where: { platform: "STORE" } });
  if (store && store.status !== "NOT_CONFIGURED" && store.status !== "DISABLED") {
    const lastHook = await prisma.mktWebhookEvent.findFirst({ where: { source: "STORE" }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } });
    if (!lastHook || lastHook.receivedAt.getTime() < now.getTime() - 48 * 3600_000) raised.push({ kind: "STORE_SILENT", severity: "WARNING", title: "لم تصل بيانات من المتجر منذ أكثر من 48 ساعة", detail: "تحقق من إعداد ربط المتجر (Webhook)", dedupeKey: "store-silent" });
  }
  const msgFails = await prisma.mktMessage.count({ where: { status: "FAILED", failedAt: { gte: new Date(now.getTime() - 24 * 3600_000) } } });
  if (msgFails) raised.push({ kind: "MESSAGE_FAILURES", severity: "WARNING", title: `${msgFails} رسالة واتساب فشلت خلال 24 ساعة`, dedupeKey: "message-failures" });

  for (const a of raised) {
    await prisma.mktAlert.upsert({ where: { dedupeKey: a.dedupeKey }, create: { ...a }, update: { title: a.title, detail: a.detail ?? null, severity: a.severity } });
    // A resolved alert whose condition returns is reopened.
    await prisma.mktAlert.updateMany({ where: { dedupeKey: a.dedupeKey, status: "RESOLVED" }, data: { status: "OPEN", resolvedAt: null, resolvedById: null } });
  }
  const keep = new Set(raised.map((a) => a.dedupeKey));
  const open = await prisma.mktAlert.findMany({ where: { status: { in: ["OPEN", "ACKNOWLEDGED"] }, kind: { in: MANAGED } }, select: { id: true, dedupeKey: true } });
  const cleared = open.filter((a) => !keep.has(a.dedupeKey)).map((a) => a.id);
  if (cleared.length) await prisma.mktAlert.updateMany({ where: { id: { in: cleared } }, data: { status: "RESOLVED", resolvedAt: now } });
  return { raised: raised.length, resolved: cleared.length };
}
