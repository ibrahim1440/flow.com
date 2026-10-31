// «استيراد البيانات من Excel» — the master data carried in from Qoyod (or typed into the template) before go-live:
// customers, suppliers, green coffee, materials (packaging / café stock) and products with their SKUs. Pure: the
// column definitions, the header matching and the cell parsers, so the rules are asserted without a database.
//
// One row per record (per SKU for products). Headers in Arabic or English, Qoyod's export words accepted as aliases;
// a column the importer does not know is ignored with a warning (a Qoyod export carries columns such as balances that
// have their own path — the opening balances), never silently mapped.
// No server import: the settings page reads the entity names and labels from here too.

export const IMPORT_ENTITIES = ["customers", "suppliers", "green", "materials", "products"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];
export const isImportEntity = (v: unknown): v is ImportEntity => typeof v === "string" && (IMPORT_ENTITIES as readonly string[]).includes(v);

export const IMPORT_MAX_ROWS = 2000;

export type Column = { key: string; required: boolean; ar: string; en: string; aliases: string[]; hint?: string; example: string; text?: boolean };
const col = (key: string, required: boolean, ar: string, en: string, aliases: string[], example: string, hint?: string, text?: boolean): Column => ({ key, required, ar, en, aliases, example, hint, text });

export const ENTITY_LABEL: Record<ImportEntity, { ar: string; en: string }> = {
  customers: { ar: "العملاء", en: "Customers" },
  suppliers: { ar: "الموردون", en: "Suppliers" },
  green: { ar: "البن الأخضر", en: "Green coffee" },
  materials: { ar: "المواد والمستلزمات", en: "Materials & supplies" },
  products: { ar: "المنتجات", en: "Products" },
};

export const SEGMENT_WORDS: Record<string, "WHOLESALE" | "RETAIL" | "CAFE" | "DISTRIBUTOR" | "OTHER"> = {
  wholesale: "WHOLESALE", "جملة": "WHOLESALE", retail: "RETAIL", "تجزئة": "RETAIL", "مفرق": "RETAIL",
  cafe: "CAFE", "café": "CAFE", "مقهى": "CAFE", "كافيه": "CAFE", distributor: "DISTRIBUTOR", "موزع": "DISTRIBUTOR",
  other: "OTHER", "أخرى": "OTHER", "اخرى": "OTHER",
};
export const SUPPLIER_KIND_WORDS: Record<string, "GOODS_SERVICES" | "CUSTOMS" | "CLEARING_AGENT"> = {
  goods_services: "GOODS_SERVICES", goods: "GOODS_SERVICES", services: "GOODS_SERVICES", "بضائع": "GOODS_SERVICES", "خدمات": "GOODS_SERVICES", "بضائع وخدمات": "GOODS_SERVICES", "مورد": "GOODS_SERVICES",
  customs: "CUSTOMS", "جمارك": "CUSTOMS", "الجمارك": "CUSTOMS", clearing_agent: "CLEARING_AGENT", "مخلص جمركي": "CLEARING_AGENT", "مخلص": "CLEARING_AGENT",
};
export const UNIT_WORDS: Record<string, "UNIT" | "KG" | "GRAM" | "PIECE" | "LITER"> = {
  unit: "UNIT", "وحدة": "UNIT", "عبوة": "UNIT", "كيس": "UNIT", kg: "KG", "كيلو": "KG", "كغ": "KG", "كجم": "KG", "كيلوجرام": "KG", "كيلوغرام": "KG",
  gram: "GRAM", g: "GRAM", "غرام": "GRAM", "جرام": "GRAM", "جم": "GRAM", piece: "PIECE", pcs: "PIECE", "حبة": "PIECE", "قطعة": "PIECE", "حبه": "PIECE",
  liter: "LITER", litre: "LITER", l: "LITER", "لتر": "LITER",
};
export const PRODUCT_CATEGORY_WORDS: Record<string, "ROASTED_COFFEE" | "GREEN_COFFEE" | "MERCHANDISE" | "OTHER"> = {
  roasted_coffee: "ROASTED_COFFEE", "بن محمص": "ROASTED_COFFEE", "قهوة محمصة": "ROASTED_COFFEE", "محمص": "ROASTED_COFFEE",
  green_coffee: "GREEN_COFFEE", "بن أخضر": "GREEN_COFFEE", "بن اخضر": "GREEN_COFFEE",
  merchandise: "MERCHANDISE", "منتجات": "MERCHANDISE", "بضائع": "MERCHANDISE", "أدوات": "MERCHANDISE", other: "OTHER", "أخرى": "OTHER", "اخرى": "OTHER",
};
const YES = new Set(["yes", "y", "true", "1", "نعم", "صح", "✓"]);
const NO = new Set(["no", "n", "false", "0", "لا", ""]);

