// «استيراد البيانات من Excel» — the check and the import. previewImport reads the whole file against the database and
// reports every row (new · already there · error with the reason, per column); commitImport runs the SAME check inside
// one transaction and writes only when no row is in error — all or nothing. A record already in the system (a customer
// or supplier by name, a lot / item / SKU by its code) is skipped, never updated: the same file again adds nothing.
//
// Opening stock (green coffee in kg, materials in their unit) is received exactly as the item forms receive it
// (POST /api/green-beans, POST /api/materials): an OPENING_BALANCE IN movement at the named site and the zero-cost
// receipt of the cost ledger (onOpeningStock); a unit cost from the file goes to the opening inventory valuation
// (InventoryOpeningCost — «تقييم المخزون › الافتتاحي» costs and applies it). Both are refused once the opening
// balances are posted: stock after go-live comes in on a purchase invoice.
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { setAuditContext, type AuditContext } from "@/lib/accounting/audit";
import { onOpeningStock } from "@/lib/accounting/ops/inventory-events";
import { parseAccountFields } from "@/lib/services/customers/fields";
import { greenLotFields, sackFields } from "@/lib/services/green-lots";
import { auditInventoryReceipt } from "@/lib/services/inventory-receiving";
import { audit } from "@/lib/hr/core";
import { parseStockQuantity } from "@/lib/services/stock-quantity";
import { defaultLocationId, setStockLocation } from "@/lib/services/stock-locations";
import { isTransitLocation } from "@/lib/inventory/locations";
import { MATERIAL_TEMPLATES, defaultCategoryOf } from "@/lib/inventory/item-categories";
import {
  COLUMNS, IMPORT_MAX_ROWS, PRODUCT_CATEGORY_WORDS, SEGMENT_WORDS, SUPPLIER_KIND_WORDS, UNIT_WORDS,
  decimalText, latinDigits, matchHeader, nameKey, num, phoneText, word, yesNo, type ImportEntity,
} from "./spec";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

const IMPORT_TX = { timeout: 280_000, maxWait: 15_000 } as const;

export type Issue = { row: number; column: string | null; en: string; ar: string };
export type RowStatus = "NEW" | "EXISTS" | "ERROR";
export type PreviewRow = { row: number; code: string; name: string; status: RowStatus; stock: string | null; issues: Issue[] };
export type Preview = {
  entity: ImportEntity; checksum: string; headerRow: number; ok: boolean; openingPosted: boolean;
  rows: PreviewRow[]; fileIssues: Issue[]; warnings: Issue[];
  counts: { rows: number; new: number; exists: number; errors: number; withStock: number };
};
export type Actor = { id: string; name?: string | null; sessionId?: string };

const issue = (row: number, column: string | null, en: string, ar: string): Issue => ({ row, column, en, ar });
const colAr = (entity: ImportEntity, key: string) => COLUMNS[entity].find((c) => c.key === key)?.ar ?? key;

// ── The plan: what a clean file creates ─────────────────────────────────────────────────────────────────────────────
type StockIn = { qty: number; locationId: string | null; unitCost: string | null };
type Plan =
  | { entity: "customers"; rows: Prisma.CustomerCreateManyInput[] }
  | { entity: "suppliers"; rows: Prisma.SupplierCreateManyInput[] }
  | { entity: "green"; rows: { data: ReturnType<typeof greenLotFields>; stock: StockIn | null }[] }
  | { entity: "materials"; rows: { data: Omit<Prisma.MaterialItemUncheckedCreateInput, "quantityOnHand">; stock: StockIn | null }[] }
  | { entity: "products"; rows: { productId: string | null; product: Prisma.CoffeeProductCreateInput; skus: Omit<Prisma.ProductSKUCreateManyInput, "productId">[] }[] };

