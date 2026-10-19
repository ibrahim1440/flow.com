// Product catalog (Figma 216:2 «المنتجات»; docs/design/direction-2.1-rc/CATALOG-BACKEND.md).
//
// The validation every catalog route shares, kept free of the database so the unit suite can
// pin it (tests/ops/unit/product-catalog.test.ts), plus the few queries the list, the bulk
// actions and the product page share. Owner decisions:
//   D2  categories are one level;
//   D3  a new product carries its Arabic name (existing ones without it stay valid);
//   D4  a barcode is optional, unique per SKU, and checked as EAN-13 only when it is 13 digits;
//   D5  the category sits on the product (CoffeeProduct), never on the SKU.
// Stock is never stored or edited here: free / reserved units come from FinishedGoodsLot
// through the finished-products services.
import type { Prisma } from "@/generated/prisma/client";

// ─── Small parsers ───────────────────────────────────────────────────────────

export type Fail = { ok: false; error: string; field?: string; status?: number };
export type Ok<T> = { ok: true; value: T };
export type Result<T> = Ok<T> | Fail;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const fail = (error: string, field?: string, status = 400): Fail => ({ ok: false, error, field, status });

/** A trimmed string, or null for anything empty / not a string. */
export function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// ─── Barcode (D4) ────────────────────────────────────────────────────────────

/** EAN-13 check digit of the first 12 digits: weights 1, 3 alternating; (10 − sum mod 10) mod 10. */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/**
 * A SKU barcode as it will be stored: trimmed; empty → null. Exactly 13 digits is EAN-13 and must
 * carry the right check digit; any other value (UPC-A, EAN-8, GTIN-14, an internal code) is
 * accepted as entered when it is 1–48 printable characters without whitespace.
 */
export function parseBarcode(v: unknown): Result<string | null> {
  if (v === undefined || v === null) return ok(null);
  if (typeof v !== "string") return fail("barcode must be a string.", "barcode");
  const b = v.trim();
  if (b === "") return ok(null);
  if (/^\d{13}$/.test(b)) {
    const want = ean13CheckDigit(b.slice(0, 12));
    if (Number(b[12]) !== want)
      return fail(`Invalid EAN-13: the check digit should be ${want}.`, "barcode");
    return ok(b);
  }
  if (b.length > 48 || !/^[\x21-\x7E]+$/.test(b))
    return fail("barcode must be 1–48 printable characters without spaces.", "barcode");
  return ok(b);
}

// ─── Categories (D2) ─────────────────────────────────────────────────────────

export type CategoryInput = {
  nameAr?: string;
  nameEn?: string | null;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
};

/** Create (`partial` false: nameAr required) or edit (`partial` true: only what is sent). */
export function parseCategoryInput(body: unknown, partial: boolean): Result<CategoryInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: CategoryInput = {};
  if (!partial || b.nameAr !== undefined) {
    const nameAr = text(b.nameAr);
    if (!nameAr || nameAr.length < 2 || nameAr.length > 80)
      return fail("nameAr is required (2–80 characters).", "nameAr");
    out.nameAr = nameAr;
  }
  if (b.nameEn !== undefined) {
    const nameEn = text(b.nameEn);
    if (nameEn && nameEn.length > 80) return fail("nameEn must be at most 80 characters.", "nameEn");
    out.nameEn = nameEn;
  }
  if (b.description !== undefined) {
    const d = text(b.description);
    if (d && d.length > 300) return fail("description must be at most 300 characters.", "description");
    out.description = d;
  }
  if (b.sortOrder !== undefined) {
    const n = Number(b.sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > 100000) return fail("sortOrder must be a whole number ≥ 0.", "sortOrder");
    out.sortOrder = n;
  }
  if (b.isActive !== undefined) {
    if (typeof b.isActive !== "boolean") return fail("isActive must be true or false.", "isActive");
    if (!partial) return fail("A new category is always active.", "isActive");
    out.isActive = b.isActive;
  }
  return ok(out);
}

/** A list of distinct non-empty ids (1–500). */
export function parseIds(v: unknown, field = "productIds"): Result<string[]> {
  if (!Array.isArray(v)) return fail(`${field} must be an array.`, field);
  const ids = [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))];
  if (ids.length !== v.length) return fail(`${field} must hold distinct, non-empty ids.`, field);
  if (ids.length > 500) return fail(`At most 500 ${field} at a time.`, field);
  return ok(ids);
}

// ─── The All Products list: filter, sort, page ───────────────────────────────

