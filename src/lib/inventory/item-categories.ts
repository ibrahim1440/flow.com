// Unified inventory, phase 1 — item categories (migration 20261112090000_item_categories). Pure: no database
// import, shared by the API, the cost ledger, the inventory page and the tests.
//
// A category says WHAT the stock is (never where — locations are a later phase). Its template decides the form
// and the backing table of its items; its inventory role is the accounting posting role, derived from the
// template and never chosen by the user. The database enforces the same rules (CHECKs and triggers).

export const CATEGORY_TEMPLATES = ["GREEN_COFFEE", "ROASTED_COFFEE", "FINISHED", "PACKAGING", "GENERAL"] as const;
export type CategoryTemplate = (typeof CATEGORY_TEMPLATES)[number];

export const INVENTORY_ROLES = ["INVENTORY_GREEN", "INVENTORY_PACKAGING", "INVENTORY_CAFE", "INVENTORY_ROASTED", "INVENTORY_PACKED"] as const;
export type CategoryInventoryRole = (typeof INVENTORY_ROLES)[number];

export const MATERIAL_ENUM = ["PACKAGING", "LABEL", "CONSUMABLE", "OTHER"] as const;
export type MaterialEnum = (typeof MATERIAL_ENUM)[number];

/** UnitOfMeasure names (LITER added by 20261112090000). */
export const ITEM_UNITS = ["UNIT", "KG", "GRAM", "PIECE", "LITER"] as const;
export type ItemUnit = (typeof ITEM_UNITS)[number];

/** Templates whose items are not added here: they come from roasting / packaging (view only). */
export const VIEW_ONLY_TEMPLATES: readonly CategoryTemplate[] = ["ROASTED_COFFEE", "FINISHED"];
/** Templates whose items are MaterialItem rows. */
export const MATERIAL_TEMPLATES: readonly CategoryTemplate[] = ["PACKAGING", "GENERAL"];
/** Templates a user may give a NEW root (the green, roasted and finished categories are the seeded system ones). */
export const USER_ROOT_TEMPLATES: readonly CategoryTemplate[] = ["PACKAGING", "GENERAL"];

/** The seeded categories (deterministic ids). */
export const SEED = {
  roastery: "cat_roastery",
  cafe: "cat_cafe",
  finished: "cat_finished",
  green: "cat_roastery_green",
  roasted: "cat_roastery_roasted",
  bags: "cat_roastery_bags",
  labels: "cat_roastery_labels",
  other: "cat_roastery_other",
} as const;

/** template → inventory role (1:1; the CHECK ItemCategory_role_matches_template holds the same table). */
export const ROLE_OF_TEMPLATE: Record<CategoryTemplate, CategoryInventoryRole> = {
  GREEN_COFFEE: "INVENTORY_GREEN",
  ROASTED_COFFEE: "INVENTORY_ROASTED",
  FINISHED: "INVENTORY_PACKED",
  PACKAGING: "INVENTORY_PACKAGING",
  GENERAL: "INVENTORY_CAFE",
};

/** The default unit a new category of a template starts with. */
export const UNIT_OF_TEMPLATE: Record<CategoryTemplate, ItemUnit> = {
  GREEN_COFFEE: "KG", ROASTED_COFFEE: "KG", FINISHED: "UNIT", PACKAGING: "PIECE", GENERAL: "PIECE",
};

/** The role the cost ledger gave a material BEFORE categories (cost-ledger.ts / valuation.ts): the fallback. */
export function legacyMaterialRole(category: string | null | undefined): CategoryInventoryRole {
  return category === "CONSUMABLE" || category === "OTHER" ? "INVENTORY_CAFE" : "INVENTORY_PACKAGING";
}

/**
 * The cost role of a MaterialItem: its category's inventory role; the legacy enum rule when it has no category
 * (a row written before the migration's back-fill, or a category that could not be read). For every material that
 * existed before the migration the two agree (the back-fill maps PACKAGING / LABEL → a PACKAGING category,
 * CONSUMABLE / OTHER → a GENERAL one) — tests/ops/unit/item-categories.test.ts proves it for every enum value.
 */
export function materialInventoryRole(m: { category?: string | null; itemCategory?: { inventoryRole: string } | null }): CategoryInventoryRole {
  const r = m.itemCategory?.inventoryRole;
  return r && (INVENTORY_ROLES as readonly string[]).includes(r) ? (r as CategoryInventoryRole) : legacyMaterialRole(m.category);
}

/** Back-fill (and default) mapping of the legacy enum to a seeded category — the migration's CASE. */
export function defaultCategoryOf(category: string | null | undefined): string {
  return category === "PACKAGING" ? SEED.bags : category === "LABEL" ? SEED.labels : category === "CONSUMABLE" || category === "OTHER" ? SEED.other : SEED.bags;
}

