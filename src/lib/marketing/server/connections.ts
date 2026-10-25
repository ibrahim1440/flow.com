import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { MktError, str, strList, date, type Actor, can, denied } from "./http";
import { audit, userActor } from "./audit";
import { decryptToken, encryptToken, tokenKeyConfigured } from "./crypto";
import { PLATFORM, PLATFORMS, missingEnv } from "../platforms";
import { checkMetaToken } from "./meta";

/**
 * Platform connections. A connection is CONNECTED only after a live check against the platform
 * answered — saving a token is PENDING. The screen shows each platform's own requirements from
 * platforms.ts beside the stored state, so "connected" never stands for "configured".
 */

export async function listConnections() {
  const rows = await prisma.mktConnection.findMany();
  const by = new Map(rows.map((r) => [r.platform, r]));
  return PLATFORMS.map((p) => {
    const r = by.get(p.key);
    return {
      platform: p.key, def: p, missingEnv: missingEnv(p),
      status: r?.status ?? "NOT_CONFIGURED", accountId: r?.accountId ?? null, accountName: r?.accountName ?? null,
      scopes: r?.scopes ?? [], tokenStored: !!r?.tokenCiphertext, tokenExpiresAt: r?.tokenExpiresAt ?? null,
      expiringSoon: !!r?.tokenExpiresAt && r.tokenExpiresAt.getTime() - Date.now() < 7 * 86_400_000,
      config: r?.config ?? {}, lastCheckedAt: r?.lastCheckedAt ?? null, lastError: r?.lastError ?? null,
    };
  });
}

/** Stores a token (encrypted) and non-secret settings; the status becomes PENDING until checked. */
export async function saveConnection(platform: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "integrations_manage")) throw denied();
  const def = PLATFORM[platform];
  if (!def) throw new MktError("منصة غير معروفة.", "Unknown platform.", 404);
  const token = str(body.token, "التوكن", { max: 4000 });
  if (token && !tokenKeyConfigured()) throw new MktError("مفتاح تشفير التوكنات MARKETING_TOKEN_KEY غير مضبوط على الخادم؛ لن يُحفظ أي توكن دون تشفير.", "MARKETING_TOKEN_KEY is not configured.", 409, "MKT_NO_TOKEN_KEY");
  const config = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? (body.config as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v !== "string" || v.length > 200 || /token|secret|password/i.test(k)) throw new MktError("إعدادات الربط تقبل معرفات نصية فقط (لا أسرار).", "Config holds ids only, never secrets.");
  }
  const data = {
    accountId: str(body.accountId, "معرف الحساب", { max: 200 }),
    accountName: str(body.accountName, "اسم الحساب", { max: 200 }),
    scopes: strList(body.scopes, "الصلاحيات", 40),
    tokenExpiresAt: date(body.tokenExpiresAt, "انتهاء التوكن"),
    config: config as Prisma.InputJsonValue,
    ...(token ? { tokenCiphertext: encryptToken(token) } : {}),
    status: "PENDING", lastError: null, connectedById: actor.id,
  };
  return prisma.$transaction(async (tx) => {
    const row = await tx.mktConnection.upsert({ where: { platform }, create: { platform, ...data }, update: data });
    await audit(tx, userActor(actor), "connection.saved", "MktConnection", platform, { after: { platform, accountId: data.accountId, scopes: data.scopes, tokenReplaced: !!token, config } });
    return { platform: row.platform, status: row.status };
  }, TX_OPTS);
}

export async function disconnect(platform: string, actor: Actor) {
  if (!can(actor, "integrations_manage")) throw denied();
  return prisma.$transaction(async (tx) => {
    await tx.mktConnection.upsert({ where: { platform }, create: { platform, status: "DISABLED" }, update: { status: "DISABLED", tokenCiphertext: null, tokenExpiresAt: null } });
    await audit(tx, userActor(actor), "connection.disconnected", "MktConnection", platform);
  }, TX_OPTS);
}