export type ProductStatusFilter = "active" | "inactive" | "all";
export type ProductSort = "name" | "-name" | "updated" | "-updated";
export type ProductListFilter = { q: string; categoryId: string | null; status: ProductStatusFilter };

export const PRODUCT_SORTS: readonly ProductSort[] = ["name", "-name", "updated", "-updated"];
export const PAGE_SIZE_DEFAULT = 25;

/** Reads the list query (`q`, `categoryId` = id | "none", `status`, `sort`, `page`, `pageSize`). */
export function parseListQuery(sp: URLSearchParams): Result<ProductListFilter & { sort: ProductSort; page: number; pageSize: number; lang: "ar" | "en" }> {
  const f = parseFilter({ q: sp.get("q"), categoryId: sp.get("categoryId"), status: sp.get("status") });
  if (!f.ok) return f;
  const sort = (sp.get("sort") ?? "name") as ProductSort;
  if (!PRODUCT_SORTS.includes(sort)) return fail(`sort must be one of: ${PRODUCT_SORTS.join(", ")}.`, "sort");
  const page = Number(sp.get("page") ?? "1");
  const pageSize = Number(sp.get("pageSize") ?? String(PAGE_SIZE_DEFAULT));
  if (!Number.isInteger(page) || page < 1) return fail("page must be a whole number ≥ 1.", "page");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) return fail("pageSize must be 1–200.", "pageSize");
  return ok({ ...f.value, sort, page, pageSize, lang: sp.get("lang") === "en" ? "en" : "ar" });
}

/** The filter half of a list query or of a bulk «all results» body. */
export function parseFilter(v: unknown): Result<ProductListFilter> {
  const b = (v ?? {}) as Record<string, unknown>;
  const q = typeof b.q === "string" ? b.q.trim().slice(0, 100) : "";
  const categoryId = text(b.categoryId);
  const status = (text(b.status) ?? "all") as ProductStatusFilter;
  if (!["active", "inactive", "all"].includes(status)) return fail("status must be active, inactive or all.", "status");
  return ok({ q, categoryId, status });
}

