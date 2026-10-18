/**
 * Language and direction rules for printed labels (A-6).
 *
 *  • A shown field with no value prints «—».
 *  • Latin / numeric runs inside Arabic text (altitude, dimensions, «203 dpi», dates, scores,
 *    batch numbers) are isolated left-to-right — the renderer wraps them in <bdi dir="ltr">.
 *  • Dates are the calendar day in Asia/Riyadh, YYYY-MM-DD (B-7).
 */
import { fmtMm } from "./units";

export const MISSING = "—";
export type PrintLang = "AR" | "EN" | "BI";
export const PRINT_LANGS: PrintLang[] = ["AR", "EN", "BI"];

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LTR_CHARS = /[A-Za-z0-9]/;

export const hasArabic = (s: string) => ARABIC.test(s);

/** A trimmed value, or «—» when there is none. */
export function shown(v: string | null | undefined): string {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? MISSING : t;
}

/**
 * Whether a value must be LTR-isolated when it sits in right-to-left text: it has Latin letters or
 * digits and no Arabic letters («1,950–2,200 m», «2026-10-05», «RH-20261001-01», «86.25»).
 */
export function needsLtrIsolation(s: string): boolean {
  return s !== MISSING && LTR_CHARS.test(s) && !hasArabic(s);
}

/**
 * Splits Arabic text into runs; numbers and Latin runs are marked `ltr` so the label isolates each in
 * its own <bdi> (§5.1): «أكمل 2 من 3» → «أكمل », «2», « من », «3». A run starts and ends on a letter or
 * digit and may hold spaces and . , : / % × – - + ' inside («3/4», «1: Lemon», «Supplier sample X»).
 */
const LTR_RUN = /[A-Za-z0-9\u00C0-\u024F](?:[A-Za-z0-9\u00C0-\u024F.,:/%×–\-+' ]*[A-Za-z0-9\u00C0-\u024F%])?/g;
export function splitLtrRuns(text: string): { text: string; ltr: boolean }[] {
  const out: { text: string; ltr: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(LTR_RUN)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), ltr: false });
    out.push({ text: m[0], ltr: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), ltr: false });
  return out;
}

/** «203 dpi» — the number before the Latin unit, whatever the surrounding language. */
export const dpiText = (dpi: number) => `${dpi} dpi`;
/** «99.1 × 67.7 mm». */
export const dimText = (w: number, h: number) => `${fmtMm(w)} × ${fmtMm(h)} mm`;

/** YYYY-MM-DD of an instant, as the calendar day in the given zone (default Asia/Riyadh). */
export function isoDay(d: Date | string | null | undefined, timeZone = "Asia/Riyadh"): string | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A cupping score with two decimals («86.25»). */
export const scoreText = (v: number) => v.toFixed(2);

/** Text direction of a label language for the label's own root. */
export const langDir = (l: PrintLang): "rtl" | "ltr" => (l === "AR" ? "rtl" : "ltr");