/** A live check. Only platforms with an implemented check can become CONNECTED. */
export async function checkConnection(platform: string, actor: Actor | null, fetchImpl: typeof fetch = fetch) {
  const row = await prisma.mktConnection.findUnique({ where: { platform } });
  let status = "ERROR", lastError: string | null = null, accountName: string | null = row?.accountName ?? null;
  if (!row?.tokenCiphertext) {
    status = "NOT_CONFIGURED";
    lastError = "لا يوجد توكن محفوظ.";
  } else if (row.tokenExpiresAt && row.tokenExpiresAt < new Date()) {
    status = "EXPIRED";
    lastError = "انتهت صلاحية التوكن؛ أعد الربط.";
  } else if (platform === "FACEBOOK" || platform === "INSTAGRAM") {
    const target = (row.config as Record<string, string>)[platform === "FACEBOOK" ? "pageId" : "igUserId"];
    if (!target) lastError = platform === "FACEBOOK" ? "أدخل معرف الصفحة (pageId)." : "أدخل معرف حساب إنستقرام (igUserId).";
    else {
      const r = await checkMetaToken(decryptToken(row.tokenCiphertext), target, fetchImpl);
      if (r.ok) { status = "CONNECTED"; accountName = r.data.name ?? r.data.username ?? accountName; }
      else { status = r.code === 190 ? "EXPIRED" : "ERROR"; lastError = r.detail; }
    }
  } else {
    status = "PENDING";
    lastError = "لا يوجد فحص اتصال مطبّق لهذه المنصة في هذا الإصدار؛ تبقى «بانتظار التحقق».";
  }
  await prisma.$transaction(async (tx) => {
    await tx.mktConnection.upsert({ where: { platform }, create: { platform, status, lastError, lastCheckedAt: new Date() }, update: { status, lastError, accountName, lastCheckedAt: new Date() } });
    await audit(tx, actor ? userActor(actor) : { kind: "SYSTEM" }, "connection.checked", "MktConnection", platform, { after: { status, lastError } });
  }, TX_OPTS);
  return { platform, status, lastError, accountName };
}

/** The decrypted token and config of a CONNECTED platform, for the workers only. */
export async function liveConnection(platform: string) {
  const row = await prisma.mktConnection.findUnique({ where: { platform } });
  if (!row || row.status !== "CONNECTED" || !row.tokenCiphertext) return null;
  if (row.tokenExpiresAt && row.tokenExpiresAt < new Date()) return null;
  return { token: decryptToken(row.tokenCiphertext), config: row.config as Record<string, string> };
}

// ── Signed, short-lived public media URLs (what Meta fetches when it publishes an image) ──────

function mediaKey(env: Record<string, string | undefined> = process.env): string | null {
  const k = env.MARKETING_TOKEN_KEY?.trim();
  return k ? createHmac("sha256", k).update("marketing:media:v1").digest("hex") : null;
}

export function publicBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const u = env.APP_PUBLIC_URL?.trim() || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  return u && /^https:\/\//.test(u) ? u.replace(/\/$/, "") : null;
}

export function signMedia(versionId: string, ttlSeconds = 3600, now = Date.now()): string | null {
  const key = mediaKey();
  const base = publicBaseUrl();
  if (!key || !base) return null;
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = createHmac("sha256", key).update(`${versionId}.${exp}`).digest("hex");
  return `${base}/api/marketing/media/${encodeURIComponent(versionId)}?exp=${exp}&sig=${sig}`;
}

export function verifyMediaSignature(versionId: string, exp: string | null, sig: string | null, now = Date.now()): boolean {
  const key = mediaKey();
  if (!key || !exp || !sig || !/^\d+$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Number(exp) * 1000 < now || Number(exp) * 1000 > now + 2 * 3600_000) return false;
  const want = Buffer.from(createHmac("sha256", key).update(`${versionId}.${exp}`).digest("hex"));
  return timingSafeEqual(want, Buffer.from(sig));
}
