/**
 * The Arabic version of an API refusal (DEF-08/09, small-fixes batch).
 *
 * Most routes answer a refusal with one English `error`. The interface is Arabic first, so an
 * Arabic user read "Insufficient permissions" or "quantity must be a whole number" on an Arabic
 * screen. The English stays exactly as it is (tests, logs and English users read it); what is
 * added is the Arabic beside it:
 *
 *   - on the server, the shared refusal helpers (`forbidden`, `unauthorized`, `handleDomainError`,
 *     `handlePrismaError`) add `errorAr` to the body when the message is known here, and so does
 *     every inline refusal: the routes import `NextResponse` from src/lib/api-response.ts, which
 *     passes each error response through withArabicError (QA pass, 20 Oct);
 *   - in the browser, `localizeApiError` picks the text for the viewer's language: the body's own
 *     Arabic (`errorAr`, or an Arabic `error` from the HR-style routes) first, then this table.
 *
 * The table lives in api-errors-ar.ts. Every English refusal written in src/app/api and src/lib
 * (every route family; HR keeps its own Arabic-first map) has an entry — enforced by
 * tests/ops/unit/api-errors-ar.test.ts, which reads those sources.
 *
 * Pure: no server or browser import, so the server helpers and the client screens share it.
 */
import { API_ERRORS_AR, API_ERROR_TEMPLATES_AR } from "./api-errors-ar";

const PLACEHOLDER = /\$\{(?:[^{}]|\{[^{}]*\})*\}/g;
const ARABIC = /[؀-ۿ]/;

type Compiled = { re: RegExp; ar: string; prefix: boolean };
let compiled: Compiled[] | null = null;

function compile(): Compiled[] {
  if (compiled) return compiled;
  compiled = API_ERROR_TEMPLATES_AR.map(([en, ar]) => {
    const prefix = /\s$/.test(en);
    const pieces = en.split(PLACEHOLDER).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const body = pieces.join("([\\s\\S]+?)");
    return { re: new RegExp(`^${body}${prefix ? "([\\s\\S]*)" : ""}$`), ar, prefix };
  });
  return compiled;
}

/** True when the text already contains Arabic (an HR-style route returns Arabic as `error`). */
export function isArabicText(s: string): boolean {
  return ARABIC.test(s);
}

/** The Arabic for one English refusal, or undefined when it is not known. */
export function arabicForApiError(en: string | null | undefined, depth = 0): string | undefined {
  if (!en || depth > 3) return undefined;
  const exact = API_ERRORS_AR[en];
  if (exact) return exact;
  for (const c of compile()) {
    const m = c.re.exec(en);
    if (!m) continue;
    const groups = m.slice(1);
    // A value inside the message may itself be a known fragment ("must be a whole number…").
    const values = groups.map((g) => arabicForApiError(g, depth + 1) ?? g);
    let out = c.ar.replace(/\{(\d+)\}/g, (_, i: string) => values[Number(i)] ?? "");
    if (c.prefix) out += values[values.length - 1] ?? "";
    return out;
  }
  return undefined;
}

/** `body` with `errorAr` added when its English `error` is known and it has no Arabic yet. */
export function withArabicError<T extends Record<string, unknown>>(body: T): T & { errorAr?: string } {
  const error = body.error;
  if (typeof error !== "string" || "errorAr" in body || isArabicText(error)) return body;
  const ar = arabicForApiError(error);
  return ar ? { ...body, errorAr: ar } : body;
}

type ErrorBody = { error?: unknown; errorAr?: unknown; errorEn?: unknown } | null | undefined;

function docLang(): "ar" | "en" {
  return typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "ar";
}

/**
 * The refusal to show, in the viewer's language. Arabic: `errorAr`, else an Arabic `error`, else
 * this table, else the English. English: `errorEn`, else `error` when it is not Arabic. Returns
 * undefined when the body carries no message (the caller keeps its own fallback).
 */
export function localizeApiError(body: ErrorBody | unknown, lang: "ar" | "en" = docLang()): string | undefined {
  const b = (body ?? {}) as ErrorBody & object;
  const error = typeof b.error === "string" && b.error ? b.error : undefined;
  const errorAr = typeof b.errorAr === "string" && b.errorAr ? b.errorAr : undefined;
  const errorEn = typeof b.errorEn === "string" && b.errorEn ? b.errorEn : undefined;
  if (lang === "en") return errorEn ?? (error && !isArabicText(error) ? error : undefined) ?? error;
  if (errorAr) return errorAr;
  if (error && isArabicText(error)) return error;
  return arabicForApiError(error) ?? arabicForApiError(errorEn) ?? error ?? errorEn;
}
