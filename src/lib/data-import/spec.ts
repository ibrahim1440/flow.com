// «استيراد البيانات من Excel / قيود» — the master data carried in from Qoyod before go-live, in QOYOD'S OWN FILE
// FORMATS (the owner's rule: the import matches Qoyod's exports column for column, so an export is uploaded as it is):
//   · customers — Qoyod «العملاء» export (customers.xlsx), its 26 columns in Qoyod's order;
//   · suppliers — Qoyod «الموردون» export (vendors.xlsx), its 14 columns;
//   · products  — Qoyod «المنتجات» export (Products-YYYY-MM-DD.csv), its 14 columns; each row is routed by Qoyod's
//     «النوع» and «صنف المنتج» to green coffee, a material (packaging / café stock) or a sellable SKU, and expenses /
//     services are skipped. Three optional columns may follow Qoyod's (الوحدة · الموقع · الوزن (غرام)): Qoyod's export
//     carries no unit, site or pack weight.
// Pure: the column definitions, the header matching and the cell parsers, so the rules are asserted without a database.
// A Qoyod column the system does not keep is recognised and ignored (listed once in the preview); a column nobody knows
// is ignored with a warning, never silently mapped. No server import: the settings page reads the labels from here too.

export const IMPORT_ENTITIES = ["customers", "suppliers", "products"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];
export const isImportEntity = (v: unknown): v is ImportEntity => typeof v === "string" && (IMPORT_ENTITIES as readonly string[]).includes(v);

export const IMPORT_MAX_ROWS = 2000;

/**
 * A column: `qoyod` columns make the template, in this order, with Qoyod's own header; `ignore` columns are Qoyod's but
 * not kept by the system; `extra` columns are ours, accepted after Qoyod's (never in Qoyod's export).
 */
export type Column = { key: string; required: boolean; ar: string; en: string; aliases: string[]; hint?: string; example: string; text?: boolean; ignore?: boolean; extra?: boolean };
const col = (key: string, required: boolean, ar: string, en: string, aliases: string[], example: string, hint?: string, text?: boolean): Column => ({ key, required, ar, en, aliases, example, hint, text });
const ign = (key: string, ar: string, en: string): Column => ({ key, required: false, ar, en, aliases: [], example: "", ignore: true });
const extra = (c: Column): Column => ({ ...c, extra: true });

