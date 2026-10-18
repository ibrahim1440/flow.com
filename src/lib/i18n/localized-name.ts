// E7 (owner decision, 16 Oct 2026): which master-data name a screen shows for a product or a
// material, by interface language. Pure — no React, no Prisma — so the rule is unit-tested
// and the server and client cannot disagree about it.
//
// The rule (docs/ops/ARABIC-NAMES.md):
//   Arabic interface  → the Arabic name (CoffeeProduct.productNameAr / MaterialItem.nameAr);
//                       when it is missing or blank, the English name, isolated left-to-right
//                       with no marker; when both are missing, the caller's last resort (a
//                       stable code such as the SKU or material code).
//   English interface → the English name; when it is blank (the column is required, so only
//                       an empty string), the Arabic name, isolated right-to-left; then the
//                       last resort.
// Names are only ever read here. Product IDs, SKU codes and material codes are never derived
// from or replaced by a display name.

export type UiLang = "ar" | "en";

export type NameSource = "ar" | "en" | "code";

export type PickedName = {
  text: string;
  /** Which value was used: the Arabic name, the English name, or the last resort. */
  source: NameSource;
  /** True when the preferred name for this interface language was missing. */
  isFallback: boolean;
  /** Direction of the text itself, for <bdi dir>. Codes are left-to-right. */
  dir: "rtl" | "ltr";
};

const clean = (s: string | null | undefined): string => (typeof s === "string" ? s.trim() : "");

export function pickLocalizedName(
  lang: UiLang,
  names: { en?: string | null; ar?: string | null },
  lastResort = "—"
): PickedName {
  const en = clean(names.en);
  const ar = clean(names.ar);
  const order: NameSource[] = lang === "ar" ? ["ar", "en"] : ["en", "ar"];
  for (const source of order) {
    const text = source === "ar" ? ar : en;
    if (text) return { text, source, isFallback: source !== order[0], dir: source === "ar" ? "rtl" : "ltr" };
  }
  return { text: clean(lastResort) || "—", source: "code", isFallback: true, dir: "ltr" };
}
