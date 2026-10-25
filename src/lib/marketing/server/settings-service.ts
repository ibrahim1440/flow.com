import "server-only";
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { MktError, str, num, oneOf, strList, type Actor, can, denied } from "./http";
import { audit, userActor } from "./audit";
import { APPROVAL_ACTIONS, loadSettings } from "./settings";
import { MARKETING_ROLE_PRESETS } from "../roles";

export async function getAll() {
  const [settings, brand] = await Promise.all([loadSettings(), prisma.mktBrandKit.findUnique({ where: { id: "default" } })]);
  return { settings, brand, approvalActions: APPROVAL_ACTIONS, rolePresets: MARKETING_ROLE_PRESETS };
}

export async function saveSettings(body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "automation_manage")) throw denied();
  const policyIn = (body.approvalPolicy ?? {}) as Record<string, unknown>;
  const approvalPolicy: Record<string, boolean> = {};
  for (const a of APPROVAL_ACTIONS) approvalPolicy[a.key] = policyIn[a.key] !== false;
  const data = {
    approvalPolicy,
    maxMessagesPerDay: num(body.maxMessagesPerDay, "الحد اليومي للرسائل", { min: 0, max: 100000, int: true }) ?? 500,
    maxMarketingPerCustomerPerWeek: num(body.maxMarketingPerCustomerPerWeek, "رسائل العميل أسبوعياً", { min: 0, max: 14, int: true }) ?? 2,
    quietHoursStart: num(body.quietHoursStart, "بداية ساعات الهدوء", { min: 0, max: 23, int: true }) ?? 22,
    quietHoursEnd: num(body.quietHoursEnd, "نهاية ساعات الهدوء", { min: 0, max: 23, int: true }) ?? 9,
    attributionModel: oneOf(body.attributionModel, ["FIRST_TOUCH", "LAST_TOUCH", "LINEAR"] as const, "نموذج الإسناد", "LAST_TOUCH"),
    attributionWindowDays: num(body.attributionWindowDays, "نافذة الإسناد", { min: 1, max: 90, int: true }) ?? 7,
    updatedById: actor.id,
  };
  return prisma.$transaction(async (tx) => {
    const before = await loadSettings(tx);
    const row = await tx.mktSettings.update({ where: { id: "default" }, data: data as Prisma.MktSettingsUpdateInput });
    await audit(tx, userActor(actor), "settings.updated", "MktSettings", "default", { before, after: row });
    return row;
  }, TX_OPTS);
}

const KILL_FIELD = { all: "killAll", publishing: "killPublishing", ads: "killAds", messaging: "killMessaging" } as const;

export async function setKill(body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "automation_manage")) throw denied();
  const scope = oneOf(body.scope, ["all", "publishing", "ads", "messaging"] as const, "النطاق");
  const on = body.on === true;
  const reason = str(body.reason, "السبب", { max: 500 });
  if (!reason) throw new MktError("اذكر سبب تشغيل أو إيقاف مفتاح الطوارئ.", "A reason is required.", 400, "MKT_REASON_REQUIRED");
  return prisma.$transaction(async (tx) => {
    await loadSettings(tx);
    const row = await tx.mktSettings.update({ where: { id: "default" }, data: { [KILL_FIELD[scope]]: on, updatedById: actor.id } });
    // Turning a switch on also releases jobs mid-claim at once: nothing new starts after this commit.
    await audit(tx, userActor(actor), on ? "kill.on" : "kill.off", "MktSettings", scope, { after: { scope, on }, note: reason });
    return { killAll: row.killAll, killPublishing: row.killPublishing, killAds: row.killAds, killMessaging: row.killMessaging };
  }, TX_OPTS);
}

export async function saveBrandKit(body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "automation_manage") && !can(actor, "content_manage")) throw denied();
  const colors = Array.isArray(body.colors) ? (body.colors as Record<string, unknown>[]).slice(0, 12).map((c) => {
    const hex = String(c.hex ?? "");
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new MktError("لون غير صالح (يجب #RRGGBB).", "Invalid colour.");
    return { name: str(c.name, "اسم اللون", { max: 40 }) ?? hex, hex };
  }) : [];
  const fonts = Array.isArray(body.fonts) ? (body.fonts as Record<string, unknown>[]).slice(0, 6).map((f) => ({ role: str(f.role, "الاستخدام", { max: 40 }) ?? "", family: str(f.family, "الخط", { max: 80, required: true })! })) : [];
  const data = {
    brandNameAr: str(body.brandNameAr, "اسم العلامة بالعربية", { max: 80 }) ?? "حقبة",
    brandNameEn: str(body.brandNameEn, "اسم العلامة بالإنجليزية", { max: 80 }) ?? "Hiqbah",
    toneAr: str(body.toneAr, "النبرة", { max: 2000 }), toneEn: str(body.toneEn, "Tone", { max: 2000 }),
    doList: strList(body.doList, "المعتمد", 40), dontList: strList(body.dontList, "الممنوع", 40), examples: strList(body.examples, "الأمثلة", 20),
    colors, fonts, logoAssetId: str(body.logoAssetId, "الشعار"), updatedById: actor.id,
  };
  return prisma.$transaction(async (tx) => {
    const before = await tx.mktBrandKit.findUnique({ where: { id: "default" } });
    const row = await tx.mktBrandKit.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
    await audit(tx, userActor(actor), "brand.updated", "MktBrandKit", "default", { before, after: row });
    return row;
  }, TX_OPTS);
}