const NAME = ["الاسم", "الإسم", "name"];
const QTY_HINT = "الكمية في المخزون في تاريخ القطع (اتركها فارغة إن لم يوجد)";
const LOC_HINT = "رمز الموقع: RST المصنع، WH المستودع، CAFE المقهى (فارغ = الموقع الافتراضي)";

export const COLUMNS: Record<ImportEntity, Column[]> = {
  customers: [
    col("name", true, "الاسم", "Name", ["اسم العميل", "العميل", "الاسم التجاري", "customer", "customer name", ...NAME], "مقهى الريف", "يجب أن يطابق اسم العميل في قيود حرفيًا (تُطابَق عليه الأرصدة الافتتاحية)"),
    col("name_ar", false, "الاسم بالعربية", "Arabic name", ["الاسم العربي", "name ar"], "مقهى الريف"),
    col("phone", false, "الجوال", "Phone", ["رقم الجوال", "الهاتف", "رقم الهاتف", "جوال", "mobile", "phone number"], "0501234567", "اجعل العمود «نص» في Excel حتى لا يضيع الصفر الأول", true),
    col("email", false, "البريد الإلكتروني", "Email", ["البريد", "الايميل", "الإيميل", "e-mail"], "info@example.com"),
    col("address", false, "العنوان", "Address", ["العنوان الوطني", "address line"], "حي النخيل، شارع الملك فهد"),
    col("city", false, "المدينة", "City", [], "الرياض"),
    col("vat_number", false, "الرقم الضريبي", "VAT number", ["رقم التسجيل الضريبي", "الرقم الضريبي للعميل", "vat", "tax number"], "300000000000003", "15 رقمًا يبدأ وينتهي بـ 3", true),
    col("commercial_reg_no", false, "السجل التجاري", "Commercial registration", ["رقم السجل التجاري", "cr", "cr number"], "1010000000", "10 أرقام", true),
    col("segment", false, "الفئة", "Segment", ["فئة العميل", "نوع العميل", "التصنيف"], "مقهى", "جملة · تجزئة · مقهى · موزع · أخرى"),
    col("payment_terms_days", false, "شروط الدفع (يوم)", "Payment terms (days)", ["مدة السداد", "شروط الدفع", "أيام السداد", "payment terms"], "30", "من 0 إلى 365"),
    col("credit_limit", false, "حد الائتمان", "Credit limit", ["الحد الائتماني", "credit limit"], "5000", "بالريال"),
  ],
  suppliers: [
    col("name", true, "الاسم", "Name", ["اسم المورد", "المورد", "supplier", "supplier name", ...NAME], "شركة البن العالمية", "يجب أن يطابق اسم المورد في قيود حرفيًا (تُطابَق عليه الأرصدة الافتتاحية)"),
    col("contact", false, "جهة الاتصال", "Contact", ["اسم المسؤول", "المسؤول", "contact person"], "أحمد"),
    col("phone", false, "الجوال", "Phone", ["رقم الجوال", "الهاتف", "رقم الهاتف", "mobile"], "0501234567", "اجعل العمود «نص» في Excel", true),
    col("email", false, "البريد الإلكتروني", "Email", ["البريد", "الايميل", "الإيميل", "e-mail"], "sales@example.com"),
    col("vat_number", false, "الرقم الضريبي", "VAT number", ["رقم التسجيل الضريبي", "vat", "tax number"], "300000000000003", "15 رقمًا يبدأ وينتهي بـ 3 (فارغ لغير المسجّل)", true),
    col("payment_terms_days", false, "شروط الدفع (يوم)", "Payment terms (days)", ["مدة السداد", "شروط الدفع", "payment terms"], "30", "من 0 إلى 365"),
    col("kind", false, "نوع المورد", "Supplier kind", ["النوع", "kind"], "بضائع وخدمات", "بضائع وخدمات · جمارك · مخلص جمركي"),
    col("non_resident", false, "غير مقيم", "Non-resident", ["مورد خارجي", "خارج المملكة", "non resident"], "لا", "نعم / لا"),
  ],
  green: [
    col("serial_number", true, "رمز اللوط", "Lot code", ["الرمز", "رقم اللوط", "رمز الصنف", "كود الصنف", "code", "sku", "serial"], "GB-ETH-001", "فريد لكل لوط؛ إعادة الاستيراد تتخطى الرمز الموجود", true),
    col("name_en", false, "الاسم بالإنجليزية", "English name", ["bean type", "name en", "name"], "Ethiopia Guji"),
    col("name_ar", false, "الاسم بالعربية", "Arabic name", ["الاسم", "اسم الصنف", "اسم البن"], "إثيوبيا قوجي", "اسم واحد على الأقل (عربي أو إنجليزي)"),
    col("country", false, "الدولة", "Country", ["بلد المنشأ", "المنشأ", "origin"], "Ethiopia"),
    col("country_ar", false, "الدولة بالعربية", "Country (Arabic)", ["المنشأ بالعربية"], "إثيوبيا"),
    col("region", false, "المنطقة", "Region", ["region"], "Guji"),
    col("variety", false, "السلالة", "Variety", ["الصنف النباتي", "variety"], "Heirloom"),
    col("process", false, "المعالجة", "Process", ["طريقة المعالجة", "process"], "Washed"),
    col("altitude", false, "الارتفاع", "Altitude", ["altitude"], "1900-2100"),
    col("quantity_kg", false, "الكمية (كغ)", "Quantity (kg)", ["الكمية", "الرصيد", "الكمية الحالية", "quantity", "qty"], "120.5", QTY_HINT),
    col("unit_cost", false, "تكلفة الكيلو", "Cost per kg", ["التكلفة", "متوسط التكلفة", "تكلفة الوحدة", "unit cost", "cost"], "42.50", "متوسط تكلفة الكيلو في قيود (يدخل في تقييم المخزون الافتتاحي)"),
    col("location", false, "الموقع", "Location", ["المستودع", "المخزن", "warehouse"], "WH", LOC_HINT),
    col("sack_count", false, "عدد الأكياس", "Sack count", [], "2"),
    col("sack_weight_kg", false, "وزن الكيس (كغ)", "Sack weight (kg)", [], "60"),
  ],
  materials: [
    col("code", true, "رمز الصنف", "Item code", ["الرمز", "كود الصنف", "رقم الصنف", "code", "sku"], "BAG-250", "فريد لكل صنف؛ إعادة الاستيراد تتخطى الرمز الموجود", true),
    col("name", true, "الاسم", "Name", ["اسم الصنف", "name en", ...NAME], "كيس 250 غ بصمام"),
    col("name_ar", false, "الاسم بالعربية", "Arabic name", ["الاسم العربي"], "كيس 250 غ بصمام"),
    col("category", false, "التصنيف", "Category", ["تصنيف الصنف", "الفئة", "category"], "أكياس وتغليف", "اسم تصنيف من «المخزون › التصنيفات» (فارغ = أكياس وتغليف)"),
    col("unit", false, "الوحدة", "Unit", ["وحدة القياس", "unit of measure", "uom"], "حبة", "حبة · وحدة · كيلو · غرام · لتر (فارغ = وحدة التصنيف)"),
    col("quantity", false, "الكمية", "Quantity", ["الرصيد", "الكمية الحالية", "quantity", "qty"], "500", QTY_HINT),
    col("unit_cost", false, "تكلفة الوحدة", "Unit cost", ["التكلفة", "متوسط التكلفة", "unit cost", "cost"], "1.25", "متوسط التكلفة في قيود (يدخل في تقييم المخزون الافتتاحي)"),
    col("location", false, "الموقع", "Location", ["المستودع", "المخزن", "warehouse"], "WH", LOC_HINT),
    col("reorder_point", false, "حد إعادة الطلب", "Reorder point", ["الحد الأدنى", "reorder point"], "100"),
    col("notes", false, "ملاحظات", "Notes", ["الوصف", "notes", "description"], ""),
  ],
  products: [
    col("product_name_en", true, "اسم المنتج بالإنجليزية", "Product name (English)", ["product", "product name", "اسم المنتج"], "Ethiopia Guji", "صف لكل عبوة؛ العبوات التي تحمل الاسم نفسه تُجمع تحت منتج واحد"),
    col("product_name_ar", false, "اسم المنتج بالعربية", "Product name (Arabic)", ["المنتج"], "إثيوبيا قوجي"),
    col("country_en", true, "بلد المنشأ", "Country", ["الدولة", "المنشأ", "country", "origin"], "Ethiopia", "لغير القهوة اكتب بلد الصنع"),
    col("country_ar", false, "بلد المنشأ بالعربية", "Country (Arabic)", ["الدولة بالعربية"], "إثيوبيا"),
    col("region", false, "المنطقة", "Region", [], "Guji"),
    col("variety", false, "السلالة", "Variety", [], "Heirloom"),
    col("process", false, "المعالجة", "Process", [], "Washed"),
    col("cup_notes_ar", false, "النكهات", "Cup notes (Arabic)", ["ملاحظات التذوق"], "توت، ياسمين"),
    col("expected_roast_loss", false, "نسبة فقد التحميص %", "Expected roast loss %", ["فقد التحميص"], "15", "من 0 إلى 50 (فارغ = 15)"),
    col("sku_code", true, "رمز العبوة", "SKU code", ["رمز المنتج", "الرمز", "كود المنتج", "sku", "code"], "ETH-GUJ-250", "فريد لكل عبوة؛ إعادة الاستيراد تتخطى الرمز الموجود", true),
    col("sku_name_ar", false, "اسم العبوة", "SKU name (Arabic)", ["اسم الصنف", "الاسم"], "إثيوبيا قوجي 250 غ"),
    col("weight_grams", true, "الوزن (غرام)", "Weight (g)", ["الوزن", "الحجم", "weight"], "250", "صافي وزن العبوة بالغرام"),
    col("price", false, "السعر", "Price", ["سعر البيع", "price", "selling price"], "65", "سعر البيع بالريال"),
    col("barcode", false, "الباركود", "Barcode", ["barcode", "ean"], "6281234567890", "فريد إن وُجد", true),
    col("category", false, "الفئة", "Category", ["نوع المنتج", "category"], "بن محمص", "بن محمص · بن أخضر · منتجات · أخرى"),
    col("unit", false, "الوحدة", "Unit", ["وحدة القياس", "uom"], "وحدة", "وحدة · حبة · كيلو · غرام (فارغ = وحدة)"),
  ],
};