/** The sha256 of the uploaded bytes (the audit row names the file by it). */
export const fileChecksum = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** The header row: the first of the first ten rows that carries every required column, else the first non-empty row. */
function findHeader(entity: ImportEntity, table: string[][]) {
  for (let i = 0; i < Math.min(10, table.length); i++) if (table[i].some((c) => c) && matchHeader(entity, table[i]).missing.length === 0) return i;
  return Math.max(0, table.findIndex((r) => r.some((c) => c)));
}

type Ctx = {
  entity: ImportEntity; rows: { row: number; v: Record<string, string> }[]; issues: Issue[]; warnings: Issue[];
  preview: PreviewRow[]; openingPosted: boolean;
  locations: { id: string; code: string; nameAr: string; nameEn: string | null; isActive: boolean; type: string }[];
};

/** Read the table and check every row; returns the preview and, when clean, the plan. */
async function analyse(db: Db, entity: ImportEntity, table: string[][], checksum: string): Promise<{ preview: Preview; plan: Plan | null }> {
  const fileIssues: Issue[] = [];
  const warnings: Issue[] = [];
  const st = await db.accountingSettings.findUnique({ where: { id: "singleton" }, select: { openingEntryId: true } });
  const openingPosted = !!st?.openingEntryId;

  const h = findHeader(entity, table);
  const header = table[h] ?? [];
  const m = matchHeader(entity, header);
  for (const c of m.missing) fileIssues.push(issue(0, c.key, `The required column «${c.en}» is missing.`, `العمود المطلوب «${c.ar}» غير موجود في الملف.`));
  if (m.unknown.length) warnings.push(issue(0, null, `Column(s) not imported (unknown): ${m.unknown.join(", ")}.`, `أعمدة لن تُستورد (غير معروفة): ${m.unknown.join("، ")}.`));
  if (m.repeated.length) warnings.push(issue(0, null, `Column(s) given twice, the first one is used: ${m.repeated.join(", ")}.`, `أعمدة مكررة، يُعتمد أولها: ${m.repeated.join("، ")}.`));

  const rows: Ctx["rows"] = [];
  for (let i = h + 1; i < table.length; i++) {
    const r = table[i];
    if (!r.some((c) => c.trim())) continue;
    const v: Record<string, string> = {};
    m.keys.forEach((k, j) => { if (k) v[k] = (r[j] ?? "").trim(); });
    rows.push({ row: i + 1, v });
  }
  if (!rows.length && !m.missing.length) fileIssues.push(issue(0, null, "The file has no data rows under the header.", "لا توجد صفوف بيانات تحت صف العناوين."));
  if (rows.length > IMPORT_MAX_ROWS) fileIssues.push(issue(0, null, `At most ${IMPORT_MAX_ROWS} rows per file: split the file.`, `الحد ${IMPORT_MAX_ROWS} صف للملف الواحد: قسّم الملف.`));

  const ctx: Ctx = {
    entity, rows: m.missing.length || rows.length > IMPORT_MAX_ROWS ? [] : rows, issues: [], warnings, preview: [], openingPosted,
    locations: await db.stockLocation.findMany({ select: { id: true, code: true, nameAr: true, nameEn: true, isActive: true, type: true } }),
  };
  const plan = await PLANNERS[entity](db, ctx);

  const counts = {
    rows: ctx.preview.length,
    new: ctx.preview.filter((r) => r.status === "NEW").length,
    exists: ctx.preview.filter((r) => r.status === "EXISTS").length,
    errors: ctx.preview.filter((r) => r.status === "ERROR").length,
    withStock: ctx.preview.filter((r) => r.status === "NEW" && r.stock).length,
  };
  const ok = fileIssues.length === 0 && counts.errors === 0 && counts.rows > 0;
  return {
    preview: { entity, checksum, headerRow: h + 1, ok, openingPosted, rows: ctx.preview, fileIssues, warnings, counts },
    plan: ok ? plan : null,
  };
}