/** Prisma `where` for the list / a filter-wide bulk action. `categoryId` "none" = uncategorised. */
export function productWhere(f: ProductListFilter): Prisma.CoffeeProductWhereInput {
  const and: Prisma.CoffeeProductWhereInput[] = [];
  if (f.status === "active") and.push({ isActive: true });
  if (f.status === "inactive") and.push({ isActive: false });
  if (f.categoryId === "none") and.push({ categoryId: null });
  else if (f.categoryId) and.push({ categoryId: f.categoryId });
  if (f.q) {
    const c = { contains: f.q, mode: "insensitive" as const };
    and.push({
      OR: [
        { productNameEn: c },
        { productNameAr: c },
        { productSkus: { some: { skuCode: c } } },
        { productSkus: { some: { barcode: c } } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

/** Server-side order across all pages, the product id as the stable tiebreak. */
export function productOrderBy(sort: ProductSort, lang: "ar" | "en" = "ar"): Prisma.CoffeeProductOrderByWithRelationInput[] {
  const dir = sort.startsWith("-") ? "desc" : "asc";
  // The name line shows the Arabic name, falling back to the English one; Arabic-named rows sort
  // by it and English-only rows after them by their English name. The English screen sorts by
  // the English name it shows.
  if (sort.endsWith("name") && lang === "en") return [{ productNameEn: dir }, { id: "asc" }];
  if (sort.endsWith("name"))
    return [{ productNameAr: { sort: dir, nulls: "last" } }, { productNameEn: dir }, { id: "asc" }];
  return [{ updatedAt: dir }, { id: "asc" }];
}

/** Bulk body: `{ productIds }` or `{ filter, excludeIds? }` (the «تحديد كل النتائج» form). */
export function parseSelection(body: unknown): Result<{ ids: string[] } | { filter: ProductListFilter; excludeIds: string[] }> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.productIds !== undefined && b.filter !== undefined) return fail("Send productIds or filter, not both.", "productIds");
  if (b.productIds !== undefined) {
    const ids = parseIds(b.productIds);
    if (!ids.ok) return ids;
    if (ids.value.length === 0) return fail("Select at least one product.", "productIds");
    return ok({ ids: ids.value });
  }
  if (b.filter !== undefined) {
    const f = parseFilter(b.filter);
    if (!f.ok) return f;
    const ex = b.excludeIds === undefined ? ok<string[]>([]) : parseIds(b.excludeIds, "excludeIds");
    if (!ex.ok) return ex;
    return ok({ filter: f.value, excludeIds: ex.value });
  }
  return fail("productIds or filter is required.", "productIds");
}

export function selectionWhere(sel: { ids: string[] } | { filter: ProductListFilter; excludeIds: string[] }): Prisma.CoffeeProductWhereInput {
  if ("ids" in sel) return { id: { in: sel.ids } };
  const w = productWhere(sel.filter);
  return sel.excludeIds.length ? { AND: [w, { id: { notIn: sel.excludeIds } }] } : w;
}

// ─── The Add Product form (one transaction) ──────────────────────────────────

export type BomLineInput = {
  type: "ROASTED_COFFEE" | "MATERIAL";
  /** ROASTED_COFFEE: null = «this product» (the one being created). */
  coffeeProductId: string | null;
  materialItemId: string | null;
  quantityPerUnit: number;
  unitOfMeasure: "KG" | "PIECE";
};

export type SkuInput = {
  skuCode: string;
  weightGrams: number;
  price: number;
  barcode: string | null;
  isActive: boolean;
  bom: BomLineInput[];
};

export type ProductFields = {
  productNameAr?: string | null;
  productNameEn?: string;
  countryEn?: string;
  countryAr?: string | null;
  regionEn?: string | null;
  regionAr?: string | null;
  varietyEn?: string | null;
  varietyAr?: string | null;
  processEn?: string | null;
  processAr?: string | null;
  altitude?: string | null;
  cupNotesEn?: string | null;
  cupNotesAr?: string | null;
  roastPathEn?: string | null;
  roastPathAr?: string | null;
  defaultGreenBeanId?: string | null;
  expectedRoastLoss?: number;
  categoryId?: string | null;
  isActive?: boolean;
};

const OPTIONAL_TEXT = [
  "countryAr", "regionEn", "regionAr", "varietyEn", "varietyAr", "processEn", "processAr", "altitude",
  "cupNotesEn", "cupNotesAr", "roastPathEn", "roastPathAr",
] as const;

/**
 * Product fields for a create (`partial` false) or a PATCH (`partial` true).
 * Create: productNameAr (2–120, D3), productNameEn and countryEn are required.
 * PATCH: only what is sent; a set Arabic name cannot be cleared (D3), so `productNameAr: ""` is 400.
 */
export function parseProductFields(body: unknown, partial: boolean): Result<ProductFields> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: ProductFields = {};
  if (!partial || b.productNameAr !== undefined) {
    const ar = text(b.productNameAr);
    if (!ar || ar.length < 2 || ar.length > 120) return fail("productNameAr is required (2–120 characters).", "productNameAr");
    out.productNameAr = ar;
  }
  if (!partial || b.productNameEn !== undefined) {
    const en = text(b.productNameEn);
    if (!en || en.length > 120) return fail("productNameEn is required (at most 120 characters).", "productNameEn");
    out.productNameEn = en;
  }
  if (!partial || b.countryEn !== undefined) {
    const c = text(b.countryEn);
    if (!c) return fail("countryEn is required.", "countryEn");
    out.countryEn = c;
  }
  for (const k of OPTIONAL_TEXT) {
    if (b[k] === undefined) continue;
    const v = text(b[k]);
    if (v && v.length > 200) return fail(`${k} must be at most 200 characters.`, k);
    out[k] = v;
  }
  if (b.expectedRoastLoss !== undefined && b.expectedRoastLoss !== null && b.expectedRoastLoss !== "") {
    const n = Number(b.expectedRoastLoss);
    if (!Number.isFinite(n) || n < 0 || n > 50) return fail("expectedRoastLoss must be a number between 0 and 50.", "expectedRoastLoss");
    out.expectedRoastLoss = n;
  }
  if (b.defaultGreenBeanId !== undefined) out.defaultGreenBeanId = text(b.defaultGreenBeanId);
  if (b.categoryId !== undefined) out.categoryId = text(b.categoryId);
  if (b.isActive !== undefined) {
    if (typeof b.isActive !== "boolean") return fail("isActive must be true or false.", "isActive");
    out.isActive = b.isActive;
  }
  return ok(out);
}

/** The SKUs of the Add Product form, each with its BOM. At least one; codes and barcodes distinct. */
export function parseSkus(v: unknown): Result<SkuInput[]> {
  if (!Array.isArray(v) || v.length === 0) return fail("Add at least one SKU.", "skus");
  if (v.length > 20) return fail("At most 20 SKUs per product.", "skus");
  const out: SkuInput[] = [];
  const codes = new Set<string>();
  const barcodes = new Set<string>();
  for (const [i, raw] of (v as Record<string, unknown>[]).entries()) {
    const n = i + 1;
    const skuCode = text(raw?.skuCode);
    if (!skuCode || skuCode.length > 40) return fail(`SKU ${n}: skuCode is required (at most 40 characters).`, `skus.${i}.skuCode`);
    if (codes.has(skuCode.toUpperCase())) return fail(`SKU code "${skuCode}" appears twice.`, `skus.${i}.skuCode`);
    codes.add(skuCode.toUpperCase());
    const weightGrams = Number(raw?.weightGrams);
    if (!Number.isFinite(weightGrams) || weightGrams <= 0 || weightGrams > 100000)
      return fail(`SKU ${n}: weightGrams must be a positive number.`, `skus.${i}.weightGrams`);
    const price = Number(raw?.price);
    if (raw?.price === undefined || raw?.price === null || raw?.price === "" || !Number.isFinite(price) || price < 0)
      return fail(`SKU ${n}: price must be a number ≥ 0.`, `skus.${i}.price`);
    const bc = parseBarcode(raw?.barcode);
    if (!bc.ok) return { ...bc, error: `SKU ${n}: ${bc.error}`, field: `skus.${i}.barcode` };
    if (bc.value) {
      if (barcodes.has(bc.value)) return fail(`Barcode ${bc.value} appears twice.`, `skus.${i}.barcode`);
      barcodes.add(bc.value);
    }
    if (raw?.isActive !== undefined && typeof raw.isActive !== "boolean")
      return fail(`SKU ${n}: isActive must be true or false.`, `skus.${i}.isActive`);
    const bom = parseBom(raw?.bom ?? [], n);
    if (!bom.ok) return bom;
    out.push({ skuCode, weightGrams, price, barcode: bc.value, isActive: raw?.isActive !== false, bom: bom.value });
  }
  return ok(out);
}

/** One SKU's BOM lines (the same rules as PUT /api/products/[id]/bom). */
export function parseBom(v: unknown, skuNo: number): Result<BomLineInput[]> {
  if (!Array.isArray(v)) return fail(`SKU ${skuNo}: bom must be an array.`, "bom");
  const out: BomLineInput[] = [];
  const seen = new Set<string>();
  for (const raw of v as Record<string, unknown>[]) {
    const qty = Number(raw?.quantityPerUnit);
    if (!Number.isFinite(qty) || qty <= 0) return fail(`SKU ${skuNo}: each component needs a quantity greater than zero.`, "bom");
    if (raw?.type === "ROASTED_COFFEE") {
      const id = text(raw.coffeeProductId);
      const key = `c:${id ?? "self"}`;
      if (seen.has(key)) return fail(`SKU ${skuNo}: the same coffee appears twice in the components.`, "bom");
      seen.add(key);
      out.push({ type: "ROASTED_COFFEE", coffeeProductId: id, materialItemId: null, quantityPerUnit: qty, unitOfMeasure: "KG" });
    } else if (raw?.type === "MATERIAL") {
      const id = text(raw.materialItemId);
      if (!id) return fail(`SKU ${skuNo}: a material component needs a materialItemId.`, "bom");
      if (seen.has(`m:${id}`)) return fail(`SKU ${skuNo}: the same material appears twice in the components.`, "bom");
      seen.add(`m:${id}`);
      out.push({ type: "MATERIAL", coffeeProductId: null, materialItemId: id, quantityPerUnit: qty, unitOfMeasure: "PIECE" });
    } else {
      return fail(`SKU ${skuNo}: each component's type must be ROASTED_COFFEE or MATERIAL.`, "bom");
    }
  }
  return ok(out);
}

/** The Prisma data of a product create / update from parsed fields. */
export function productData(f: ProductFields): Prisma.CoffeeProductUncheckedUpdateInput {
  const d: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) if (v !== undefined) d[k] = v;
  return d as Prisma.CoffeeProductUncheckedUpdateInput;
}

/** «الاسم» on every catalog screen: Arabic, falling back to English (D3: no blank row). */
export function productDisplayName(p: { productNameAr: string | null; productNameEn: string }, lang: "ar" | "en" = "ar"): string {
  return lang === "ar" ? p.productNameAr || p.productNameEn : p.productNameEn;
}
