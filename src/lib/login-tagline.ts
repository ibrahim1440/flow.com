// The line under the brand on the sign-in screen (owner language decision 1, 26 Oct 2026): it follows
// the screen's language, and an administrator may replace it in each language from Settings ›
// Organisation. Stored on the SystemConfig singleton (migration 20261110090000_i18n_preferences):
// loginTaglineAr / loginTaglineEn, NULL = the built-in line below.
//
// Pure and client-safe: the sign-in layout (server) reads the row and resolves it here, the settings
// API validates with it, and tests/ui/unit/i18n-decisions.test.ts runs it under plain Node.

export const LOGIN_TAGLINE_MAX = 120;

/** The built-in line. The Arabic is the brand line the screen always carried. */
export const DEFAULT_LOGIN_TAGLINE = {
  ar: "كل عملية بوضوح. كل تفصيل بإتقان.",
  en: "Clarity in every process. Precision in every detail.",
} as const;

export type LoginTagline = {
  /** What an administrator stored, or null (the built-in line applies). */
  ar: string | null;
  en: string | null;
  /** The line in force, per language. */
  effective: { ar: string; en: string };
};

const clean = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t : null;
};

export function taglineFromRow(row: { loginTaglineAr?: string | null; loginTaglineEn?: string | null } | null | undefined): LoginTagline {
  const ar = clean(row?.loginTaglineAr);
  const en = clean(row?.loginTaglineEn);
  return { ar, en, effective: { ar: ar ?? DEFAULT_LOGIN_TAGLINE.ar, en: en ?? DEFAULT_LOGIN_TAGLINE.en } };
}

/**
 * The line as the screen draws it: one sentence per line («كل عملية بوضوح.» / «كل تفصيل بإتقان.»),
 * split after a full stop, question or exclamation mark that is followed by a space.
 */
export function taglineLines(text: string): string[] {
  return text.split(/(?<=[.!?؟。])\s+/).map((s) => s.trim()).filter(Boolean);
}

type Problem = { ok: false; field: "taglineAr" | "taglineEn"; error: string; errorAr: string };

/**
 * PUT /api/settings/login-tagline body → the columns to write. Partial: an absent key is unchanged;
 * "" or null clears it (the built-in line applies again). Whitespace runs collapse to one space.
 */
export function parseTaglinePatch(b: Record<string, unknown>): { ok: true; data: { loginTaglineAr?: string | null; loginTaglineEn?: string | null } } | Problem {
  const data: { loginTaglineAr?: string | null; loginTaglineEn?: string | null } = {};
  for (const [key, col, lang] of [["taglineAr", "loginTaglineAr", "ar"], ["taglineEn", "loginTaglineEn", "en"]] as const) {
    if (!(key in b)) continue;
    const v = b[key];
    if (v === null || v === "") { data[col] = null; continue; }
    if (typeof v !== "string") {
      return { ok: false, field: key, error: "The sign-in line must be text.", errorAr: "شعار صفحة الدخول يجب أن يكون نصًا." };
    }
    const t = clean(v);
    if (t === null) { data[col] = null; continue; }
    if ([...t].length > LOGIN_TAGLINE_MAX) {
      return lang === "ar"
        ? { ok: false, field: key, error: `The Arabic sign-in line must be ${LOGIN_TAGLINE_MAX} characters or fewer.`, errorAr: `النص العربي لشعار صفحة الدخول ${LOGIN_TAGLINE_MAX} حرفًا على الأكثر.` }
        : { ok: false, field: key, error: `The English sign-in line must be ${LOGIN_TAGLINE_MAX} characters or fewer.`, errorAr: `النص الإنجليزي لشعار صفحة الدخول ${LOGIN_TAGLINE_MAX} حرفًا على الأكثر.` };
    }
    if (/[<>]/.test(t) || /[\u0000-\u001f\u007f]/.test(t)) {
      return { ok: false, field: key, error: "The sign-in line cannot contain < > or control characters.", errorAr: "لا يقبل شعار صفحة الدخول الرمزين < > ولا رموز التحكم." };
    }
    data[col] = t;
  }
  return { ok: true, data };
}