// ── Shared cell rules ───────────────────────────────────────────────────────────────────────────────────────────────
function rowChecker(ctx: Ctx, row: number) {
  const list: Issue[] = [];
  const bad = (column: string, en: string, ar: string) => { list.push(issue(row, column, en, `«${colAr(ctx.entity, column)}»: ${ar}`)); };
  const text = (v: Record<string, string>, k: string, max: number): string | null => {
    const t = (v[k] ?? "").trim();
    if (!t) return null;
    if (t.length > max) { bad(k, `longer than ${max} characters.`, `أطول من ${max} حرفًا.`); return null; }
    return t;
  };
  return { list, bad, text };
}

/** The site of a stock row: by code, Arabic or English name; refused when unknown, inactive or the transit site. */
function location(ctx: Ctx, v: string, bad: (c: string, en: string, ar: string) => void): string | null | undefined {
  const t = nameKey(v);
  if (!t) return null;
  const l = ctx.locations.find((x) => x.code.toLowerCase() === t || nameKey(x.nameAr) === t || (x.nameEn && nameKey(x.nameEn) === t));
  if (!l) { bad("location", `unknown location «${v}».`, `موقع غير معروف «${v}».`); return undefined; }
  if (isTransitLocation(l)) { bad("location", "stock is not received into «In transit».", "لا يُستلم مخزون في «في الطريق»."); return undefined; }
  if (!l.isActive) { bad("location", `the location «${v}» is inactive.`, `الموقع «${v}» غير نشط.`); return undefined; }
  return l.id;
}

/** Opening quantity, unit cost and site of a stock row (green: kg; material: its unit). */
function stockOf(ctx: Ctx, v: Record<string, string>, qtyKey: string, unit: string | undefined, bad: (c: string, en: string, ar: string) => void, row: number): StockIn | null {
  const rawQty = latinDigits(v[qtyKey] ?? "").replace(/[,\s]/g, "");
  const rawCost = v.unit_cost ?? "";
  let qty = 0;
  if (rawQty) {
    const q = parseStockQuantity(rawQty, { allowZero: true, unitOfMeasure: unit });
    if (!q.ok) bad(qtyKey, `the quantity ${q.message}.`, `الكمية غير صالحة (رقم موجب، 4 منازل عشرية على الأكثر، وعدد صحيح للحبة والوحدة).`);
    else qty = q.value;
  }
  const cost = decimalText(rawCost, 6);
  if (cost === "BAD") bad("unit_cost", "the unit cost is an amount with at most 6 decimals.", "التكلفة مبلغ موجب بست منازل عشرية على الأكثر.");
  const site = location(ctx, v.location ?? "", bad);
  if (qty > 0 && ctx.openingPosted) bad(qtyKey, "the opening balances are posted: stock now comes in on a purchase invoice.", "رُحّلت الأرصدة الافتتاحية: المخزون يدخل الآن بفاتورة شراء لا بالاستيراد.");
  if (qty === 0 && cost && cost !== "BAD") ctx.warnings.push(issue(row, "unit_cost", "A cost without a quantity is not used.", `«${colAr(ctx.entity, "unit_cost")}» بلا كمية: لن تُستخدم.`));
  if (qty === 0) return null;
  return { qty, locationId: site ?? null, unitCost: cost && cost !== "BAD" ? cost : null };
}

const stockLabel = (s: StockIn | null, unit: string, ctx: Ctx) => {
  if (!s) return null;
  const site = s.locationId ? ctx.locations.find((l) => l.id === s.locationId)?.code ?? "" : "";
  return `${s.qty} ${unit}${site ? ` @ ${site}` : ""}${s.unitCost ? ` × ${s.unitCost}` : ""}`;
};

function push(ctx: Ctx, row: number, code: string, name: string, status: RowStatus, issues: Issue[], stock: string | null = null) {
  ctx.preview.push({ row, code, name, status: issues.length ? "ERROR" : status, stock, issues });
}

