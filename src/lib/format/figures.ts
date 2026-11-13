/**
 * P2 ERR-19: the figures «يومي» (sales band) and «لوحة الأداء» both show, read the same way, so the same month never
 * shows 2,489 on one screen and 2,488 on the other, and 0.46 % never shows as «1٪».
 */

/** Percent of `part` in `whole`, unrounded (null when there is no whole). */
export function percentOf(part: string | number, whole: string | number | null | undefined): number | null {
  const p = Number(part), w = Number(whole);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return null;
  return (p * 100) / w;
}

/**
 * A whole percent for the screen, from the UNROUNDED value (never a rounded one rounded again — 0.46 → 0.5 → «1»):
 * above 0 and under 1 reads «أقل من 1» / «<1»; otherwise half-up to a whole number.
 */
export function wholePercentLabel(v: number | string | null | undefined, ar: boolean): string {
  const x = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(x)) return "—";
  if (x > 0 && x < 1) return ar ? "أقل من 1" : "<1";
  return Math.round(x).toLocaleString("en-US");
}

/** What has to be collected per remaining day to reach the target: rounded UP to a whole riyal (the band's rule). */
export function perDayNeeded(remaining: string | number | null | undefined, daysLeft: number | null | undefined): number | null {
  const r = Number(remaining);
  if (!daysLeft || daysLeft <= 0 || !Number.isFinite(r) || r <= 0) return null;
  // The same as the band's server rule (remaining ÷ days, ROUND_CEIL to a riyal), on the halala figure.
  return Math.ceil(Math.round(r * 100) / daysLeft / 100 - 1e-9);
}
