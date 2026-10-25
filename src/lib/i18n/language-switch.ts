// Quick language switch (owner, 25 Oct 2026): «تغيير اللغة صعب ويأخذ وقتًا». One tap in the
// header changes the language in place — no profile visit, no Save, no sign-out.
//
// Where the language lives:
//   · signed in   — Employee.preferredLanguage (the profile), carried by the session token's
//                   `preferredLanguage` claim; the root layout sets <html lang/dir> from it.
//                   The switch saves through the SAME endpoint as the profile form
//                   (PATCH /api/profile), which re-signs the current session's token.
//   · signed out  — the `hq_lang` cookie (a display preference, never a credential). The sign-in
//                   screen writes it; every session cookie the server writes refreshes it to the
//                   account's saved language, so the sign-in screen after a sign-out speaks the
//                   language the person last used. After sign-in the account's saved language wins.
//
// Pure helpers only (no React): shared by the ERP shell, the sign-in screen and the station bar.
import type { Lang } from "./translations";

/** The pre-sign-in language cookie. Not httpOnly: the sign-in screen sets it without a request. */
export const LANG_COOKIE = "hq_lang";
/** One year: it is a display preference, not a session. */
export const LANG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function asLang(v: unknown): Lang | null {
  return v === "ar" || v === "en" ? v : null;
}

export function otherLang(l: Lang): Lang {
  return l === "ar" ? "en" : "ar";
}

export function dirOf(l: Lang): "rtl" | "ltr" {
  return l === "ar" ? "rtl" : "ltr";
}

/**
 * The switch's own label: the language it switches TO, written in that language (the pattern
 * of bilingual Gulf apps — «EN» while in Arabic, «عربي» while in English).
 */
export function toggleLabel(current: Lang): { text: string; lang: Lang; name: string } {
  return current === "ar"
    ? { text: "EN", lang: "en", name: "English" }
    : { text: "ع", lang: "ar", name: "العربية" };
}

/** The accessible name, in the CURRENT language (what a screen reader user is listening to). */
export function toggleAriaLabel(current: Lang): string {
  return current === "ar" ? "تغيير اللغة إلى الإنجليزية (English)" : "Switch language to Arabic (العربية)";
}

/** Browser only: flips <html lang/dir> at once, before the server answers. */
export function applyDocumentLang(l: Lang): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.lang = l;
  el.dir = dirOf(l);
}

/** Browser only: remembers the language for the sign-in screen. */
export function writeLangCookie(l: Lang): void {
  if (typeof document === "undefined") return;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LANG_COOKIE}=${l}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

/** Saves the signed-in person's language through the profile endpoint. true when saved. */
export async function persistLanguage(l: Lang, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl("/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preferredLanguage: l }) });
    if (!r.ok) return false;
    const j = (await r.json().catch(() => null)) as { preferredLanguage?: unknown } | null;
    return asLang(j?.preferredLanguage) === l;
  } catch {
    return false;
  }
}
