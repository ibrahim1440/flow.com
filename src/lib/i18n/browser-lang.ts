// Guest links open in the guest's browser language (owner language decision 2, 26 Oct 2026): Arabic
// when the browser's preferred language is Arabic (its tag starts with «ar»), otherwise English. The
// server reads the `Accept-Language` request header (first paint already right); a browser that sent
// none is asked on the client (`navigator.languages`). The page's own toggle still switches.
//
// Pure: the guest layouts (server), the guest pages (client) and tests/ui/unit/i18n-decisions.test.ts.
import type { Lang } from "./translations";

const fromTag = (tag: string): Lang => (/^ar(?:-|_|$)/i.test(tag.trim()) ? "ar" : "en");

/**
 * The language of an `Accept-Language` header: its most preferred entry (highest q, first among
 * equals; `*` and q=0 ignored). null when the header is absent or names no language.
 */
export function langFromAcceptLanguage(header: string | null | undefined): Lang | null {
  if (!header) return null;
  let best: { tag: string; q: number; i: number } | null = null;
  header.split(",").forEach((part, i) => {
    const [rawTag, ...params] = part.trim().split(";");
    const tag = rawTag.trim();
    if (!tag || tag === "*" || !/^[A-Za-z]{1,8}([-_][A-Za-z0-9]{1,8})*$/.test(tag)) return;
    const qp = params.map((p) => p.trim()).find((p) => /^q=/i.test(p));
    const q = qp ? Number(qp.slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0) return;
    if (!best || q > best.q) best = { tag, q, i };
  });
  return best ? fromTag((best as { tag: string }).tag) : null;
}

/** The browser's own list (`navigator.languages`, else `navigator.language`). null when empty. */
export function langFromNavigator(languages: readonly string[] | null | undefined, language?: string | null): Lang | null {
  const first = (languages ?? []).find((l) => typeof l === "string" && l.trim()) ?? language ?? null;
  return first ? fromTag(first) : null;
}
