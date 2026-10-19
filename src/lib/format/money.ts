// Money as every Sales screen and document prints it: Latin digits, comma groups, two places.
// Pure, so the printed documents (src/lib/print) and their tests share the screens' formatter.

/**
 * `12450.5` → `12,450.50`.
 *
 * The padding and grouping are done as STRING operations. `Number(x).toFixed(2)` would be
 * one line shorter and would route the amount through binary floating point, which is the
 * one thing every layer below this has been careful not to do.
 */
export function formatMoney(raw: string, places = 2): string {
  const trimmed = raw.trim();
  // Anything that is not a plain decimal is handed back untouched rather than mangled.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;

  const negative = trimmed.startsWith("-");
  const [intPart, fracPart = ""] = trimmed.replace(/^-/, "").split(".");
  const frac = (fracPart + "0".repeat(places)).slice(0, places);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${places > 0 ? "." + frac : ""}`;
}
