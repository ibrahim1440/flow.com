import "server-only";
import { graphBase } from "./meta";
import { verifyHmacSha256 } from "./crypto";
import { karzounConfig, karzounFetchTemplates, karzounSendTemplate } from "./karzoun";

/**
 * WhatsApp Business Cloud API (Meta, official) — for MARKETING and customer-lifecycle messages.
 *
 * Deliberately separate from src/lib/whatsapp/evolution.ts. That client drives an Evolution API
 * server, which links a phone through WhatsApp Web (an unofficial client); it stays as it is for
 * the internal staff notifications it already sends. Marketing to customers goes through the
 * official Cloud API only: approved templates, opt-in, per-message billing, delivery statuses by
 * webhook (docs/marketing/OSS-VETTING.md §Evolution).
 *
 * Three keys before a customer receives anything:
 *   1. WHATSAPP_CLOUD_TOKEN + WHATSAPP_CLOUD_PHONE_NUMBER_ID configured (else: not configured);
 *   2. MARKETING_WA_LIVE_ENABLED=true on the server (else every message goes to
 *      MARKETING_WA_TEST_PHONE when set, or is recorded as not sent);
 *   3. the marketing kill switch off, consent and caps satisfied (journeys / messaging rules).
 *
 * Two official routes to the same Cloud API, one chosen per server (`waProvider`):
 *   • KARZOUN — the company's WhatsApp Solution Partner (server/karzoun.ts); the default once
 *     KARZOUN_API_KEY is set, so customers hear from the number and inbox they already know.
 *   • CLOUD — Meta's Cloud API directly (WHATSAPP_CLOUD_*), for a number not managed in Karzoun.
 * MARKETING_WA_PROVIDER=karzoun|cloud overrides the choice. Never both: one number, one sender.
 */

export type WaProvider = "KARZOUN" | "CLOUD";

export function waProvider(env: Record<string, string | undefined> = process.env): WaProvider {
  const forced = env.MARKETING_WA_PROVIDER?.trim().toLowerCase();
  if (forced === "karzoun") return "KARZOUN";
  if (forced === "cloud") return "CLOUD";
  return env.KARZOUN_API_KEY?.trim() ? "KARZOUN" : "CLOUD";
}

function providerReady(env: Record<string, string | undefined>): { ok: true } | { ok: false; reasonAr: string } {
  const forced = !!env.MARKETING_WA_PROVIDER?.trim();
  const r = waProvider(env) === "KARZOUN" ? karzounConfig(env) : cloudConfig(env);
  if (r.ok) return { ok: true };
  // Nothing chosen and nothing set: name both official routes rather than only the fallback.
  if (!forced && !env.WHATSAPP_CLOUD_TOKEN?.trim()) return { ok: false, reasonAr: "لم يُضبط مزوّد واتساب: كرزون (KARZOUN_API_URL, KARZOUN_API_KEY, KARZOUN_WA_INTEGRATION_ID) أو Cloud API المباشر (WHATSAPP_CLOUD_*)." };
  return { ok: false, reasonAr: r.reasonAr };
}

export type CloudConfig = { token: string; phoneNumberId: string; wabaId: string | null; appSecret: string | null; verifyToken: string | null };

/** The English of the WhatsApp provider readiness reasons above (the integrations screen in English). */
const READY_EN: Record<string, string> = {
  "لم يُضبط مزوّد واتساب: كرزون (KARZOUN_API_URL, KARZOUN_API_KEY, KARZOUN_WA_INTEGRATION_ID) أو Cloud API المباشر (WHATSAPP_CLOUD_*).": "No WhatsApp provider is configured: Karzoun (KARZOUN_API_URL, KARZOUN_API_KEY, KARZOUN_WA_INTEGRATION_ID) or the direct Cloud API (WHATSAPP_CLOUD_*).",
  "واتساب Cloud API غير مضبوط (WHATSAPP_CLOUD_TOKEN, WHATSAPP_CLOUD_PHONE_NUMBER_ID).": "The WhatsApp Cloud API is not configured (WHATSAPP_CLOUD_TOKEN, WHATSAPP_CLOUD_PHONE_NUMBER_ID).",
  "WHATSAPP_CLOUD_PHONE_NUMBER_ID غير صالح.": "WHATSAPP_CLOUD_PHONE_NUMBER_ID is not valid.",
  "الإرسال الفعلي غير مفعّل على الخادم (MARKETING_WA_LIVE_ENABLED) ولا يوجد رقم اختبار.": "Live sending is not switched on on the server (MARKETING_WA_LIVE_ENABLED) and there is no test number.",
  "كرزون غير مضبوط (KARZOUN_API_URL, KARZOUN_API_KEY, KARZOUN_WA_INTEGRATION_ID).": "Karzoun is not configured (KARZOUN_API_URL, KARZOUN_API_KEY, KARZOUN_WA_INTEGRATION_ID).",
  "KARZOUN_API_URL ليس رابطاً صالحاً.": "KARZOUN_API_URL is not a valid URL.",
  "KARZOUN_API_URL يجب أن يكون https://<المساحة>.api.karzoun.chat/graphql.": "KARZOUN_API_URL must be https://<workspace>.api.karzoun.chat/graphql.",
  "KARZOUN_API_KEY غير صالح (يبدأ بـ kz_live_ أو kz_test_).": "KARZOUN_API_KEY is not valid (it starts with kz_live_ or kz_test_).",
  "KARZOUN_WA_INTEGRATION_ID غير صالح.": "KARZOUN_WA_INTEGRATION_ID is not valid.",
};
/** A readiness reason in English (the Arabic itself when it is not one of the known reasons). */
export function readinessEn(ar: string): string {
  return READY_EN[ar] ?? ar;
}

