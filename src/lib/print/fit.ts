/**
 * Text fit for printed labels (A-4, B-6). A deterministic estimate, shared by the server (job
 * warnings) and the client (dialog warnings, the text actually printed); the preview additionally
 * measures the rendered DOM, so an estimate that is too optimistic is still caught there.
 *
 * Width model (IBM Plex Sans / Sans Arabic): average advance in em per character class, measured
 * conservatively (rounded up) so the estimate errs towards «does not fit».
 */
import { hasArabic } from "./bidi";
import { ptToMm } from "./units";

export const ELLIPSIS = "…";

const ADVANCE_EM = { latinUpper: 0.66, latinLower: 0.54, digit: 0.58, space: 0.27, arabic: 0.52, punct: 0.34, other: 0.6 };

function charEm(ch: string): number {
  if (/\s/.test(ch)) return ADVANCE_EM.space;
  if (/[A-Z]/.test(ch)) return ADVANCE_EM.latinUpper;
  if (/[a-z]/.test(ch)) return ADVANCE_EM.latinLower;
  if (/[0-9]/.test(ch)) return ADVANCE_EM.digit;
  if (hasArabic(ch)) {
    // Diacritics (harakat) take no advance.
    return /[ً-ٰٟ]/.test(ch) ? 0 : ADVANCE_EM.arabic;
  }
  if (/[.,;:'"()\-–—·،/]/.test(ch)) return ADVANCE_EM.punct;
  return ADVANCE_EM.other;
}

/** Estimated rendered width of `text` at `fontPt`, in millimetres. */
export function textWidthMm(text: string, fontPt: number, bold = false): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * ptToMm(fontPt) * (bold ? 1.05 : 1);
}

/** Greedy word wrap: the lines `text` breaks into in a box `widthMm` wide. */
export function wrapLines(text: string, widthMm: number, fontPt: number, bold = false): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textWidthMm(next, fontPt, bold) <= widthMm || !cur) {
      // A single word longer than the line still occupies (at least) one line.
      if (!cur && textWidthMm(w, fontPt, bold) > widthMm) {
        let piece = "";
        for (const ch of w) {
          if (textWidthMm(piece + ch, fontPt, bold) > widthMm && piece) { lines.push(piece); piece = ch; } else piece += ch;
        }
        cur = piece;
        continue;
      }
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export const estimateLines = (text: string, widthMm: number, fontPt: number, bold = false) =>
  text.trim() === "" ? 0 : wrapLines(text, widthMm, fontPt, bold).length;

/**
 * At most `maxLines` lines; when the text is longer it is cut at a word (or character) boundary
 * and ends in «…». The record itself is never changed (B-6) — this is the printed form only.
 */
export function truncateToLines(text: string, maxLines: number, widthMm: number, fontPt: number): { text: string; truncated: boolean; lines: number } {
  const lines = wrapLines(text, widthMm, fontPt);
  if (lines.length <= maxLines) return { text: text.trim(), truncated: false, lines: lines.length };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  // Make room for the ellipsis on the last kept line.
  while (last.length > 0 && textWidthMm(`${last}${ELLIPSIS}`, fontPt) > widthMm) {
    const cut = last.lastIndexOf(" ");
    last = cut > 0 ? last.slice(0, cut) : last.slice(0, -1);
  }
  kept[maxLines - 1] = `${last.replace(/[\s,،;·]+$/, "")}${ELLIPSIS}`;
  return { text: kept.join(" "), truncated: true, lines: maxLines };
}

/** Whether `text` fits in `maxLines` lines. */
export const fitsLines = (text: string, maxLines: number, widthMm: number, fontPt: number) =>
  estimateLines(text, widthMm, fontPt) <= maxLines;
