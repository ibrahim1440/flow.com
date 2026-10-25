import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { runPublisher } from "./publishing";
import { runJourneys, runSender } from "./messaging";
import { raiseAlerts } from "./alerts";
import { evaluateCampaign } from "./decisions";
import { lastDays } from "../kpi";

/**
 * The marketing automation engine's scheduler entry. Every job run is recorded (MktJobRun) with
 * what it did; a failing job never stops the others. Each job re-reads the kill switches itself
 * before any external call. Called by the cron route (CRON_SECRET) and by «تشغيل الآن».
 */

export const JOBS = [
  { key: "publisher", ar: "قائمة النشر", schedule: "كل دقيقة إلى 15 دقيقة (حسب المجدول)", detail: "ينشر المنشورات المستحقة أو يحولها للنشر اليدوي، ويعيد المحاولة بأمان." },
  { key: "journeys", ar: "رحلات العملاء", schedule: "مع كل تشغيل", detail: "يقيّم السلال المتروكة: إيقاف، انتظار، أو تجهيز رسالة." },
  { key: "sender", ar: "مرسل واتساب", schedule: "مع كل تشغيل", detail: "يرسل الرسائل المستحقة بعد فحص الموافقة والحدود والإيقاف الطارئ." },
  { key: "alerts", ar: "التنبيهات", schedule: "مع كل تشغيل", detail: "الميزانيات، فشل النشر، الربط، البيانات المتأخرة، رموز UTM المجهولة." },
  { key: "decisions", ar: "محرك القرارات", schedule: "مرة يومياً", detail: "يقيّم الحملات النشطة آخر 7 أيام ويحفظ التوصية مع أدلتها (لا ينفّذ شيئاً)." },
] as const;

async function record<T>(job: string, trigger: string, fn: () => Promise<T>): Promise<{ job: string; status: string; summary?: T; error?: string }> {
  const run = await prisma.mktJobRun.create({ data: { job, trigger, status: "RUNNING" } });
  try {
    const summary = await fn();
    const skipped = (summary as { skipped?: string | null })?.skipped;
    await prisma.mktJobRun.update({ where: { id: run.id }, data: { status: skipped ? "SKIPPED" : "SUCCEEDED", finishedAt: new Date(), summary: JSON.parse(JSON.stringify(summary ?? {})) as Prisma.InputJsonValue } });
    return { job, status: skipped ? "SKIPPED" : "SUCCEEDED", summary };
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 500) : "unknown";
    await prisma.mktJobRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error: detail } });
    return { job, status: "FAILED", error: detail };
  }
}

export async function runMarketingJobs(trigger: "cron" | "manual", now = new Date()) {
  const out = [];
  out.push(await record("publisher", trigger, () => runPublisher(now)));
  out.push(await record("journeys", trigger, () => runJourneys(now)));
  out.push(await record("sender", trigger, () => runSender(now)));
  out.push(await record("alerts", trigger, () => raiseAlerts(now)));
  const lastDecisions = await prisma.mktJobRun.findFirst({ where: { job: "decisions", status: "SUCCEEDED" }, orderBy: { startedAt: "desc" } });
  if (!lastDecisions || lastDecisions.startedAt.getTime() < now.getTime() - 20 * 3600_000) {
    out.push(await record("decisions", trigger, async () => {
      const active = await prisma.mktCampaign.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
      const { from, to } = lastDays(7, now); // seven whole Riyadh days, today included
      const verdicts: Record<string, string> = {};
      for (const c of active) verdicts[c.id] = (await evaluateCampaign(c.id, from, to, null)).decision.verdict;
      return { evaluated: active.length, verdicts };
    }));
  }
  return out;
}

export async function recentRuns() {
  return prisma.mktJobRun.findMany({ orderBy: { startedAt: "desc" }, take: 60 });
}