export function cloudConfig(env: Record<string, string | undefined> = process.env): { ok: true; config: CloudConfig } | { ok: false; reasonAr: string } {
  const token = env.WHATSAPP_CLOUD_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_CLOUD_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) return { ok: false, reasonAr: "واتساب Cloud API غير مضبوط (WHATSAPP_CLOUD_TOKEN, WHATSAPP_CLOUD_PHONE_NUMBER_ID)." };
  if (!/^\d{5,25}$/.test(phoneNumberId)) return { ok: false, reasonAr: "WHATSAPP_CLOUD_PHONE_NUMBER_ID غير صالح." };
  return { ok: true, config: { token, phoneNumberId, wabaId: env.WHATSAPP_CLOUD_WABA_ID?.trim() || null, appSecret: env.WHATSAPP_CLOUD_APP_SECRET?.trim() || null, verifyToken: env.WHATSAPP_CLOUD_VERIFY_TOKEN?.trim() || null } };
}

export type SendMode = { mode: "LIVE" } | { mode: "TEST"; phone: string } | { mode: "OFF"; reasonAr: string };

export function sendMode(env: Record<string, string | undefined> = process.env): SendMode {
  const cfg = providerReady(env);
  if (!cfg.ok) return { mode: "OFF", reasonAr: cfg.reasonAr };
  if (env.MARKETING_WA_LIVE_ENABLED === "true") return { mode: "LIVE" };
  const test = env.MARKETING_WA_TEST_PHONE?.replace(/\D/g, "");
  if (test && /^[1-9]\d{7,14}$/.test(test)) return { mode: "TEST", phone: test };
  return { mode: "OFF", reasonAr: "الإرسال الفعلي غير مفعّل على الخادم (MARKETING_WA_LIVE_ENABLED) ولا يوجد رقم اختبار." };
}

export type SendResult = { ok: true; providerId: string } | { ok: false; detail: string; transient: boolean; definite: boolean };

/** A template message through the server's provider. `bodyParams` fill {{1}}, {{2}} … in order. */
export async function sendTemplate(args: { to: string; template: string; language: string; body: string; bodyParams: string[] }, fetchImpl: typeof fetch = fetch, env = process.env): Promise<SendResult> {
  if (waProvider(env) === "KARZOUN") return karzounSendTemplate(args, fetchImpl, env);
  const cfg = cloudConfig(env);
  if (!cfg.ok) return { ok: false, detail: cfg.reasonAr, transient: false, definite: true };
  const body = {
    messaging_product: "whatsapp",
    to: args.to,
    type: "template",
    template: {
      name: args.template,
      language: { code: args.language },
      ...(args.bodyParams.length ? { components: [{ type: "body", parameters: args.bodyParams.map((text) => ({ type: "text", text })) }] } : {}),
    },
  };
  try {
    const res = await fetchImpl(`${graphBase(env)}/${cfg.config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as { messages?: { id: string }[]; error?: { message?: string; code?: number } } | null;
    if (res.ok && json?.messages?.[0]?.id) return { ok: true, providerId: json.messages[0].id };
    const msg = json?.error?.message?.slice(0, 300) ?? `HTTP ${res.status}`;
    return { ok: false, detail: msg, transient: res.status === 429 || res.status >= 500, definite: true };
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, detail: timeout ? "WhatsApp did not answer in time." : "WhatsApp could not be reached.", transient: true, definite: false };
  }
}

export type MetaTemplate = { name: string; language: string; status: string; category: string; components?: { type: string; text?: string }[] };

export async function fetchTemplates(fetchImpl: typeof fetch = fetch, env = process.env): Promise<{ ok: true; templates: MetaTemplate[] } | { ok: false; detail: string }> {
  if (waProvider(env) === "KARZOUN") return karzounFetchTemplates(fetchImpl, env);
  const cfg = cloudConfig(env);
  if (!cfg.ok) return { ok: false, detail: cfg.reasonAr };
  if (!cfg.config.wabaId) return { ok: false, detail: "WHATSAPP_CLOUD_WABA_ID غير مضبوط." };
  const out: MetaTemplate[] = [];
  let next: string | null = `${graphBase(env)}/${cfg.config.wabaId}/message_templates?fields=name,language,status,category,components&limit=100`;
  for (let page = 0; next && page < 10; page++) {
    const res: Response = await fetchImpl(next, { headers: { Authorization: `Bearer ${cfg.config.token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => null)) as { data?: MetaTemplate[]; paging?: { next?: string }; error?: { message?: string } } | null;
    if (!res.ok || !json?.data) return { ok: false, detail: json?.error?.message?.slice(0, 300) ?? `HTTP ${res.status}` };
    out.push(...json.data);
    next = json.paging?.next ?? null;
  }
  return { ok: true, templates: out };
}

/** X-Hub-Signature-256 over the RAW body with the app secret (never re-serialised JSON). */
export function verifyCloudSignature(raw: string, header: string | null, env = process.env): boolean {
  const cfg = cloudConfig(env);
  return cfg.ok && !!cfg.config.appSecret && verifyHmacSha256(raw, cfg.config.appSecret, header, "hex");
}

export { parseWebhook, isOptOutText, type StatusEvent, type InboundText } from "../wa-webhook";
