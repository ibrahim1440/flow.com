// «استيراد المنتجات من قيود» — how one row of Qoyod's products export becomes the system's record. Pure (no database),
// so every rule here is asserted in tests/settings/unit/data-import.test.ts.
//
// Qoyod keeps everything in one list; the system keeps three kinds:
//   · green coffee (GreenBean)      — «مادة أولية» in a green-coffee category (or named «محصول اخضر»);
//   · a material (MaterialItem)     — any other «مادة أولية» (bags, stickers, cups, café supplies) and a bought-and-sold
//                                     «منتج» outside the coffee categories (sweets, retail tools): café stock;
//   · a sellable SKU (ProductSKU)   — «منتج مجمع» (Qoyod's manufactured product: the coffee packs), and a «منتج» in a
//                                     coffee-sales category (a pack bought ready);
//   · skipped                       — «مصروف» and «خدمة» (an expense or a service is not stock).
// Finished-goods quantities are not imported (finished stock is born from roasting and packing here): reported only.

/** What a Qoyod row becomes. */
export type QoyodKind = "GREEN" | "MATERIAL" | "SKU" | "SKIP";

const norm = (v: string) => v.replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/\s+/g, " ").trim().toLowerCase();
const has = (v: string, ...words: string[]) => words.some((w) => norm(v).includes(norm(w)));

/** A category whose products are coffee sold by the pack (B2B, the online store, the café's crops, café operation). */
export const isCoffeeSalesCategory = (category: string) => has(category, "b2b", "مبيعات القهوه", "موقع سله", "سلة", "محاصيل", "البن المقهي", "منتجات البن");

export function routeQoyodRow(type: string, category: string, name: string): { kind: QoyodKind; reason?: { ar: string; en: string } } {
  const t = norm(type);
  if (t === norm("مصروف") || t === norm("خدمة")) return { kind: "SKIP", reason: { ar: `«${type}» ليس صنف مخزون: يُتخطّى`, en: `«${type}» is not stock: skipped` } };
  if (t === norm("مادة أولية")) return { kind: has(category, "بن القهوه الخضراء", "البن الاخضر", "بن اخضر") || has(name, "محصول اخضر", "محصول اخصر", "green") ? "GREEN" : "MATERIAL" };
  if (t === norm("منتج مجمع")) return { kind: "SKU" };
  if (t === norm("منتج")) return { kind: isCoffeeSalesCategory(category) ? "SKU" : "MATERIAL" };
  return { kind: "SKIP", reason: { ar: `نوع غير معروف «${type}»: يُتخطّى`, en: `Unknown type «${type}»: skipped` } };
}

/**
 * The system's item category for a Qoyod material, by the seeded category ids (src/lib/inventory/item-categories.ts);
 * null when Qoyod's category has no obvious home (the importer then matches the system category by name, else «أخرى»).
 */
export function materialCategoryFor(category: string, type: string): string | null {
  if (has(category, "اكياس", "تغليف", "تعبئه")) return "cat_roastery_bags";
  if (has(category, "استيكر", "ملصق")) return "cat_roastery_labels";
  if (has(category, "اكواب", "كوب")) return "cat_cafe_cups";
  if (has(category, "حلا", "حلويات")) return "cat_cafe_sweets";
  if (has(category, "حليب", "البان")) return "cat_cafe_dairy";
  if (has(category, "سكر")) return "cat_cafe_sugar";
  if (has(category, "تشغيل", "تجزئه", "مقهي")) return "cat_cafe";
  return norm(type) === norm("منتج") ? "cat_cafe" : null;
}

/** Qoyod categories whose items are counted in pieces (no unit column needed). */
export const countsInPieces = (category: string, type: string) => norm(type) === norm("منتج") || has(category, "اكياس", "استيكر", "ملصق", "اكواب", "كوب", "حلا");

// Unit words after a number. `\b` does not see Arabic letters as word characters, so the end of a unit is a lookahead
// for "not a letter" (Arabic or Latin).
const END = "(?![A-Za-z\\u0621-\\u064A])";
const KG = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:كيلو\\s*جرام|كيلوغرام|كيلو|كغ|كجم|kg|kilo)${END}`, "i");
const GRAM = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:جرام|غرام|جم|gram|g)${END}`, "i");
const latin = (v: string) => v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

/** The pack weight in grams from the product's name («… 250 جرام», «… 1 كيلو», «3 Kg»), or null. */
export function weightFromName(name: string): number | null {
  const t = latin(name);
  const kg = KG.exec(t);
  if (kg) return Math.round(Number(kg[1]) * 1000);
  const g = GRAM.exec(t);
  return g ? Math.round(Number(g[1])) : null;
}

const COUNTRIES: [string[], string, string][] = [
  [["برازيل", "brazil"], "Brazil", "البرازيل"], [["اثيوبيا", "ethiopia"], "Ethiopia", "إثيوبيا"], [["نيكارجوا", "نيكاراغوا", "nicaragua"], "Nicaragua", "نيكاراغوا"],
  [["اندونيسيا", "اندونسيا", "indonesia"], "Indonesia", "إندونيسيا"], [["كولمبيا", "كولومبيا", "colombia"], "Colombia", "كولومبيا"],
  [["كوستاريكا", "costa"], "Costa Rica", "كوستاريكا"], [["قواتيمالا", "غواتيمالا", "guatemala"], "Guatemala", "غواتيمالا"],
  [["يمني", "اليمن", "يمن", "سبا", "yemen"], "Yemen", "اليمن"], [["اوغندا", "uganda"], "Uganda", "أوغندا"], [["سلفادور", "salvador"], "El Salvador", "السلفادور"],
  [["رواندا", "rwanda"], "Rwanda", "رواندا"], [["كينيا", "kenya"], "Kenya", "كينيا"], [["بنما", "panama"], "Panama", "بنما"], [["هندوراس", "honduras"], "Honduras", "هندوراس"],
  [["بيرو", "peru"], "Peru", "بيرو"], [["تنزانيا", "tanzania"], "Tanzania", "تنزانيا"], [["بوروندي", "burundi"], "Burundi", "بوروندي"], [["المكسيك", "mexico"], "Mexico", "المكسيك"],
];
/** The origin country named in a coffee's name, or null (a blend, merchandise). */
export function countryFromName(name: string): { en: string; ar: string } | null {
  const n = norm(name);
  for (const [words, en, ar] of COUNTRIES) if (words.some((w) => n.includes(norm(w)))) return { en, ar };
  return null;
}

/**
 * The product a pack belongs to: the name without its weight and its sales-channel words, so «برازيل موجيانا 250 جرام»,
 * «برازيل موجيانا 1 كيلو مبيعات المقهي» and «… موقع الالكتروني سلة» are one product with three SKUs.
 */
export function productNameOf(name: string): string {
  const drop = (re: RegExp) => (v: string) => v.replace(re, " ");
  let t = latin(name);
  t = drop(new RegExp(KG.source, "gi"))(t);
  t = drop(new RegExp(GRAM.source, "gi"))(t);
  t = t.replace(/مبيعات\s*(?:ال)?مقه[يى]|(?:ال)?موقع\s*(?:ال)?[اإ]?لكترون[يى]|(?:ال)?موقع\s*(?:ال)?[اإ]?كترون[يى]|سل[ةه](?![ء-ي])|تشغيل\s*مقه[يى]|تجزئ[ةه]|^\s*قهو[ةه](?=\s)|B2B/gi, " ");
  return t.replace(/[()\t]/g, " ").replace(/\s+/g, " ").trim();
}