// ── Per entity ──────────────────────────────────────────────────────────────────────────────────────────────────────
const PLANNERS: Record<ImportEntity, (db: Db, ctx: Ctx) => Promise<Plan>> = {
  async customers(db, ctx) {
    const existing = new Set((await db.customer.findMany({ select: { name: true } })).map((c) => nameKey(c.name)));
    const seen = new Map<string, number>();
    const out: Prisma.CustomerCreateManyInput[] = [];
    for (const { row, v } of ctx.rows) {
      const { list, bad, text } = rowChecker(ctx, row);
      const name = text(v, "name", 200);
      if (!name) bad("name", "required.", "مطلوب.");
      const key = name ? nameKey(name) : "";
      if (key && seen.has(key)) bad("name", `repeats row ${seen.get(key)} (names must be unique: opening balances match by name).`, `مكرر في الصف ${seen.get(key)} (الاسم فريد: تُطابَق عليه الأرصدة الافتتاحية).`);
      if (key && !seen.has(key)) seen.set(key, row);
      const email = text(v, "email", 200);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad("email", "not an e-mail address.", "بريد إلكتروني غير صالح.");
      const acct: Record<string, unknown> = {};
      if (v.vat_number) acct.vatNumber = v.vat_number;
      if (v.commercial_reg_no) acct.commercialRegNo = v.commercial_reg_no;
      if (v.city) acct.city = v.city;
      if (v.payment_terms_days) acct.paymentTermsDays = latinDigits(v.payment_terms_days);
      if (v.credit_limit) acct.creditLimit = v.credit_limit;
      if (v.segment) {
        const s = word(SEGMENT_WORDS, v.segment);
        if (s) acct.segment = s; else bad("segment", "use wholesale, retail, cafe, distributor or other.", "استخدم: جملة، تجزئة، مقهى، موزع، أخرى.");
      }
      const parsed = parseAccountFields(acct);
      if (!parsed.ok) list.push(issue(row, null, parsed.error, parsed.errorAr));
      const exists = !!key && existing.has(key);
      push(ctx, row, "", name ?? "", exists ? "EXISTS" : "NEW", list);
      if (!list.length && !exists && name) {
        out.push({
          name, nameAr: text(v, "name_ar", 200), phone: phoneText(v.phone ?? "")?.slice(0, 40) ?? null, email, address: text(v, "address", 500),
          ...(parsed.ok ? { ...parsed.data, creditLimit: parsed.data.creditLimit?.toFixed(2) ?? null } : {}),
        });
      }
    }
    return { entity: "customers", rows: out };
  },

  async suppliers(db, ctx) {
    const existing = new Set((await db.supplier.findMany({ select: { name: true } })).map((s) => nameKey(s.name)));
    const seen = new Map<string, number>();
    const out: Prisma.SupplierCreateManyInput[] = [];
    for (const { row, v } of ctx.rows) {
      const { list, bad, text } = rowChecker(ctx, row);
      const name = text(v, "name", 200);
      if (!name) bad("name", "required.", "مطلوب.");
      const key = name ? nameKey(name) : "";
      if (key && seen.has(key)) bad("name", `repeats row ${seen.get(key)}.`, `مكرر في الصف ${seen.get(key)}.`);
      if (key && !seen.has(key)) seen.set(key, row);
      const nonResident = v.non_resident ? yesNo(v.non_resident) : false;
      if (nonResident === null) bad("non_resident", "use yes or no.", "اكتب نعم أو لا.");
      let vat: string | null = null;
      if (v.vat_number) {
        if (nonResident) vat = text(v, "vat_number", 40);
        else {
          const p = parseAccountFields({ vatNumber: v.vat_number });
          if (p.ok) vat = p.data.vatNumber ?? null; else bad("vat_number", p.error, "15 رقمًا يبدأ وينتهي بـ 3.");
        }
      }
      let terms: number | null = null;
      if (v.payment_terms_days) {
        const n = num(v.payment_terms_days);
        if (n === null || !Number.isInteger(n) || n < 0 || n > 365) bad("payment_terms_days", "whole days, 0 to 365.", "أيام صحيحة من 0 إلى 365.");
        else terms = n;
      }
      const kind = word(SUPPLIER_KIND_WORDS, v.kind ?? "");
      if (kind === undefined) bad("kind", "use goods/services, customs or clearing agent.", "استخدم: بضائع وخدمات، جمارك، مخلص جمركي.");
      const email = text(v, "email", 200);
      const contact = [text(v, "contact", 120), phoneText(v.phone ?? ""), email].filter(Boolean).join(" · ") || null;
      const exists = !!key && existing.has(key);
      push(ctx, row, "", name ?? "", exists ? "EXISTS" : "NEW", list);
      if (!list.length && !exists && name) out.push({ name, contact, vatNumber: vat, paymentTermsDays: terms, isNonResident: nonResident === true, kind: kind ?? "GOODS_SERVICES" });
    }
    return { entity: "suppliers", rows: out };
  },

  async green(db, ctx) {
    const existing = new Set((await db.greenBean.findMany({ select: { serialNumber: true } })).map((g) => g.serialNumber.toLowerCase()));
    const seen = new Map<string, number>();
    const out: Extract<Plan, { entity: "green" }>["rows"] = [];
    for (const { row, v } of ctx.rows) {
      const { list, bad, text } = rowChecker(ctx, row);
      const serial = text(v, "serial_number", 60);
      if (!serial) bad("serial_number", "required.", "مطلوب.");
      const key = serial?.toLowerCase() ?? "";
      if (key && seen.has(key)) bad("serial_number", `repeats row ${seen.get(key)}.`, `مكرر في الصف ${seen.get(key)}.`);
      if (key && !seen.has(key)) seen.set(key, row);
      const nameEn = text(v, "name_en", 120), nameAr = text(v, "name_ar", 120);
      if (!nameEn && !nameAr) bad("name_ar", "a name is required (Arabic or English).", "اسم مطلوب (عربي أو إنجليزي).");
      const sacks = sackFields({ sackCount: v.sack_count ?? "", sackWeightKg: v.sack_weight_kg ?? "" });
      if ("error" in sacks) bad("sack_count", sacks.errorEn, sacks.error);
      const stock = stockOf(ctx, v, "quantity_kg", "KG", bad, row);
      const exists = !!key && existing.has(key);
      push(ctx, row, serial ?? "", nameAr ?? nameEn ?? "", exists ? "EXISTS" : "NEW", list, stockLabel(stock, "kg", ctx));
      if (!list.length && !exists && serial) {
        out.push({
          data: greenLotFields({
            serialNumber: serial, beanType: nameEn ?? nameAr, beanTypeAr: nameAr, country: text(v, "country", 80) ?? "Unknown", countryAr: text(v, "country_ar", 80),
            region: text(v, "region", 120), variety: text(v, "variety", 120), process: text(v, "process", 120), altitude: text(v, "altitude", 60),
            sackCount: v.sack_count ?? "", sackWeightKg: v.sack_weight_kg ?? "",
          }),
          stock,
        });
      }
    }
    return { entity: "green", rows: out };
  },

  async materials(db, ctx) {
    const existing = new Set((await db.materialItem.findMany({ select: { code: true } })).map((m) => m.code.toLowerCase()));
    const cats = await db.itemCategory.findMany({ select: { id: true, nameAr: true, nameEn: true, template: true, legacyMaterialCategory: true, isActive: true, defaultUnit: true } });
    const isMaterialCat = (c: (typeof cats)[number]) => (MATERIAL_TEMPLATES as readonly string[]).includes(c.template) && !!c.legacyMaterialCategory && c.isActive;
    const fallback = cats.find((c) => c.id === defaultCategoryOf("PACKAGING"));
    const seen = new Map<string, number>();
    const out: Extract<Plan, { entity: "materials" }>["rows"] = [];
    for (const { row, v } of ctx.rows) {
      const { list, bad, text } = rowChecker(ctx, row);
      const code = text(v, "code", 60);
      if (!code) bad("code", "required.", "مطلوب.");
      const key = code?.toLowerCase() ?? "";
      if (key && seen.has(key)) bad("code", `repeats row ${seen.get(key)}.`, `مكرر في الصف ${seen.get(key)}.`);
      if (key && !seen.has(key)) seen.set(key, row);
      const name = text(v, "name", 200);
      if (!name) bad("name", "required.", "مطلوب.");
      let cat = fallback;
      if (v.category) {
        const t = nameKey(v.category);
        const found = cats.find((c) => c.id === v.category || nameKey(c.nameAr) === t || (c.nameEn && nameKey(c.nameEn) === t));
        if (!found) bad("category", `unknown category «${v.category}».`, `تصنيف غير معروف «${v.category}».`);
        else if (!isMaterialCat(found)) bad("category", "items are not added to that category (or it is archived).", "لا تُضاف أصناف إلى هذا التصنيف (أو هو مؤرشف).");
        else cat = found;
      }
      if (!cat) bad("category", "no category to put the item in.", "لا يوجد تصنيف لإضافة الصنف.");
      const unitWord = word(UNIT_WORDS, v.unit ?? "");
      if (unitWord === undefined) bad("unit", "use piece, unit, kg, gram or litre.", "استخدم: حبة، وحدة، كيلو، غرام، لتر.");
      const catUnit = Object.values(UNIT_WORDS).find((u) => u === cat?.defaultUnit);
      const unit = unitWord ?? catUnit ?? "PIECE";
      let reorder = 0;
      if (v.reorder_point) {
        const n = num(v.reorder_point);
        if (n === null || !Number.isFinite(n) || n < 0) bad("reorder_point", "zero or more.", "صفر أو أكثر.");
        else reorder = n;
      }
      const stock = stockOf(ctx, v, "quantity", unit, bad, row);
      const exists = !!key && existing.has(key);
      push(ctx, row, code ?? "", name ?? "", exists ? "EXISTS" : "NEW", list, stockLabel(stock, unit.toLowerCase(), ctx));
      if (!list.length && !exists && code && name && cat) {
        out.push({
          data: {
            code, name, nameAr: text(v, "name_ar", 200), categoryId: cat.id, category: cat.legacyMaterialCategory as "PACKAGING",
            unitOfMeasure: unit, reorderPoint: reorder, isActive: true, notes: text(v, "notes", 500),
          },
          stock,
        });
      }
    }
    return { entity: "materials", rows: out };
  },

  async products(db, ctx) {
    const products = await db.coffeeProduct.findMany({ select: { id: true, productNameEn: true } });
    const productByName = new Map(products.map((p) => [nameKey(p.productNameEn), p.id]));
    const skus = await db.productSKU.findMany({ select: { skuCode: true, barcode: true } });
    const existingSku = new Set(skus.map((s) => s.skuCode.toLowerCase()));
    const existingBarcode = new Set(skus.map((s) => s.barcode).filter(Boolean) as string[]);
    const seenSku = new Map<string, number>(), seenBarcode = new Map<string, number>();
    const groups = new Map<string, Extract<Plan, { entity: "products" }>["rows"][number]>();
    for (const { row, v } of ctx.rows) {
      const { list, bad, text } = rowChecker(ctx, row);
      const pName = text(v, "product_name_en", 200);
      if (!pName) bad("product_name_en", "required.", "مطلوب.");
      const country = text(v, "country_en", 80);
      if (!country) bad("country_en", "required.", "مطلوب.");
      const sku = text(v, "sku_code", 60);
      if (!sku) bad("sku_code", "required.", "مطلوب.");
      const sk = sku?.toLowerCase() ?? "";
      if (sk && seenSku.has(sk)) bad("sku_code", `repeats row ${seenSku.get(sk)}.`, `مكرر في الصف ${seenSku.get(sk)}.`);
      if (sk && !seenSku.has(sk)) seenSku.set(sk, row);
      const weight = num(v.weight_grams ?? "");
      if (weight === null || !Number.isFinite(weight) || weight <= 0) bad("weight_grams", "a weight in grams above zero.", "وزن بالغرام أكبر من صفر.");
      const price = decimalText(v.price ?? "", 2);
      if (price === "BAD") bad("price", "an amount with at most 2 decimals.", "مبلغ بمنزلتين عشريتين على الأكثر.");
      const loss = num(v.expected_roast_loss ?? "");
      if (loss !== null && (!Number.isFinite(loss) || loss < 0 || loss > 50)) bad("expected_roast_loss", "a percentage from 0 to 50.", "نسبة من 0 إلى 50.");
      const barcode = text(v, "barcode", 64);
      if (barcode && seenBarcode.has(barcode)) bad("barcode", `repeats row ${seenBarcode.get(barcode)}.`, `مكرر في الصف ${seenBarcode.get(barcode)}.`);
      if (barcode && !seenBarcode.has(barcode)) seenBarcode.set(barcode, row);
      const category = word(PRODUCT_CATEGORY_WORDS, v.category ?? "");
      if (category === undefined) bad("category", "use roasted coffee, green coffee, merchandise or other.", "استخدم: بن محمص، بن أخضر، منتجات، أخرى.");
      const unit = word(UNIT_WORDS, v.unit ?? "");
      if (unit === undefined) bad("unit", "use unit, piece, kg or gram.", "استخدم: وحدة، حبة، كيلو، غرام.");
      const exists = !!sk && existingSku.has(sk);
      if (!exists && barcode && existingBarcode.has(barcode)) bad("barcode", "already on another SKU.", "مستخدم لعبوة أخرى.");
      const pKey = pName ? nameKey(pName) : "";
      push(ctx, row, sku ?? "", [pName, text(v, "sku_name_ar", 200)].filter(Boolean).join(" · "), exists ? "EXISTS" : "NEW", list);
      if (list.length || exists || !pName || !country || !sku || weight === null) continue;
      let g = groups.get(pKey);
      if (!g) {
        g = {
          productId: productByName.get(pKey) ?? null,
          product: {
            productNameEn: pName, productNameAr: text(v, "product_name_ar", 200), countryEn: country, countryAr: text(v, "country_ar", 80),
            regionEn: text(v, "region", 120), varietyEn: text(v, "variety", 120), processEn: text(v, "process", 120), cupNotesAr: text(v, "cup_notes_ar", 500),
            ...(loss !== null ? { expectedRoastLoss: loss } : {}),
          },
          skus: [],
        };
        groups.set(pKey, g);
      }
      g.skus.push({ skuCode: sku, name: null, nameAr: text(v, "sku_name_ar", 200), weightGrams: weight, price: price && price !== "BAD" ? Number(price) : 0, barcode, category: category ?? "ROASTED_COFFEE", unitOfMeasure: unit ?? "UNIT" });
    }
    const reused = [...groups.values()].filter((g) => g.productId).length;
    if (reused) ctx.warnings.push(issue(0, null, `${reused} product(s) already exist by name: their new SKUs are added to them.`, `${reused} منتج موجود مسبقًا بالاسم: تُضاف عبواته الجديدة إليه.`));
    return { entity: "products", rows: [...groups.values()] };
  },
};