// ── Header matching ─────────────────────────────────────────────────────────────────────────────────────────────────
export const normHead = (h: string) =>
  h.replace(/^﻿/, "").replace(/\*/g, "").replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/\s+/g, " ").trim().toLowerCase();

/** The header row to column keys: `keys[i]` is the column key of position i (null when unknown or a repeat). */
export function matchHeader(entity: ImportEntity, header: string[]) {
  const map = new Map<string, string>();
  // Exact keys and the primary labels win over aliases (an alias such as «الاسم» is also another column's label).
  for (const c of COLUMNS[entity]) for (const h of [c.key, c.ar, c.en]) map.set(normHead(h), c.key);
  for (const c of COLUMNS[entity]) for (const h of c.aliases) if (!map.has(normHead(h))) map.set(normHead(h), c.key);
  const seen = new Set<string>();
  const keys: (string | null)[] = [];
  const unknown: string[] = [];
  const repeated: string[] = [];
  for (const raw of header) {
    const h = (raw ?? "").trim();
    if (!h) { keys.push(null); continue; }
    const k = map.get(normHead(h)) ?? null;
    if (!k) { unknown.push(h); keys.push(null); continue; }
    if (seen.has(k)) { repeated.push(h); keys.push(null); continue; }
    seen.add(k);
    keys.push(k);
  }
  const missing = COLUMNS[entity].filter((c) => c.required && !seen.has(c.key));
  return { keys, unknown, repeated, missing };
}

