/**
 * Roasting station v2 — a coffee's screen colour and label letter (D12). The colour is on the screen only (the label is
 * black, owner decision): the bucket's colour key (GreenBucket.colorKey, stable per coffee) → a strong and a tint.
 * The label's letter is the first letter of the coffee's Arabic name (ك = كولومبي, إ = إثيوبي).
 */
export const COFFEE_COLORS: Record<string, { strong: string; tint: string }> = {
  BLUE: { strong: "#3b6385", tint: "#eaf0f5" },
  BROWN: { strong: "#8a5a2b", tint: "#f3e9dd" },
  GREEN: { strong: "#3b7a45", tint: "#e9f2e7" },
  ORANGE: { strong: "#a65a12", tint: "#fbefe1" },
  PURPLE: { strong: "#6b4c8a", tint: "#f0eaf6" },
  RED: { strong: "#9c3527", tint: "#f8e8e5" },
  YELLOW: { strong: "#7d6400", tint: "#fbf3d6" },
  PINK: { strong: "#9c3b66", tint: "#f8e6ee" },
};
export const coffeeColor = (key: string | null | undefined) => COFFEE_COLORS[key ?? ""] ?? COFFEE_COLORS.BLUE;

export function coffeeName(p: { productNameAr?: string | null; productNameEn?: string | null } | null | undefined): string {
  return (p?.productNameAr || p?.productNameEn || "").trim();
}

export function coffeeLetter(p: { productNameAr?: string | null; productNameEn?: string | null } | null | undefined): string {
  const n = coffeeName(p);
  const ch = [...n].find((c) => /\p{L}/u.test(c));
  return ch ? ch.toUpperCase() : "؟";
}
