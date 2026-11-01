// «استيراد البيانات من Excel / قيود» — the check and the import of Qoyod's three exports (customers, suppliers, products;
// the formats are ./spec.ts, the product routing ./qoyod.ts). previewImport reads the whole file against the database and
// reports every row (new · already there · skipped · error with the reason, per column); commitImport runs the SAME
// check inside one transaction and writes only when no row is in error — all or nothing. A record already in the system
// (a customer or supplier by name, a lot / item / SKU by Qoyod's serial) is skipped, never updated: the same file again
// adds nothing.
//
// Opening stock (green coffee and materials) is received exactly as the item forms receive it (POST /api/green-beans,
// POST /api/materials): an OPENING_BALANCE IN movement at the site and the zero-cost receipt of the cost ledger
// (onOpeningStock); Qoyod's unit cost goes to the opening inventory valuation (InventoryOpeningCost — «تقييم المخزون ›
// الافتتاحي» costs and applies it). Qoyod's units are converted (green coffee grams → kg, millilitres → litres; the unit
// cost divided by the same factor). Both are refused once the opening balances are posted: stock after go-live comes
// in on a purchase invoice. Finished-goods quantities are reported, not imported (finished stock is born from roasting).
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { Decimal } from "@/lib/accounting/money";
import { setAuditContext, type AuditContext } from "@/lib/accounting/audit";
import { onOpeningStock } from "@/lib/accounting/ops/inventory-events";
import { parseAccountFields } from "@/lib/services/customers/fields";
import { greenLotFields } from "@/lib/services/green-lots";
import { auditInventoryReceipt } from "@/lib/services/inventory-receiving";
import { audit } from "@/lib/hr/core";
import { parseStockQuantity } from "@/lib/services/stock-quantity";
import { defaultLocationId, setStockLocation } from "@/lib/services/stock-locations";
import { isTransitLocation } from "@/lib/inventory/locations";
import { MATERIAL_TEMPLATES } from "@/lib/inventory/item-categories";
import {
  COLUMNS, GREEN_UNITS, IMPORT_MAX_ROWS, QOYOD_UNITS, SEGMENT_WORDS, SUPPLIER_KIND_WORDS,
  decimalText, latinDigits, matchHeader, nameKey, num, phoneText, word, yesNo, type GreenUnit, type ImportEntity,
} from "./spec";
import { countryFromName, countsInPieces, isCoffeeSalesCategory, materialCategoryFor, productNameOf, routeQoyodRow, weightFromName } from "./qoyod";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

const IMPORT_TX = { timeout: 280_000, maxWait: 15_000 } as const;

export type Issue = { row: number; column: string | null; en: string; ar: string };
export type RowStatus = "NEW" | "EXISTS" | "SKIPPED" | "ERROR";
/** `kind`: what the row becomes here (products); `balance`: Qoyod's balance (customers / suppliers, for reference). */
export type PreviewRow = { row: number; code: string; name: string; status: RowStatus; kind: string | null; stock: string | null; balance: string | null; note: string | null; issues: Issue[] };
export type Preview = {
  entity: ImportEntity; checksum: string; headerRow: number; ok: boolean; openingPosted: boolean;
  rows: PreviewRow[]; fileIssues: Issue[]; warnings: Issue[]; ignoredColumns: string[];
  counts: { rows: number; new: number; exists: number; skipped: number; errors: number; withStock: number };
  /** Σ Qoyod balances (customers / suppliers); Σ opening stock value at Qoyod's cost; finished-goods units not imported. */
  totals: { balance: string | null; stockValue: string | null; finishedUnitsNotImported: number };
};
export type Actor = { id: string; name?: string | null; sessionId?: string };
export type ImportOptions = { greenUnit?: GreenUnit };

const issue = (row: number, column: string | null, en: string, ar: string): Issue => ({ row, column, en, ar });
const colAr = (entity: ImportEntity, key: string) => COLUMNS[entity].find((c) => c.key === key)?.ar ?? key;

