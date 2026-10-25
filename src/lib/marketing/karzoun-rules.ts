// Karzoun (WhatsApp Solution Partner) — configuration, template parameters and the opt-out read of
// its webhook. Pure; the network client is server/karzoun.ts (sources and limits documented there).

export type KarzounConfig = { url: string; apiKey: string; integrationId: string; webhookSecret: string | null };

export function karzounConfig(env: Record<string, string | undefined> = process.env): { ok: true; config: KarzounConfig } | { ok: false; reasonAr: string } {
  const url = env.KARZOUN_API_URL?.trim();
  const apiKey = env.KARZOUN_API_KEY?.trim();
  const integrationId = env.KARZOUN_WA_INTEGRATION_ID?.trim();
  if (!url || !apiKey || !integrationId) return { ok: false, reasonAr: "كرزون غير مضبوط (KARZOUN_API_URL, KARZOUN_API_KEY, KARZOUN_WA_INTEGRATION_ID)." };
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reasonAr: "KARZOUN_API_URL ليس رابطاً صالحاً." }; }
  // Only the vendor's own API host, over HTTPS: the key is never sent anywhere else.
  if (u.protocol !== "https:" || !/^[a-z0-9-]+\.api\.karzoun\.chat$/i.test(u.hostname) || u.pathname.replace(/\/+$/, "") !== "/graphql") {
    return { ok: false, reasonAr: "KARZOUN_API_URL يجب أن يكون https://<المساحة>.api.karzoun.chat/graphql." };
  }
  if (!/^kz_(live|test)_[A-Za-z0-9_-]{8,}$/.test(apiKey)) return { ok: false, reasonAr: "KARZOUN_API_KEY غير صالح (يبدأ بـ kz_live_ أو kz_test_)." };
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(integrationId)) return { ok: false, reasonAr: "KARZOUN_WA_INTEGRATION_ID غير صالح." };
  return { ok: true, config: { url: u.toString(), apiKey, integrationId, webhookSecret: env.KARZOUN_WEBHOOK_SECRET?.trim() || null } };
}

/** Placeholder keys → values. Positional bodies ({{1}}) are keyed "1", "2" …; named ones by name. */
export function karzounParams(body: string, values: string[]): Record<string, string> {
  const keys = [...new Set([...body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
  const positional = keys.every((k) => /^\d+$/.test(k));
  const ordered = positional ? keys.sort((a, b) => Number(a) - Number(b)) : keys;
  return Object.fromEntries(ordered.map((k, i) => [k, values[positional ? Number(k) - 1 : i] ?? ""]));
}

/**
 * What a Karzoun delivery means for consent. Only an OPT-OUT is taken from Karzoun: a customer who
 * unsubscribed there is unsubscribed here. An opt-in is never inferred from it — consent needs its
 * own source and evidence (PDPL), recorded in «الواتساب والعملاء › الموافقات».
 */
export function karzounOptOut(envelope: unknown): { phones: string[]; eventId: string | null; event: string | null } {
  const e = envelope as { id?: unknown; event?: unknown; data?: Record<string, unknown> } | null;
  const eventId = typeof e?.id === "string" ? e.id : null;
  const event = typeof e?.event === "string" ? e.event : null;
  if (!e || !event || !["core:customer.update", "core:customer.create"].includes(event) || !e.data) return { phones: [], eventId, event };
  const sub = e.data.isSubscribed;
  const out = sub === false || (typeof sub === "string" && /^(no|false|unsubscribed)$/i.test(sub.trim()));
  if (!out) return { phones: [], eventId, event };
  const phones = [e.data.primaryPhone, ...(Array.isArray(e.data.phones) ? e.data.phones : [])].filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return { phones: [...new Set(phones)], eventId, event };
}