/** The legacy enum a NEW category's items carry: a child inherits its parent's; a root by its template. */
export function legacyEnumFor(template: CategoryTemplate, parentLegacy?: string | null): MaterialEnum | null {
  if (!(MATERIAL_TEMPLATES as readonly string[]).includes(template)) return null;
  if (parentLegacy && (MATERIAL_ENUM as readonly string[]).includes(parentLegacy)) {
    const p = parentLegacy as MaterialEnum;
    // keep the parent's when it belongs to the same role (PACKAGING/LABEL ↔ packaging; CONSUMABLE/OTHER ↔ café)
    if (legacyMaterialRole(p) === ROLE_OF_TEMPLATE[template]) return p === "LABEL" ? "LABEL" : p;
  }
  return template === "PACKAGING" ? "PACKAGING" : "CONSUMABLE";
}

export type CategoryRow = {
  id: string; nameAr: string; nameEn: string | null; parentId: string | null; template: string; defaultUnit: string;
  inventoryRole: string; legacyMaterialCategory: string | null; isSystem: boolean; isActive: boolean; archivedAt: Date | string | null;
  sortOrder: number;
};

const clean = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const BAD = /[<>\u0000-\u001f\u007f]/;

export type CategoryInput = { nameAr: string; nameEn: string | null; parentId: string | null; template: CategoryTemplate; defaultUnit: ItemUnit };
export type Refusal = { ok: false; status: number; code: string; error: string; errorAr: string };

export const refuse = (status: number, code: string, error: string, errorAr: string): Refusal => ({ ok: false, status, code, error, errorAr });

/** A name (Arabic required, English optional): 1–80 characters, no markup or control characters. */
export function parseNames(b: Record<string, unknown>, partial: boolean): { ok: true; data: { nameAr?: string; nameEn?: string | null } } | Refusal {
  const out: { nameAr?: string; nameEn?: string | null } = {};
  if (!partial || b.nameAr !== undefined) {
    const ar = clean(b.nameAr);
    if (!ar) return refuse(400, "ITEM_CATEGORY_NAME_REQUIRED", "The Arabic name is required.", "الاسم العربي مطلوب.");
    if (ar.length > 80 || BAD.test(ar)) return refuse(400, "ITEM_CATEGORY_NAME_INVALID", "The name must be 1–80 characters, with no markup.", "الاسم من 1 إلى 80 حرفًا، بلا رموز تنسيق.");
    out.nameAr = ar;
  }
  if (!partial || b.nameEn !== undefined) {
    const en = clean(b.nameEn);
    if (en.length > 80 || BAD.test(en)) return refuse(400, "ITEM_CATEGORY_NAME_INVALID", "The name must be 1–80 characters, with no markup.", "الاسم من 1 إلى 80 حرفًا، بلا رموز تنسيق.");
    out.nameEn = en || null;
  }
  return { ok: true, data: out };
}

/**
 * Validate a NEW category against its parent (two levels at most; a child inherits its root's template and
 * role; a new root picks PACKAGING or GENERAL; nothing under a view-only or green root).
 */
export function validateNewCategory(b: Record<string, unknown>, parent: CategoryRow | null): { ok: true; data: CategoryInput & { inventoryRole: CategoryInventoryRole; legacyMaterialCategory: MaterialEnum | null } } | Refusal {
  const names = parseNames(b, false);
  if (!names.ok) return names;
  const parentId = typeof b.parentId === "string" && b.parentId ? b.parentId : null;
  let template: CategoryTemplate;
  if (parentId) {
    if (!parent) return refuse(404, "ITEM_CATEGORY_PARENT", "The parent category was not found.", "التصنيف الأب غير موجود.");
    if (parent.parentId) return refuse(400, "ITEM_CATEGORY_DEPTH", "Categories are at most two levels deep: a sub-category cannot hold sub-categories.", "التصنيفات مستويان فقط: لا يُضاف تصنيف فرعي تحت تصنيف فرعي.");
    if (!parent.isActive) return refuse(400, "ITEM_CATEGORY_PARENT_ARCHIVED", "The parent category is archived.", "التصنيف الأب مؤرشف.");
    if (!(MATERIAL_TEMPLATES as readonly string[]).includes(parent.template)) return refuse(400, "ITEM_CATEGORY_PARENT_VIEW_ONLY", "This category holds no sub-categories.", "هذا التصنيف لا يقبل تصنيفات فرعية.");
    template = parent.template as CategoryTemplate;
    if (b.template !== undefined && b.template !== template) return refuse(400, "ITEM_CATEGORY_TEMPLATE_INHERITED", "A sub-category takes its main category's type.", "التصنيف الفرعي يأخذ نوع التصنيف الرئيسي.");
  } else {
    const t = typeof b.template === "string" ? b.template : "GENERAL";
    if (!(USER_ROOT_TEMPLATES as readonly string[]).includes(t)) return refuse(400, "ITEM_CATEGORY_TEMPLATE_INVALID", "A new main category is either supplies (packaging) or general stock.", "التصنيف الرئيسي الجديد إما مستلزمات تغليف أو مخزون عام.");
    template = t as CategoryTemplate;
  }
  const unitIn = typeof b.defaultUnit === "string" && b.defaultUnit ? b.defaultUnit : parent?.defaultUnit ?? UNIT_OF_TEMPLATE[template];
  if (!(ITEM_UNITS as readonly string[]).includes(unitIn)) return refuse(400, "ITEM_CATEGORY_UNIT_INVALID", `The unit must be one of ${ITEM_UNITS.join(", ")}.`, "وحدة القياس غير معروفة.");
  return {
    ok: true,
    data: {
      nameAr: names.data.nameAr!, nameEn: names.data.nameEn ?? null, parentId, template, defaultUnit: unitIn as ItemUnit,
      inventoryRole: ROLE_OF_TEMPLATE[template], legacyMaterialCategory: legacyEnumFor(template, parent?.legacyMaterialCategory),
    },
  };
}

