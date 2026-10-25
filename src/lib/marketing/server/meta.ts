import "server-only";

/**
 * Meta Graph API (official REST) — the only Facebook / Instagram calls this application makes.
 * Called with fetch, no SDK: the official Node SDK trails the API version and the archived
 * WhatsApp SDK is abandoned (docs/marketing/OSS-VETTING.md). The version is pinned by
 * META_GRAPH_VERSION (default below) so an upgrade is a configuration change.
 *
 * Tokens are passed in by the caller (decrypted from MktConnection) and never logged; error
 * text is Meta's own message, truncated, with any access_token stripped.
 */

export const DEFAULT_GRAPH_VERSION = "v26.0";
const TIMEOUT = 20_000;

export function graphBase(env: Record<string, string | undefined> = process.env): string {
  const v = env.META_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
  if (!/^v\d{1,3}\.\d$/.test(v)) throw new Error("META_GRAPH_VERSION must look like v26.0");
  return `https://graph.facebook.com/${v}`;
}

export type GraphResult<T> =
  | { ok: true; data: T }
  /** `definite`: Meta answered and refused — safe to retry or fix. Otherwise the outcome is unknown. */
  | { ok: false; status: number | null; detail: string; definite: boolean; transient: boolean; code?: number };

const scrub = (s: string) => s.replace(/access_token=[^&\s"]+/g, "access_token=***").slice(0, 400);

export async function graph<T>(method: "GET" | "POST", path: string, token: string, params: Record<string, string | undefined> = {}, fetchImpl: typeof fetch = fetch): Promise<GraphResult<T>> {
  const url = new URL(`${graphBase()}${path}`);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) (method === "GET" ? url.searchParams : body).set(k, v);
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: method === "POST" ? body : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const json = (await res.json().catch(() => null)) as { error?: { message?: string; code?: number; is_transient?: boolean } } | null;
    if (!res.ok || json?.error) {
      const e = json?.error;
      return { ok: false, status: res.status, detail: scrub(e?.message ?? `Graph API HTTP ${res.status}`), definite: true, transient: !!e?.is_transient || res.status === 429 || res.status >= 500, code: e?.code };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    // A POST that timed out may have been applied by Meta: unknown outcome, never auto-retried.
    return { ok: false, status: null, detail: timeout ? "Meta did not answer in time." : "Meta could not be reached.", definite: method === "GET", transient: true };
  }
}

export type PublishInput = {
  platform: "FACEBOOK" | "INSTAGRAM";
  token: string;
  /** FACEBOOK: page id. INSTAGRAM: the IG professional account id. */
  targetId: string;
  caption: string;
  link: string | null;
  /** A public, short-lived HTTPS URL of the image Meta will fetch (signed media route). */
  imageUrl: string | null;
  /** INSTAGRAM: a container already created by an earlier attempt (resume, never re-create). */
  containerId?: string | null;
};

export type PublishOutcome =
  | { kind: "PUBLISHED"; externalId: string; url: string | null }
  | { kind: "CONTAINER"; containerId: string }
  | { kind: "FAILED"; detail: string; retry: boolean; unknownOutcome: boolean };

export async function publishToMeta(input: PublishInput, fetchImpl: typeof fetch = fetch): Promise<PublishOutcome> {
  const fail = (r: Extract<GraphResult<unknown>, { ok: false }>): PublishOutcome => ({ kind: "FAILED", detail: r.detail, retry: r.definite && r.transient, unknownOutcome: !r.definite });
  if (input.platform === "FACEBOOK") {
    const r = input.imageUrl
      ? await graph<{ id: string; post_id?: string }>("POST", `/${encodeURIComponent(input.targetId)}/photos`, input.token, { url: input.imageUrl, caption: input.caption }, fetchImpl)
      : await graph<{ id: string }>("POST", `/${encodeURIComponent(input.targetId)}/feed`, input.token, { message: input.caption, link: input.link ?? undefined }, fetchImpl);
    if (!r.ok) return fail(r);
    const id = (r.data as { post_id?: string; id: string }).post_id ?? r.data.id;
    const p = await graph<{ permalink_url?: string }>("GET", `/${encodeURIComponent(id)}`, input.token, { fields: "permalink_url" }, fetchImpl);
    return { kind: "PUBLISHED", externalId: id, url: p.ok ? p.data.permalink_url ?? null : null };
  }
  // Instagram: create a container (once), then publish it.
  let containerId = input.containerId ?? null;
  if (!containerId) {
    if (!input.imageUrl) return { kind: "FAILED", detail: "Instagram requires an image in this build.", retry: false, unknownOutcome: false };
    const c = await graph<{ id: string }>("POST", `/${encodeURIComponent(input.targetId)}/media`, input.token, { image_url: input.imageUrl, caption: input.caption }, fetchImpl);
    if (!c.ok) return fail(c);
    containerId = c.data.id;
    return { kind: "CONTAINER", containerId };
  }
  const pub = await graph<{ id: string }>("POST", `/${encodeURIComponent(input.targetId)}/media_publish`, input.token, { creation_id: containerId }, fetchImpl);
  if (!pub.ok) return fail(pub);
  const p = await graph<{ permalink?: string }>("GET", `/${encodeURIComponent(pub.data.id)}`, input.token, { fields: "permalink" }, fetchImpl);
  return { kind: "PUBLISHED", externalId: pub.data.id, url: p.ok ? p.data.permalink ?? null : null };
}

/** Connection check: who the token belongs to and when it expires (debug_token needs the app token). */
export async function checkMetaToken(token: string, targetId: string, fetchImpl: typeof fetch = fetch) {
  return graph<{ id: string; name?: string; username?: string }>("GET", `/${encodeURIComponent(targetId)}`, token, { fields: "id,name,username" }, fetchImpl);
}
