// UTM links: one spelling for the whole system, so an order's utm_campaign resolves to exactly one
// campaign. Pure. Written in-house on purpose (docs/marketing/OSS-VETTING.md: no maintained,
// permissively licensed library worth a dependency for this).

export type Utm = { source: string; medium: string; campaign: string; content?: string | null; term?: string | null };

/** Lowercase ASCII slug: what utm_campaign values look like (and what the DB CHECK accepts). */
export function utmSlug(input: string): string {
  return input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function isValidUtmCampaign(v: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,79}$/.test(v);
}

/** A campaign name in Arabic has no ASCII letters; fall back to a dated code. */
export function suggestUtmCampaign(name: string, date = new Date()): string {
  const slug = utmSlug(name);
  const stamp = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return slug.length >= 3 ? `${slug}-${stamp}`.slice(0, 80) : `cmp-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The medium per channel, fixed so reports group cleanly. */
export const UTM_MEDIUM: Record<string, string> = {
  organic: "social", paid: "paid_social", search: "cpc", whatsapp: "whatsapp", email: "email", referral: "referral",
};

/** Adds the UTM parameters to a URL, replacing any that were there. Refuses non-http(s) URLs. */
export function buildUtmUrl(base: string, utm: Utm): { ok: true; url: string } | { ok: false; reasonAr: string } {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return { ok: false, reasonAr: "الرابط غير صالح." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reasonAr: "الرابط يجب أن يبدأ بـ https." };
  if (!isValidUtmCampaign(utm.campaign)) return { ok: false, reasonAr: "رمز الحملة (utm_campaign) غير صالح." };
  const set = (k: string, v: string | null | undefined) => (v ? u.searchParams.set(k, v) : u.searchParams.delete(k));
  set("utm_source", utmSlug(utm.source) || utm.source);
  set("utm_medium", utmSlug(utm.medium) || utm.medium);
  set("utm_campaign", utm.campaign);
  set("utm_content", utm.content ? utmSlug(utm.content) : null);
  set("utm_term", utm.term ? utmSlug(utm.term) : null);
  return { ok: true, url: u.toString() };
}

/** Reads UTM parameters from a landing URL (the store sends it with the order, when it does). */
export function parseUtm(url: string | null | undefined): Partial<Utm> {
  if (!url) return {};
  try {
    const p = new URL(url).searchParams;
    const g = (k: string) => p.get(k)?.trim().toLowerCase() || undefined;
    return { source: g("utm_source"), medium: g("utm_medium"), campaign: g("utm_campaign"), content: g("utm_content"), term: g("utm_term") };
  } catch {
    return {};
  }
}