// ── Cell parsers ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Arabic-Indic and Eastern Arabic-Indic digits, the Arabic decimal and thousands marks, to Latin. */
export const latinDigits = (v: string) =>
  v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/٫/g, ".").replace(/٬/g, ",");

/** A plain number from a cell: Latin digits, thousands separators and spaces dropped; null when empty; NaN when bad. */
export function num(v: string): number | null {
  const t = latinDigits(v).replace(/[,\s]/g, "").replace(/(ر\.?س|sar|kg|كغ|g|غ|%)$/i, "");
  if (!t) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN;
  return Number(t);
}
/** A decimal text with at most `dp` places (money / costs keep exact text). */
export function decimalText(v: string, dp: number): string | null | "BAD" {
  const t = latinDigits(v).replace(/[,\s]/g, "").replace(/(ر\.?س|sar)$/i, "");
  if (!t) return null;
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(t);
  if (!m) return "BAD";
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > dp) return "BAD";
  return frac ? `${m[1]}.${frac}` : m[1];
}
/** A phone as text: digits kept as typed, a leading zero restored when Excel stored «05…» as a number. */
export function phoneText(v: string): string | null {
  const t = latinDigits(v).trim();
  if (!t) return null;
  if (/^5\d{8}$/.test(t)) return `0${t}`;
  return t;
}
export const yesNo = (v: string): boolean | null => {
  const t = v.trim().toLowerCase();
  if (YES.has(t)) return true;
  if (NO.has(t)) return false;
  return null;
};
export const word = <T,>(dict: Record<string, T>, v: string): T | null | undefined => {
  const t = v.trim();
  if (!t) return null;
  return dict[t] ?? dict[t.toLowerCase()] ?? dict[t.toUpperCase()] ?? (Object.values(dict).includes(t.toUpperCase() as T) ? (t.toUpperCase() as T) : undefined);
};
/** A name compared the way people mean it: spaces collapsed, case ignored. */
export const nameKey = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();