// ── The plan: what a clean file creates ─────────────────────────────────────────────────────────────────────────────
type StockIn = { qty: number; locationId: string | null; unitCost: string | null };
type GreenRow = { data: ReturnType<typeof greenLotFields>; stock: StockIn | null };
type MaterialRow = { data: Omit<Prisma.MaterialItemUncheckedCreateInput, "quantityOnHand">; stock: StockIn | null };
type ProductGroup = { productId: string | null; product: Prisma.CoffeeProductCreateInput; skus: Omit<Prisma.ProductSKUCreateManyInput, "productId">[] };
type Plan =
  | { entity: "customers"; rows: Prisma.CustomerCreateManyInput[] }
  | { entity: "suppliers"; rows: Prisma.SupplierCreateManyInput[] }
  | { entity: "products"; green: GreenRow[]; materials: MaterialRow[]; groups: ProductGroup[] };

/** The sha256 of the uploaded bytes (the audit row names the file by it). */
export const fileChecksum = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** The header row: the first of the first ten rows that carries every required column, else the first non-empty row. */
function findHeader(entity: ImportEntity, table: string[][]) {
  for (let i = 0; i < Math.min(10, table.length); i++) if (table[i].some((c) => c) && matchHeader(entity, table[i]).missing.length === 0) return i;
  return Math.max(0, table.findIndex((r) => r.some((c) => c)));
}

type Ctx = {
  entity: ImportEntity; rows: { row: number; v: Record<string, string> }[]; warnings: Issue[];
  preview: PreviewRow[]; openingPosted: boolean; options: Required<ImportOptions>;
  locations: { id: string; code: string; nameAr: string; nameEn: string | null; isActive: boolean; isDefault: boolean; type: string }[];
  balance: Decimal; stockValue: Decimal; finishedUnits: number;
};

