/**
 * Print units. Millimetres are canonical everywhere in the print subsystem (A-3); everything else
 * (CSS lengths, points for type, dots for a declared printer DPI, screen pixels for preview) is
 * derived from them here and nowhere else.
 */
export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;
export const CSS_PX_PER_INCH = 96;

/** Round to 3 decimals (µm precision) so CSS strings and comparisons are stable. */
export const round3 = (v: number) => Math.round(v * 1000) / 1000;

export const mmToPt = (mm: number) => round3((mm / MM_PER_INCH) * PT_PER_INCH);
export const ptToMm = (pt: number) => round3((pt / PT_PER_INCH) * MM_PER_INCH);
/** CSS reference pixels (96 per inch) — what Chromium uses for print layout. */
export const mmToCssPx = (mm: number) => (mm / MM_PER_INCH) * CSS_PX_PER_INCH;
/** Printer dots at a declared DPI (never detected, A-1). */
export const mmToDots = (mm: number, dpi: number) => Math.round((mm / MM_PER_INCH) * dpi);
export const dotsToMm = (dots: number, dpi: number) => round3((dots / dpi) * MM_PER_INCH);
/** PDF user-space points (1/72 in) to millimetres — used by the print output tests. */
export const pdfPtToMm = (pt: number) => round3((pt / PT_PER_INCH) * MM_PER_INCH);

/** A CSS length in millimetres: 99.1 → "99.1mm", 4.65 → "4.65mm", 1/3 → "0.333mm". */
export function cssMm(mm: number): string {
  const v = round3(mm);
  return `${Object.is(v, -0) ? 0 : v}mm`;
}

/** A CSS length in points, for type sizes. */
export function cssPt(pt: number): string {
  return `${round3(pt)}pt`;
}

/** A millimetre figure for people: no trailing zeros («99.1», «210», «4.65»). */
export function fmtMm(mm: number): string {
  return String(round3(mm));
}
