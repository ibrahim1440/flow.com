import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

type Tx = Prisma.TransactionClient | typeof prisma;

export const APPROVAL_ACTIONS = [
  { key: "publish", ar: "نشر المحتوى", en: "Publishing" },
  { key: "aiPublish", ar: "نشر محتوى مولّد بالذكاء الاصطناعي", en: "Publishing AI-generated content" },
  { key: "campaignCreate", ar: "تفعيل الحملات", en: "Activating campaigns" },
  { key: "budgetIncrease", ar: "زيادة الميزانيات", en: "Budget increases" },
  { key: "campaignPause", ar: "إيقاف الحملات", en: "Pausing campaigns" },
  { key: "trackingChange", ar: "تعديل إعدادات التتبع", en: "Tracking changes" },
  { key: "sensitiveReply", ar: "الردود الحساسة", en: "Sensitive replies" },
  { key: "messageCampaign", ar: "حملات رسائل واتساب", en: "WhatsApp message campaigns" },
  { key: "journeyActivate", ar: "تفعيل رحلات العملاء الآلية", en: "Activating automated journeys" },
] as const;

export type ApprovalActionKey = (typeof APPROVAL_ACTIONS)[number]["key"];

/** The settings row, created on first use. INSERT … ON CONFLICT DO NOTHING: safe when several requests (or several reads of one request) race to create it, and inside a transaction. */
export async function loadSettings(tx: Tx = prisma) {
  const row = await tx.mktSettings.findUnique({ where: { id: "default" } });
  if (row) return row;
  await tx.mktSettings.createMany({ data: [{ id: "default" }], skipDuplicates: true });
  return tx.mktSettings.findUniqueOrThrow({ where: { id: "default" } });
}

export type MktSettingsRow = Awaited<ReturnType<typeof loadSettings>>;

/** Missing from the stored policy = required. Only an explicit `false` waives it. */
export function approvalRequired(settings: { approvalPolicy: unknown }, action: ApprovalActionKey): boolean {
  const p = (settings.approvalPolicy ?? {}) as Record<string, unknown>;
  return p[action] !== false;
}

export type KillScope = "publishing" | "ads" | "messaging";

export function killed(settings: { killAll: boolean; killPublishing: boolean; killAds: boolean; killMessaging: boolean }, scope: KillScope): boolean {
  if (settings.killAll) return true;
  return scope === "publishing" ? settings.killPublishing : scope === "ads" ? settings.killAds : settings.killMessaging;
}