/** Whether moving a material between two categories changes its accounting role. */
export function roleChanges(from: { inventoryRole: string } | null, fromEnum: string | null | undefined, to: { inventoryRole: string }): boolean {
  const before = from?.inventoryRole ?? legacyMaterialRole(fromEnum);
  return before !== to.inventoryRole;
}

export const ROLE_CHANGE_REFUSAL: Refusal = refuse(
  409, "ITEM_CATEGORY_ROLE_CHANGE",
  "This item already has stock or cost under its current category, which is booked to a different inventory account. Move it with a stock transfer (count it out here and receive it in the new category) instead of changing its category.",
  "لهذا الصنف رصيد أو تكلفة في تصنيفه الحالي، وهو مسجَّل على حساب مخزون مختلف. انقله بتحويل مخزون (جرده خارجًا هنا واستلامه في التصنيف الجديد) بدل تغيير تصنيفه.",
);

/** The plain-language label of a template (the categories page and the add flow). */
export const TEMPLATE_LABEL: Record<CategoryTemplate, [string, string]> = {
  GREEN_COFFEE: ["بن أخضر", "Green coffee"],
  ROASTED_COFFEE: ["بن محمص (من التحميص)", "Roasted coffee (from roasting)"],
  FINISHED: ["منتجات جاهزة (من التعبئة)", "Finished products (from packing)"],
  PACKAGING: ["مستلزمات تغليف", "Packaging supplies"],
  GENERAL: ["مخزون عام", "General stock"],
};

/** The accounting role in plain words (no account codes). */
export const ROLE_LABEL: Record<CategoryInventoryRole, [string, string]> = {
  INVENTORY_GREEN: ["مخزون البن الأخضر", "Green coffee inventory"],
  INVENTORY_PACKAGING: ["مخزون مواد التغليف", "Packaging inventory"],
  INVENTORY_CAFE: ["مخزون المقهى والمستهلكات", "Café and consumables inventory"],
  INVENTORY_ROASTED: ["مخزون البن المحمص", "Roasted coffee inventory"],
  INVENTORY_PACKED: ["مخزون المنتجات الجاهزة", "Finished goods inventory"],
};

export const UNIT_LABEL: Record<ItemUnit, [string, string]> = {
  UNIT: ["وحدة", "Unit"], KG: ["كيلوغرام", "Kilogram"], GRAM: ["غرام", "Gram"], PIECE: ["قطعة", "Piece"], LITER: ["لتر", "Litre"],
};

/** Map a database trigger refusal (P0001 'ITEM_CATEGORY_…: …') to its API refusal. */
export function triggerRefusal(message: string | null | undefined): Refusal | null {
  const m = /(ITEM_CATEGORY_[A-Z_]+)/.exec(message ?? "");
  if (!m) return null;
  switch (m[1]) {
    case "ITEM_CATEGORY_ROLE_CHANGE": return ROLE_CHANGE_REFUSAL;
    case "ITEM_CATEGORY_DEPTH": return refuse(400, m[1], "Categories are at most two levels deep.", "التصنيفات مستويان فقط.");
    case "ITEM_CATEGORY_NOT_MATERIAL": return refuse(400, m[1], "Items of this kind are not added to that category.", "لا تُضاف أصناف من هذا النوع إلى هذا التصنيف.");
    case "ITEM_CATEGORY_SYSTEM": return refuse(409, m[1], "A system category is only renamed or reordered.", "التصنيف الأساسي يُعاد تسميته أو ترتيبه فقط.");
    case "ITEM_CATEGORY_FIXED": return refuse(409, m[1], "A category's type never changes.", "نوع التصنيف لا يتغيّر.");
    case "ITEM_CATEGORY_PARENT_VIEW_ONLY": return refuse(400, m[1], "This category holds no sub-categories.", "هذا التصنيف لا يقبل تصنيفات فرعية.");
    default: return refuse(400, m[1], "The category change was refused.", "رُفض تغيير التصنيف.");
  }
}