/** Read the table and check every row; returns the preview and, when clean, the plan. */
async function analyse(db: Db, entity: ImportEntity, table: string[][], checksum: string, options: ImportOptions): Promise<{ preview: Preview; plan: Plan | null }> {
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
  const ignoredColumns = m.keys.flatMap((k, i) => (k && COLUMNS[entity].find((c) => c.key === k)?.ignore ? [header[i]] : []));

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
    entity, rows: m.missing.length || rows.length > IMPORT_MAX_ROWS ? [] : rows, warnings, preview: [], openingPosted,
    options: { greenUnit: options.greenUnit === "kg" ? "kg" : "g" },
    locations: await db.stockLocation.findMany({ select: { id: true, code: true, nameAr: true, nameEn: true, isActive: true, isDefault: true, type: true } }),
    balance: new Decimal(0), stockValue: new Decimal(0), finishedUnits: 0,
  };
  const plan = await PLANNERS[entity](db, ctx);

  const by = (s: RowStatus) => ctx.preview.filter((r) => r.status === s).length;
  const counts = { rows: ctx.preview.length, new: by("NEW"), exists: by("EXISTS"), skipped: by("SKIPPED"), errors: by("ERROR"), withStock: ctx.preview.filter((r) => r.status === "NEW" && r.stock).length };
  const ok = fileIssues.length === 0 && counts.errors === 0 && counts.rows > 0;
  return {
    preview: {
      entity, checksum, headerRow: h + 1, ok, openingPosted, rows: ctx.preview, fileIssues, warnings, ignoredColumns, counts,
      totals: {
        balance: entity === "products" ? null : ctx.balance.toFixed(2),
        stockValue: entity === "products" ? ctx.stockValue.toFixed(2) : null,
        finishedUnitsNotImported: Math.round(ctx.finishedUnits * 1000) / 1000,
      },
    },
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

/** A Qoyod balance cell (signed, any decimals; Qoyod's float residue is kept to the halala). */
function balanceOf(v: string): Decimal | null {
  const t = latinDigits(v ?? "").replace(/[,\s]/g, "");
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const d = new Decimal(t).toDecimalPlaces(2);
  return d.isZero() ? null : d;
}

/**
 * Opening quantity and unit cost of a stock row in the system's unit: Qoyod's quantity × `factor` (rounded to the 4
 * decimals a stock quantity carries), Qoyod's cost ÷ `factor` (6 decimals). Null when there is no stock.
 */
function stockOf(ctx: Ctx, v: Record<string, string>, unit: string, factor: number, site: string | null, bad: (c: string, en: string, ar: string) => void, row: number): StockIn | null {
  const rawQty = latinDigits(v.quantity ?? "").replace(/[,\s]/g, "");
  if (!rawQty || Number(rawQty) === 0) return null;
  if (!/^\d+(\.\d+)?$/.test(rawQty)) { bad("quantity", "a quantity of zero or more.", "كمية صفر أو أكثر."); return null; }
  const converted = new Decimal(rawQty).times(factor).toDecimalPlaces(unit === "PIECE" || unit === "UNIT" ? 0 : 4);
  const q = parseStockQuantity(converted.toString(), { allowZero: true, unitOfMeasure: unit });
  if (!q.ok) { bad("quantity", `the quantity ${q.message}.`, "الكمية غير صالحة بعد التحويل (عدد صحيح للحبة، وحتى مليون)."); return null; }
  if (q.value === 0) return null;
  if (ctx.openingPosted) bad("quantity", "the opening balances are posted: stock now comes in on a purchase invoice.", "رُحّلت الأرصدة الافتتاحية: المخزون يدخل الآن بفاتورة شراء لا بالاستيراد.");
  const cost = decimalText(v.buy_price ?? "", 12);
  if (cost === "BAD") { bad("buy_price", "the cost is a positive amount.", "التكلفة مبلغ موجب."); return null; }
  let unitCost: string | null = null;
  if (cost) {
    unitCost = new Decimal(cost).div(factor).toDecimalPlaces(6).toString();
    ctx.stockValue = ctx.stockValue.plus(new Decimal(unitCost).times(q.value));
  } else ctx.warnings.push(issue(row, "buy_price", "Stock without a cost: cost it in the opening valuation.", "رصيد بلا تكلفة: تُدخل تكلفته في «تقييم المخزون › الافتتاحي»."));
  return { qty: q.value, locationId: site, unitCost };
}

const UNIT_AR: Record<string, string> = { KG: "كغ", GRAM: "غ", PIECE: "حبة", UNIT: "وحدة", LITER: "لتر" };
const stockLabel = (s: StockIn | null, unit: string, ctx: Ctx) => {
  if (!s) return null;
  const site = s.locationId ? ctx.locations.find((l) => l.id === s.locationId)?.code ?? "" : ctx.locations.find((l) => l.isDefault)?.code ?? "";
  return `${s.qty} ${UNIT_AR[unit] ?? unit}${site ? ` · ${site}` : ""}${s.unitCost ? ` × ${s.unitCost}` : ""}`;
};

function push(ctx: Ctx, r: Omit<PreviewRow, "status" | "kind" | "stock" | "balance" | "note"> & Partial<PreviewRow> & { status: RowStatus }) {
  ctx.preview.push({ kind: null, stock: null, balance: null, note: null, ...r, status: r.issues.length ? "ERROR" : r.status });
}

// ── Customers / suppliers (Qoyod «العملاء» / «الموردون») ────────────────────────────────────────────────────────────
/** A name seen before in the file is one party: skipped (Qoyod held it twice), its balance added to the first row's. */
function partyRow(ctx: Ctx, row: number, v: Record<string, string>, existing: Set<string>, seen: Map<string, number>, list: Issue[], name: string | null) {
  const key = name ? nameKey(name) : "";
  const bal = balanceOf(v.balance ?? "");
  if (bal) ctx.balance = ctx.balance.plus(bal);
  const notes: string[] = [];
  if ((v.status ?? "").trim() && !/^active$/i.test(v.status.trim())) notes.push("غير نشط في قيود");
  if (key && seen.has(key)) {
    push(ctx, { row, code: v.ref ?? "", name: name ?? "", status: "SKIPPED", balance: bal?.toFixed(2) ?? null, note: `مكرر: الاسم نفسه في الصف ${seen.get(key)}، يُستورد مرة واحدة${bal ? " ويُجمع رصيده معه" : ""}`, issues: list });
    return { create: false };
  }
  if (key) seen.set(key, row);
  const exists = !!key && existing.has(key);
  push(ctx, { row, code: v.ref ?? "", name: name ?? "", status: exists ? "EXISTS" : "NEW", balance: bal?.toFixed(2) ?? null, note: notes.join(" · ") || null, issues: list });
  return { create: !list.length && !exists && !!name };
}

const PLANNERS: Record<ImportEntity, (db: Db, ctx: Ctx) => Promise<Plan>> = {
  async customers(db, ctx) {
    const existing = new Set((await db.customer.findMany({ select: { name: true } })).map((c) => nameKey(c.name)));
    const seen = new Map<string, number>();
    const out: Prisma.CustomerCreateManyInput[] = [];
    for (const { row, v } of ctx.rows) {
      const { list, bad, text } = rowChecker(ctx, row);
      const name = text(v, "name", 200);
      if (!name) bad("name", "required.", "مطلوب.");
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
      if (partyRow(ctx, row, v, existing, seen, list, name).create && name) {
        out.push({
          name, phone: phoneText(v.phone ?? "")?.slice(0, 40) ?? null, email, address: text(v, "address", 500) ?? text(v, "ship_address", 500),
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
      const contact = [phoneText(v.phone ?? ""), phoneText(v.phone2 ?? ""), email, text(v, "address", 200)].filter(Boolean).join(" · ").slice(0, 500) || null;
      if (partyRow(ctx, row, v, existing, seen, list, name).create && name) {
        out.push({ name, contact, vatNumber: vat, paymentTermsDays: terms, isNonResident: nonResident === true, kind: kind ?? "GOODS_SERVICES" });
      }
    }
    return { entity: "suppliers", rows: out };
  },

  // ── Products (Qoyod «المنتجات»): each row routed to green coffee, a material or a sellable SKU ─────────────────────
  async products(db, ctx) {
    const [greens, mats, skus, products, cats] = await Promise.all([
      db.greenBean.findMany({ select: { serialNumber: true } }),
      db.materialItem.findMany({ select: { code: true } }),
      db.productSKU.findMany({ select: { skuCode: true, barcode: true } }),
      db.coffeeProduct.findMany({ select: { id: true, productNameEn: true } }),
      db.itemCategory.findMany({ select: { id: true, nameAr: true, nameEn: true, template: true, legacyMaterialCategory: true, isActive: true, defaultUnit: true } }),
    ]);
    const existingGreen = new Set(greens.map((g) => g.serialNumber.toLowerCase()));
    const existingMat = new Set(mats.map((m) => m.code.toLowerCase()));
    const existingSku = new Set(skus.map((s) => s.skuCode.toLowerCase()));
    const existingBarcode = new Set(skus.map((s) => s.barcode).filter(Boolean) as string[]);
    const productByName = new Map(products.map((p) => [nameKey(p.productNameEn), p.id]));
    const isMaterialCat = (c: (typeof cats)[number]) => (MATERIAL_TEMPLATES as readonly string[]).includes(c.template) && !!c.legacyMaterialCategory && c.isActive;
    const cafeSite = ctx.locations.find((l) => l.type === "CAFE" && l.isActive)?.id ?? null;
    const greenFactor = GREEN_UNITS[ctx.options.greenUnit];
    const seenSerial = new Map<string, number>(), seenBarcode = new Map<string, number>();
    const green: GreenRow[] = [], materials: MaterialRow[] = [];
    const groups = new Map<string, ProductGroup>();
    const greenCostOff: number[] = [];

    for (const { row, v } of ctx.rows) {
      const { list, bad, text } = rowChecker(ctx, row);
      const serial = text(v, "serial", 60);
      const name = text(v, "name", 200);
      if (!serial) bad("serial", "required.", "مطلوب.");
      if (!name) bad("name", "required.", "مطلوب.");
      const sk = serial?.toLowerCase() ?? "";
      if (sk && seenSerial.has(sk)) bad("serial", `repeats row ${seenSerial.get(sk)}.`, `مكرر في الصف ${seenSerial.get(sk)}.`);
      if (sk && !seenSerial.has(sk)) seenSerial.set(sk, row);
      const category = v.category ?? "";
      const route = routeQoyodRow(v.type ?? "", category, name ?? "");
      const base = { row, code: serial ?? "", name: name ?? "" };

      if (route.kind === "SKIP") { push(ctx, { ...base, status: "SKIPPED", kind: "يُتخطّى", note: route.reason?.ar ?? null, issues: list }); continue; }
      const siteAsked = location(ctx, v.location ?? "", bad);

      if (route.kind === "GREEN") {
        const stock = stockOf(ctx, v, "KG", greenFactor, siteAsked ?? null, bad, row);
        if (stock?.unitCost && (Number(stock.unitCost) < 5 || Number(stock.unitCost) > 1000)) greenCostOff.push(row);
        const exists = existingGreen.has(sk);
        const country = countryFromName(name ?? "") ?? countryFromName(v.name_en ?? "");
        push(ctx, { ...base, status: exists ? "EXISTS" : "NEW", kind: "بن أخضر", stock: stockLabel(stock, "KG", ctx), issues: list });
        if (!list.length && !exists && serial && name) {
          green.push({ data: greenLotFields({ serialNumber: serial, beanType: v.name_en && v.name_en !== name ? v.name_en : name, beanTypeAr: name, country: country?.en ?? "Unknown", countryAr: country?.ar ?? null }), stock });
        }
        continue;
      }

      if (route.kind === "MATERIAL") {
        const wanted = materialCategoryFor(category, v.type ?? "");
        let cat = cats.find((c) => c.id === wanted && isMaterialCat(c)) ?? cats.find((c) => isMaterialCat(c) && (nameKey(c.nameAr) === nameKey(category) || (!!c.nameEn && nameKey(c.nameEn) === nameKey(category))));
        if (!cat) cat = cats.find((c) => c.id === "cat_roastery_other" && isMaterialCat(c));
        if (!cat) bad("category", `no system category for «${category}».`, `لا يوجد تصنيف في النظام لـ«${category}».`);
        const unitWord = (v.unit ?? "").trim();
        const u = unitWord ? QOYOD_UNITS[unitWord] ?? QOYOD_UNITS[unitWord.toLowerCase()] : undefined;
        if (unitWord && !u) bad("unit", "use piece, unit, gram, kg, ml or litre.", "استخدم: حبة، وحدة، غرام، كيلو، مل، لتر.");
        const qtyGiven = Number(latinDigits(v.quantity ?? "").replace(/[,\s]/g, "") || 0) > 0;
        let unit: string = u?.unit ?? "PIECE";
        const factor = u?.factor ?? 1;
        if (!u && !countsInPieces(category, v.type ?? "")) {
          if (qtyGiven) bad("unit", "Qoyod's export has no unit: give it in the «الوحدة» column (gram, ml, piece…).", "ملف قيود بلا وحدة: اكتبها في عمود «الوحدة» (غرام، مل، حبة…).");
          else unit = Object.values(QOYOD_UNITS).find((x) => x.unit === cat?.defaultUnit)?.unit ?? "PIECE";
        }
        const site = siteAsked ?? (cat?.id.startsWith("cat_cafe") ? cafeSite : null);
        const stock = stockOf(ctx, v, unit, factor, site, bad, row);
        const exists = existingMat.has(sk);
        push(ctx, { ...base, status: exists ? "EXISTS" : "NEW", kind: cat ? (cat.nameAr ?? "مادة") : "مادة", stock: stockLabel(stock, unit, ctx), note: !u && !countsInPieces(category, v.type ?? "") && !qtyGiven ? `الوحدة: ${UNIT_AR[unit]} (افتراضية)` : null, issues: list });
        if (!list.length && !exists && serial && name && cat) {
          materials.push({
            data: { code: serial, name, nameAr: name, categoryId: cat.id, category: cat.legacyMaterialCategory as "PACKAGING", unitOfMeasure: unit as "PIECE", reorderPoint: 0, isActive: true, notes: text(v, "description", 500) },
            stock,
          });
        }
        continue;
      }

      // SKU — a coffee pack (or a ready product sold here). Its stock is not imported: finished goods are born in roasting.
      const coffee = isCoffeeSalesCategory(category);
      let weight = num(v.weight_grams ?? "");
      if (weight !== null && (!Number.isFinite(weight) || weight <= 0)) { bad("weight_grams", "a weight in grams above zero.", "وزن بالغرام أكبر من صفر."); weight = null; }
      weight ??= weightFromName(name ?? "") ?? weightFromName(v.name_en ?? "");
      let isBulk = false;
      let note: string | null = null;
      if (weight === null) {
        if (/تشغيل/.test(category)) { weight = 1000; isBulk = true; note = "بالكيلو (بن تشغيل المقهى)"; }
        else if (coffee) {
          // A coffee-category product with no weight is a café drink (V60, latte…) or an online bundle: sold at the
          // point of sale / the store, not packed here. Skipped; a weight in «الوزن (غرام)» brings it in as a pack.
          push(ctx, { ...base, status: "SKIPPED", kind: "مشروب أو بكج", note: "بلا وزن في الاسم: مشروب مقهى أو بكج — لا يُستورد (أضف «الوزن (غرام)» لاستيراده عبوةً)", issues: list });
          continue;
        } else { weight = 1; note = "وزن غير محدد (1 غ): عدّله من صفحة المنتج"; }
      }
      // A pack above 30 kg is a typo in Qoyod's name («500 كيلو» for 500 g): refused, fixed in «الوزن (غرام)».
      if (weight !== null && weight > 30_000) bad("weight_grams", `a ${weight / 1000} kg pack is not plausible: give the weight in «الوزن (غرام)».`, `عبوة ${weight / 1000} كيلو غير معقولة (خطأ في الاسم؟): اكتب الوزن الصحيح في عمود «الوزن (غرام)».`);
      const price = decimalText(v.sell_price ?? "", 4);
      if (price === "BAD") bad("sell_price", "a positive price.", "سعر موجب.");
      const barcode = text(v, "barcode", 64);
      if (barcode && seenBarcode.has(barcode)) bad("barcode", `repeats row ${seenBarcode.get(barcode)}.`, `مكرر في الصف ${seenBarcode.get(barcode)}.`);
      if (barcode && !seenBarcode.has(barcode)) seenBarcode.set(barcode, row);
      const exists = existingSku.has(sk);
      if (!exists && barcode && existingBarcode.has(barcode)) bad("barcode", "already on another SKU.", "مستخدم لعبوة أخرى.");
      const fg = Number(latinDigits(v.quantity ?? "").replace(/[,\s]/g, "") || 0);
      if (fg > 0) { ctx.finishedUnits += fg; note = [note, `مخزون جاهز في قيود: ${fg} — لا يُستورد (يُدخل بالجرد)`].filter(Boolean).join(" · "); }
      const latinName = /[A-Za-z]/.test(v.name_en ?? "") ? v.name_en! : null;
      const productName = productNameOf(name ?? "") || (name ?? "");
      const pKey = nameKey(latinName ? productNameOf(latinName) || latinName : productName);
      push(ctx, { ...base, status: exists ? "EXISTS" : "NEW", kind: coffee ? `عبوة بن · ${weight ?? "?"} غ` : "منتج للبيع", note, issues: list });
      if (list.length || exists || !serial || !name || weight === null) continue;
      let g = groups.get(pKey);
      if (!g) {
        const country = countryFromName(name) ?? countryFromName(v.name_en ?? "");
        g = {
          productId: productByName.get(pKey) ?? null,
          product: { productNameEn: latinName ? productNameOf(latinName) || latinName : productName, productNameAr: productName, countryEn: country?.en ?? "Unspecified", countryAr: country?.ar ?? null },
          skus: [],
        };
        groups.set(pKey, g);
      }
      g.skus.push({
        skuCode: serial, name: latinName && latinName !== name ? latinName.slice(0, 200) : null, nameAr: name, weightGrams: weight,
        price: price && price !== "BAD" ? Number(price) : 0, barcode, category: coffee ? "ROASTED_COFFEE" : "MERCHANDISE", unitOfMeasure: "UNIT", isBulk,
      });
    }
    if (greenCostOff.length) ctx.warnings.push(issue(0, "buy_price", `Green coffee cost per kg outside 5–1000 SAR on row(s) ${greenCostOff.join(", ")}: check the green unit.`, `تكلفة كيلو البن الأخضر خارج 5–1000 ريال في الصفوف ${greenCostOff.join("، ")}: تحقّق من وحدة البن (غرام أو كيلو).`));
    const reused = [...groups.values()].filter((g) => g.productId).length;
    if (reused) ctx.warnings.push(issue(0, null, `${reused} product(s) already exist by name: their new SKUs are added to them.`, `${reused} منتج موجود مسبقًا بالاسم: تُضاف عبواته الجديدة إليه.`));
    return { entity: "products", green, materials, groups: [...groups.values()] };
  },
};

// ── Public ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function previewImport(entity: ImportEntity, table: string[][], checksum: string, options: ImportOptions = {}): Promise<Preview> {
  return (await analyse(prisma, entity, table, checksum, options)).preview;
}

export class ImportRefused extends Error {
  constructor(public preview: Preview) { super("The file has errors: nothing was imported."); }
}

/** All or nothing: the check again inside the transaction, then every NEW row written; refused (nothing written) on any error. */
export async function commitImport(entity: ImportEntity, table: string[][], meta: { checksum: string; fileName: string }, actor: Actor, ctx: AuditContext, options: ImportOptions = {}) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const { preview, plan } = await analyse(tx, entity, table, meta.checksum, options);
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
        await auditInventoryReceipt(tx, actor, { entityId: id, opening: true, movementId: movement.id, quantity: s.qty, previousQuantity: 0, newQuantity: s.qty, supplier: null, reference: meta.fileName.slice(0, 120), notes: "استيراد من قيود" });
      }
      await onOpeningStock(tx, { kind, entityId: id, qty: s.qty, actor: actor.id, movementId: movement.id });
      if (s.unitCost) {
        await tx.inventoryOpeningCost.upsert({
          where: { kind_entityId: { kind, entityId: id } },
          create: { kind, entityId: id, unitCost: s.unitCost, note: "استيراد من قيود", updatedBy: actor.id },
          update: { unitCost: s.unitCost, note: "استيراد من قيود", updatedBy: actor.id },
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
      case "products":
        for (const r of plan.green) {
          const at = r.stock ? await site(r.stock) : null;
          const g = await tx.greenBean.create({ data: { ...r.data, quantityKg: r.stock?.qty ?? 0 } });
          if (r.stock && at) await receive("GREEN_BEAN", g.id, r.stock, at);
          created++;
        }
        for (const r of plan.materials) {
          const at = r.stock ? await site(r.stock) : null;
          const mi = await tx.materialItem.create({ data: { ...r.data, quantityOnHand: r.stock?.qty ?? 0 } });
          if (r.stock && at) await receive("MATERIAL", mi.id, r.stock, at);
          created++;
        }
        for (const g of plan.groups) {
          const productId = g.productId ?? (await tx.coffeeProduct.create({ data: g.product, select: { id: true } })).id;
          created += (await tx.productSKU.createMany({ data: g.skus.map((s) => ({ ...s, productId })) })).count;
        }
        break;
    }

    // One append-only audit row per import (the receipts above carry their own); the settings log's actions are a fixed list.
    await audit(tx, {
      action: "DATA_IMPORTED", entityType: "DataImport", entityId: meta.checksum.slice(0, 32), actorId: actor.id,
      after: { entity, fileName: meta.fileName, rows: preview.counts.rows, created, skippedExisting: preview.counts.exists, skipped: preview.counts.skipped, openingStockRows: stockRows, openingCosts: costs },
      reason: `استيراد ${entity} من ${meta.fileName}`.slice(0, 300),
    });
    return { created, skipped: preview.counts.exists + preview.counts.skipped, stockRows, costs, preview };
  }, IMPORT_TX);
}

/** How many records of each kind the system holds now (the page's summary). */
export async function importCounts() {
  const [customers, suppliers, green, materials, skus] = await Promise.all([
    prisma.customer.count(), prisma.supplier.count(), prisma.greenBean.count(), prisma.materialItem.count(), prisma.productSKU.count(),
  ]);
  return { customers, suppliers, products: green + materials + skus, green, materials, skus };
}