export const ENTITY_LABEL: Record<ImportEntity, { ar: string; en: string }> = {
  customers: { ar: "العملاء", en: "Customers" },
  suppliers: { ar: "الموردون", en: "Suppliers" },
  products: { ar: "المنتجات والمخزون", en: "Products & stock" },
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

/**
 * Qoyod's quantity units → the system's unit and the factor a Qoyod quantity is multiplied by (the unit cost is divided
 * by it). Qoyod keeps green coffee in grams and café liquids in millilitres; the system keeps kg and litres.
 */
export const QOYOD_UNITS: Record<string, { unit: "UNIT" | "KG" | "GRAM" | "PIECE" | "LITER"; factor: number }> = {
  "حبة": { unit: "PIECE", factor: 1 }, "حبه": { unit: "PIECE", factor: 1 }, "قطعة": { unit: "PIECE", factor: 1 }, piece: { unit: "PIECE", factor: 1 }, pcs: { unit: "PIECE", factor: 1 },
  "وحدة": { unit: "UNIT", factor: 1 }, "عبوة": { unit: "UNIT", factor: 1 }, unit: { unit: "UNIT", factor: 1 },
  "كيلو": { unit: "KG", factor: 1 }, "كغ": { unit: "KG", factor: 1 }, "كجم": { unit: "KG", factor: 1 }, kg: { unit: "KG", factor: 1 },
  "غرام": { unit: "GRAM", factor: 1 }, "جرام": { unit: "GRAM", factor: 1 }, "جم": { unit: "GRAM", factor: 1 }, g: { unit: "GRAM", factor: 1 }, gram: { unit: "GRAM", factor: 1 },
  "لتر": { unit: "LITER", factor: 1 }, l: { unit: "LITER", factor: 1 }, liter: { unit: "LITER", factor: 1 }, litre: { unit: "LITER", factor: 1 },
  "مل": { unit: "LITER", factor: 0.001 }, "ملل": { unit: "LITER", factor: 0.001 }, ml: { unit: "LITER", factor: 0.001 },
};
/** Green coffee's quantity unit in Qoyod (grams unless the importer is told kilos): grams become kg. */
export const GREEN_UNITS = { g: 0.001, kg: 1 } as const;
export type GreenUnit = keyof typeof GREEN_UNITS;

const YES = new Set(["yes", "y", "true", "1", "نعم", "صح", "✓"]);
const NO = new Set(["no", "n", "false", "0", "لا", ""]);

export const COLUMNS: Record<ImportEntity, Column[]> = {
  // Qoyod «العملاء» export, column for column.
  customers: [
    col("name", true, "اسم الجهة", "Name", ["الاسم", "اسم العميل", "العميل", "customer", "customer name", "name"], "مقهى الريف", "يُطابَق عليه رصيد العميل الافتتاحي لاحقًا"),
    col("ref", false, "الرقم المرجعي", "Reference", ["المرجع", "reference"], "CUS001", "رقم العميل في قيود (يظهر في المعاينة، لا يُحفظ)"),
    ign("legal_name", "اسم المنشأة", "Company name"), ign("website", "الموقع الالكتروني", "Website"),
    col("phone", false, "رقم الاتصال الأساسي", "Phone", ["الجوال", "رقم الجوال", "الهاتف", "رقم الهاتف", "mobile", "phone"], "0501234567", undefined, true),
    ign("phone2", "رقم الاتصال الثانوي", "Secondary phone"),
    col("email", false, "البريد الإلكتروني الأساسي", "Email", ["البريد الإلكتروني", "البريد", "email", "e-mail"], "info@example.com"),
    ign("email2", "البريد الإلكتروني الثانوي", "Secondary email"),
    col("status", false, "الحالة", "Status", ["status"], "Active", "Active / Inactive"),
    col("vat_number", false, "الرقم الضريبي", "VAT number", ["رقم التسجيل الضريبي", "vat", "tax number"], "300000000000003", "15 رقمًا يبدأ وينتهي بـ 3", true),
    ign("pos", "عميل نقاط بيع", "POS customer"),
    col("address", false, "عنوان الفوترة", "Billing address", ["العنوان", "address"], "6435, حي الشروفية, 36342"),
    col("ship_address", false, "عنوان الشحن", "Shipping address", [], "", "يُستخدم عنوانًا إن خلا عنوان الفوترة"),
    col("balance", false, "الرصيد الختامي (ر.س)", "Closing balance (SAR)", ["الرصيد", "الرصيد (ر.س)", "balance"], "0", "للعلم فقط: يدخل لاحقًا في الأرصدة الافتتاحية"),
    ign("tax_group", "رقم المجموعة الضريبية", "Tax group number"), ign("national_id", "الهوية الوطنية", "National ID"), ign("iqama", "رقم الإقامة", "Iqama"),
    ign("distinct_vat", "الرقم الضريبي المميز", "Distinct VAT number"), ign("n700", "رقم 700", "700 number"),
    col("commercial_reg_no", false, "رقم السجل التجاري", "Commercial registration", ["السجل التجاري", "cr", "cr number"], "7036227788", "10 أرقام", true),
    ign("lic_momra", "ترخيص وزارة الشؤون البلدية والقروية", "MOMRA licence"), ign("lic_hrsd", "ترخيص وزارة الموارد البشرية والتنمية الاجتماعية", "HRSD licence"),
    ign("lic_sagia", "ترخيص الهيئة العامة للاستثمار", "SAGIA licence"), ign("gcc_id", "الهوية الخليجية", "GCC ID"), ign("passport", "رقم جواز السفر", "Passport"), ign("other_id", "معرف آخر", "Other ID"),
    extra(col("segment", false, "الفئة", "Segment", ["فئة العميل", "نوع العميل"], "مقهى", "جملة · تجزئة · مقهى · موزع · أخرى")),
    extra(col("payment_terms_days", false, "شروط الدفع (يوم)", "Payment terms (days)", ["مدة السداد", "شروط الدفع"], "30", "من 0 إلى 365")),
    extra(col("credit_limit", false, "حد الائتمان", "Credit limit", ["الحد الائتماني"], "5000")),
    extra(col("city", false, "المدينة", "City", [], "الرياض")),
  ],
  // Qoyod «الموردون» export, column for column.
  suppliers: [
    col("name", true, "اسم الجهة", "Name", ["الاسم", "اسم المورد", "المورد", "supplier", "supplier name", "name"], "شركة البن العالمية", "يُطابَق عليه رصيد المورد الافتتاحي لاحقًا"),
    col("ref", false, "الرقم المرجعي", "Reference", ["المرجع", "reference"], "VND001", "رقم المورد في قيود (يظهر في المعاينة، لا يُحفظ)"),
    ign("legal_name", "اسم المنشأة", "Company name"), ign("website", "الموقع الالكتروني", "Website"),
    col("phone", false, "رقم الاتصال الأساسي", "Phone", ["الجوال", "رقم الجوال", "الهاتف", "mobile", "phone"], "0501234567", undefined, true),
    col("phone2", false, "رقم الاتصال الثانوي", "Secondary phone", [], "", undefined, true),
    col("email", false, "البريد الإلكتروني الأساسي", "Email", ["البريد الإلكتروني", "البريد", "email"], "sales@example.com"),
    ign("email2", "البريد الإلكتروني الثانوي", "Secondary email"),
    col("status", false, "الحالة", "Status", ["status"], "Active", "Active / Inactive"),
    col("vat_number", false, "الرقم الضريبي", "VAT number", ["رقم التسجيل الضريبي", "vat", "tax number"], "300000000000003", "15 رقمًا يبدأ وينتهي بـ 3", true),
    ign("pos", "عميل نقاط بيع", "POS customer"),
    col("address", false, "عنوان الفوترة", "Billing address", ["العنوان", "address"], ""),
    ign("ship_address", "عنوان الشحن", "Shipping address"),
    col("balance", false, "الرصيد (ر.س)", "Balance (SAR)", ["الرصيد", "الرصيد الختامي (ر.س)", "balance"], "0", "للعلم فقط: يدخل لاحقًا في الأرصدة الافتتاحية"),
    extra(col("payment_terms_days", false, "شروط الدفع (يوم)", "Payment terms (days)", ["مدة السداد", "شروط الدفع"], "30", "من 0 إلى 365")),
    extra(col("kind", false, "نوع المورد", "Supplier kind", [], "بضائع وخدمات", "بضائع وخدمات · جمارك · مخلص جمركي")),
    extra(col("non_resident", false, "غير مقيم", "Non-resident", ["مورد خارجي"], "لا", "نعم / لا")),
  ],
  // Qoyod «المنتجات» export (CSV), column for column; then our three optional columns.
  products: [
    col("serial", true, "الرقم التسلسلي", "Serial", ["الرمز", "رمز الصنف", "sku", "code"], "20029", "رمز الصنف في قيود: يصبح رمزه في النظام", true),
    col("name", true, "الاسم", "Name", ["اسم الصنف", "name"], "اندونسيا وانوجا محصول اخضر"),
    col("name_en", false, "الاسم الانجليزي", "English name", ["الاسم بالإنجليزية", "name en"], "Indonesia Wanoja green"),
    col("description", false, "الوصف", "Description", ["description"], ""),
    col("type", true, "النوع", "Type", ["type"], "مادة أولية", "مادة أولية · منتج · منتج مجمع · مصروف · خدمة"),
    col("barcode", false, "الباركود", "Barcode", ["barcode"], "", undefined, true),
    col("category", false, "صنف المنتج", "Product category", ["التصنيف", "category"], "بن القهوة الخضراء"),
    ign("buyable", "يُشتَرى", "Purchasable"),
    col("buy_price", false, "سعر الشراء", "Purchase price", ["التكلفة", "cost"], "0.062", "تكلفة الوحدة بوحدة قيود (البن الأخضر: للغرام)"),
    ign("sellable", "يُبَاع", "Sellable"),
    col("sell_price", false, "سعر البيع", "Selling price", ["السعر", "price"], "85"),
    col("quantity", false, "الكمية", "Quantity", ["الرصيد", "quantity", "qty"], "713608.77", "الكمية في تاريخ القطع بوحدة قيود"),
    col("stocked", false, "مخزون؟", "Stocked?", [], "نعم"),
    ign("pos", "منتج نقاط بيع", "POS product"),
    extra(col("unit", false, "الوحدة", "Unit", ["وحدة القياس", "uom"], "غرام", "وحدة الكمية في قيود: حبة · غرام · كيلو · مل · لتر (للمواد بكمية غير الأكياس والاستيكرات والأكواب)")),
    extra(col("location", false, "الموقع", "Location", ["المستودع", "warehouse"], "RST", "رمز الموقع: RST المصنع، WH المستودع، CAFE المقهى")),
    extra(col("weight_grams", false, "الوزن (غرام)", "Weight (g)", ["الوزن"], "250", "وزن العبوة للبيع إن لم يكن في اسمها")),
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
