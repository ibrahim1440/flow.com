import "server-only";
import { verifyHmacSha256 } from "./crypto";
import { karzounConfig, karzounParams, type KarzounConfig } from "../karzoun-rules";

export { karzounConfig, karzounOptOut, karzounParams } from "../karzoun-rules";

/**
 * Karzoun Chat (karzoun.chat) — a Meta Business Partner / WhatsApp Solution Partner that sends
 * through the official Cloud API. The company already runs its WhatsApp on it, so marketing and
 * customer-lifecycle messages can go out from the same number and inbox instead of a second
 * WhatsApp account.
 *
 * Source: the vendor's own documentation, github.com/KarzounApps/docs (public-api.graphql,
 * developers/getting-started/authentication.mdx, developers/guides/webhooks.mdx), read on
 * 2026-10-24 at commit 7e2451d. Nothing below goes beyond what those pages state:
 *   • GraphQL at https://<subdomain>.api.karzoun.chat/graphql, `Authorization: Bearer kz_live_…`
 *     (a WORKSPACE API key: it outlives the person who created it; give it only the scopes used).
 *   • whatsappSendTemplateMessage(integrationId, recipient, templateName, language, params) →
 *     [{ _id, mid, conversationId, status: "sent" | "failed", errorMsg }].
 *   • whatsappGetTemplates(integrationId, page, perPage, status) → { data: [{ name, language,
 *     status, category, components, parameter_format }], pagination }.
 *   • Outbound webhooks signed `X-Karzoun-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`,
 *     envelope { id, version: "1", event: "<type>.<action>", data, metadata }; `id` is stable
 *     across retries (the idempotency key).
 *
 * Not available from Karzoun's API today: per-message delivery / read statuses by webhook. A
 * message sent through Karzoun therefore stays SENT here, and the delivered / read rates of those
 * messages read «غير متاح» — never a guessed number.
 *
 * `params` is keyed by the template's placeholder: "1", "2" … for Meta's positional templates (the
 * format this module writes), or the variable name for a NAMED template. The first message in TEST
 * mode (to MARKETING_WA_TEST_PHONE) is the check that the keys match what Karzoun expects.
 */

type GqlResult<T> = { ok: true; data: T } | { ok: false; detail: string; transient: boolean; definite: boolean };

async function gql<T>(cfg: KarzounConfig, query: string, variables: Record<string, unknown>, fetchImpl: typeof fetch): Promise<GqlResult<T>> {
  try {
    const res = await fetchImpl(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null;
    if (!res.ok || !json || json.errors?.length || json.data == null) {
      const msg = json?.errors?.[0]?.message?.slice(0, 300) ?? `HTTP ${res.status}`;
      return { ok: false, detail: `كرزون: ${msg}`, transient: res.status === 429 || res.status >= 500, definite: true };
    }
    return { ok: true, data: json.data };
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, detail: timeout ? "كرزون لم يرد في الوقت المحدد." : "تعذر الوصول إلى كرزون.", transient: true, definite: false };
  }
}

const SEND = `mutation Send($integrationId: String!, $recipient: String, $templateName: String, $language: String, $params: JSON, $statusOnCreate: String) {
  whatsappSendTemplateMessage(integrationId: $integrationId, recipient: $recipient, templateName: $templateName, language: $language, params: $params, statusOnCreate: $statusOnCreate) { _id mid conversationId status errorMsg }
}`;

export async function karzounSendTemplate(
  args: { to: string; template: string; language: string; body: string; bodyParams: string[] },
  fetchImpl: typeof fetch = fetch, env = process.env,
): Promise<{ ok: true; providerId: string } | { ok: false; detail: string; transient: boolean; definite: boolean }> {
  const cfg = karzounConfig(env);
  if (!cfg.ok) return { ok: false, detail: cfg.reasonAr, transient: false, definite: true };
  type Row = { _id?: string; mid?: string | null; status?: string; errorMsg?: string | null };
  const r = await gql<{ whatsappSendTemplateMessage: Row[] | Row | null }>(cfg.config, SEND, {
    integrationId: cfg.config.integrationId,
    recipient: `+${args.to.replace(/^\+/, "")}`,
    templateName: args.template,
    language: args.language,
    params: karzounParams(args.body, args.bodyParams),
    // A marketing send must not open a task in the team's inbox; Karzoun's documented value.
    statusOnCreate: "marketing",
  }, fetchImpl);
  if (!r.ok) return r;
  const raw = r.data.whatsappSendTemplateMessage;
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row) return { ok: false, detail: "كرزون لم يُرجع نتيجة للإرسال.", transient: false, definite: false };
  if (row.status === "failed") return { ok: false, detail: `كرزون: ${(row.errorMsg ?? "فشل الإرسال").slice(0, 300)}`, transient: false, definite: true };
  const id = row.mid || row._id;
  if (!id) return { ok: false, detail: "كرزون لم يُرجع معرّف الرسالة.", transient: false, definite: false };
  return { ok: true, providerId: `kz:${id}` };
}

export type KarzounTemplate = { name: string; language: string; status: string; category: string; components?: { type: string; text?: string }[]; parameter_format?: string | null };

const TEMPLATES = `query T($integrationId: String!, $page: Int, $perPage: Int) {
  whatsappGetTemplates(integrationId: $integrationId, page: $page, perPage: $perPage) { data { name language status category components parameter_format } pagination { totalCount } }
}`;

export async function karzounFetchTemplates(fetchImpl: typeof fetch = fetch, env = process.env): Promise<{ ok: true; templates: KarzounTemplate[] } | { ok: false; detail: string }> {
  const cfg = karzounConfig(env);
  if (!cfg.ok) return { ok: false, detail: cfg.reasonAr };
  const out: KarzounTemplate[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await gql<{ whatsappGetTemplates: { data: KarzounTemplate[] | null; pagination?: { totalCount?: number } } | null }>(cfg.config, TEMPLATES, { integrationId: cfg.config.integrationId, page, perPage: 100 }, fetchImpl);
    if (!r.ok) return { ok: false, detail: r.detail };
    const data = r.data.whatsappGetTemplates?.data ?? [];
    out.push(...data.map((t) => ({ ...t, components: Array.isArray(t.components) ? t.components : [] })));
    const total = r.data.whatsappGetTemplates?.pagination?.totalCount ?? out.length;
    if (data.length < 100 || out.length >= total) break;
  }
  return { ok: true, templates: out };
}

/**
 * `X-Karzoun-Signature-256: sha256=<hex>` over the RAW body. During Karzoun's 24-hour rotation grace it signs with
 * the NEW secret in the main header and with the OLD one in `-Previous`. Checking both headers against the one
 * secret this server holds covers both sides of the switch: before KARZOUN_WEBHOOK_SECRET is updated it still holds
 * the old secret (matches `-Previous`); after, the new one (matches the main header). No second secret is kept.
 */
export function verifyKarzounSignature(raw: string, header: string | null, previous: string | null, env = process.env): boolean {
  const secret = env.KARZOUN_WEBHOOK_SECRET?.trim();
  if (!secret || secret.length < 16) return false;
  return verifyHmacSha256(raw, secret, header, "hex") || (!!previous && verifyHmacSha256(raw, secret, previous, "hex"));
}
