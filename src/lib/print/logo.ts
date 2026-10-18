/**
 * The official logo on printed labels (A-7). Asset: brand guideline v003
 * `brand/logos/svg-trimmed/hiqbah-horizontal-07-mono-black.svg`, copied unchanged to
 * `public/brand/hiqbah-horizontal-mono-black.svg` (monochrome, for thermal and laser alike).
 *
 * Minimum printed height 8 mm (design P2-1, ≈ 27 mm wide). Cross-check: the thinnest Latin stem of
 * the wordmark is 13.137 of the 428.8-unit viewBox height, i.e. 0.245 mm at 8 mm — two dots at
 * 203 dpi (the 0.25 mm rule weight of the S1 artwork). Below that the logo is omitted. To be
 * validated on real hardware (A-8).
 */
import { mmToDots } from "./units";

export const LOGO_SRC = "/brand/hiqbah-horizontal-mono-black.svg";
export const LOGO_VIEWBOX = { w: 1466.9, h: 428.8 };
export const LOGO_ASPECT = LOGO_VIEWBOX.w / LOGO_VIEWBOX.h;
export const LOGO_MIN_HEIGHT_MM = 8;
export const LOGO_STEM_UNITS = 13.137;
/** Clear space around the logo: ≈ the «ح» stroke height at the minimum size. */
export const LOGO_CLEAR_MM = 1.5;

export const logoWidthMm = (heightMm: number) => heightMm * LOGO_ASPECT;
export const stemMm = (heightMm: number) => (LOGO_STEM_UNITS / LOGO_VIEWBOX.h) * heightMm;

/** Whether the logo may print at `heightMm` within `availWidthMm` (A-4: logo last, only if legible). */
export function logoAllowed(heightMm: number, availWidthMm: number): boolean {
  return heightMm >= LOGO_MIN_HEIGHT_MM && logoWidthMm(heightMm) + 2 * LOGO_CLEAR_MM <= availWidthMm;
}

/** Stem width in printer dots at the declared DPI (for the guidance text and tests). */
export const stemDots = (heightMm: number, dpi: number) => mmToDots(stemMm(heightMm), dpi);
