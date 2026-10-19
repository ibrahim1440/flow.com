// SCA flavour descriptors in the viewer's language. The stored descriptor is the English word
// (existing scores keep matching); only the label shown follows the language (G-13).
// A plain module (no React, no styles) so the label/print renderer (components/print/LabelView)
// can use it without pulling in the scoring form.
type Lang = "ar" | "en";

export const FLAVOR_AR: Record<string, string> = {
  Fruity: "فاكهي", Citrus: "حمضيات", Lemon: "ليمون", Orange: "برتقال", Grapefruit: "جريب فروت",
  Berry: "توتي", Blueberry: "توت أزرق", Strawberry: "فراولة", Raspberry: "توت العليق",
  "Stone Fruit": "فاكهة ذات نواة", Peach: "خوخ", Apricot: "مشمش", Plum: "برقوق",
  Tropical: "استوائي", Mango: "مانجو", Pineapple: "أناناس", "Passion Fruit": "باشن فروت",
  Floral: "زهري", Jasmine: "ياسمين", Rose: "ورد", Lavender: "خزامى",
  Chocolate: "شوكولاتة", "Dark Chocolate": "شوكولاتة داكنة", "Milk Chocolate": "شوكولاتة بالحليب", Cocoa: "كاكاو",
  Nutty: "مكسرات", Almond: "لوز", Hazelnut: "بندق", Peanut: "فول سوداني",
  Caramel: "كراميل", Honey: "عسل", Toffee: "توفي", Vanilla: "فانيلا", "Brown Sugar": "سكر بني",
  Spicy: "توابل", Cinnamon: "قرفة", Clove: "قرنفل",
  Herbal: "عشبي", "Green Tea": "شاي أخضر",
  Earthy: "ترابي", Tobacco: "تبغ", Cedar: "أرز",
  Winey: "نبيذي", Fermented: "مخمّر",
};

/** A stored descriptor in the viewer's language; an unknown one is shown as stored. */
export function descriptorLabel(tag: string, lang: Lang): string {
  return lang === "ar" ? (FLAVOR_AR[tag] ?? tag) : tag;
}