// ── Public ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function previewImport(entity: ImportEntity, table: string[][], checksum: string): Promise<Preview> {
  return (await analyse(prisma, entity, table, checksum)).preview;
}

export class ImportRefused extends Error {
  constructor(public preview: Preview) { super("The file has errors: nothing was imported."); }
}

/** All or nothing: the check again inside the transaction, then every NEW row written; refused (nothing written) on any error. */
export async function commitImport(entity: ImportEntity, table: string[][], meta: { checksum: string; fileName: string }, actor: Actor, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const { preview, plan } = await analyse(tx, entity, table, meta.checksum);
    if (!plan) throw new ImportRefused(preview);
    let created = 0, stockRows = 0, costs = 0;
    // The site goes on the transaction BEFORE the item is created: the balance trigger books the opening quantity there.
    const site = async (s: StockIn) => {
      const locationId = s.locationId ?? (await defaultLocationId(tx));
      await setStockLocation(tx, locationId);
      return locationId;
    };
    const receive = async (kind: "GREEN_BEAN" | "MATERIAL", id: string, s: StockIn, locationId: string) => {
      const movement = await tx.inventoryMovement.create({
        data: {
          type: "IN", category: kind === "GREEN_BEAN" ? "RAW_MATERIAL" : "PACKAGING_MATERIAL", referenceEntityId: id, quantityChanged: s.qty, previousQuantity: 0, newQuantity: s.qty,
          sourceDocType: "OPENING_BALANCE", sourceDocId: id, userId: actor.id, notes: "Opening balance (import)", locationId,
        },
      });
      if (kind === "MATERIAL") {
        await auditInventoryReceipt(tx, actor, { entityId: id, opening: true, movementId: movement.id, quantity: s.qty, previousQuantity: 0, newQuantity: s.qty, supplier: null, reference: meta.fileName.slice(0, 120), notes: "استيراد من Excel" });
      }
      await onOpeningStock(tx, { kind, entityId: id, qty: s.qty, actor: actor.id, movementId: movement.id });
      if (s.unitCost) {
        await tx.inventoryOpeningCost.upsert({
          where: { kind_entityId: { kind, entityId: id } },
          create: { kind, entityId: id, unitCost: s.unitCost, note: "استيراد من Excel", updatedBy: actor.id },
          update: { unitCost: s.unitCost, note: "استيراد من Excel", updatedBy: actor.id },
        });
        costs++;
      }
      stockRows++;
    };

    switch (plan.entity) {
      case "customers":
        created = (await tx.customer.createMany({ data: plan.rows })).count;
        break;
      case "suppliers":
        created = (await tx.supplier.createMany({ data: plan.rows })).count;
        break;
      case "green":
        for (const r of plan.rows) {
          const at = r.stock ? await site(r.stock) : null;
          const g = await tx.greenBean.create({ data: { ...r.data, quantityKg: r.stock?.qty ?? 0 } });
          if (r.stock && at) await receive("GREEN_BEAN", g.id, r.stock, at);
          created++;
        }
        break;
      case "materials":
        for (const r of plan.rows) {
          const at = r.stock ? await site(r.stock) : null;
          const mi = await tx.materialItem.create({ data: { ...r.data, quantityOnHand: r.stock?.qty ?? 0 } });
          if (r.stock && at) await receive("MATERIAL", mi.id, r.stock, at);
          created++;
        }
        break;
      case "products":
        for (const g of plan.rows) {
          const productId = g.productId ?? (await tx.coffeeProduct.create({ data: g.product, select: { id: true } })).id;
          created += (await tx.productSKU.createMany({ data: g.skus.map((s) => ({ ...s, productId })) })).count;
        }
        break;
    }

    // One append-only audit row per import (the receipts above carry their own); the settings log's actions are a fixed list.
    await audit(tx, {
      action: "DATA_IMPORTED", entityType: "DataImport", entityId: meta.checksum.slice(0, 32), actorId: actor.id,
      after: { entity, fileName: meta.fileName, rows: preview.counts.rows, created, skippedExisting: preview.counts.exists, openingStockRows: stockRows, openingCosts: costs },
      reason: `استيراد ${entity} من ${meta.fileName}`.slice(0, 300),
    });
    return { created, skipped: preview.counts.exists, stockRows, costs, preview };
  }, IMPORT_TX);
}

/** How many records of each kind the system holds now (the page's summary). */
export async function importCounts() {
  const [customers, suppliers, green, materials, products, skus] = await Promise.all([
    prisma.customer.count(), prisma.supplier.count(), prisma.greenBean.count(), prisma.materialItem.count(), prisma.coffeeProduct.count(), prisma.productSKU.count(),
  ]);
  return { customers, suppliers, green, materials, products: skus, productGroups: products };
}
