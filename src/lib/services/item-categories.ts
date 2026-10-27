// Unified inventory, phase 1 — item categories on the database (20261112090000_item_categories): the tree with
// its item counts, and the writes of the categories page (create, rename, unit, reorder, archive / restore), each
// with a settings audit row (section "inventory"). The rules live in src/lib/inventory/item-categories.ts and, as
// a backstop, in the migration's CHECKs and triggers.
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { writeSettingsAudit } from "@/lib/services/settings/audit";
import {
  ITEM_UNITS, MATERIAL_ENUM, MATERIAL_TEMPLATES, ROLE_CHANGE_REFUSAL, defaultCategoryOf, parseNames, refuse, roleChanges, triggerRefusal, validateNewCategory,
  type CategoryRow, type Refusal,
} from "@/lib/inventory/item-categories";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name?: string | null };
export type Result<T> = { ok: true; data: T } | Refusal;

const SELECT = {
  id: true, nameAr: true, nameEn: true, parentId: true, template: true, defaultUnit: true, inventoryRole: true,
  legacyMaterialCategory: true, isSystem: true, isActive: true, archivedAt: true, sortOrder: true, updatedByName: true, updatedAt: true,
} as const;

const snap = (c: CategoryRow) => ({ nameAr: c.nameAr, nameEn: c.nameEn, parentId: c.parentId, template: c.template, defaultUnit: c.defaultUnit, inventoryRole: c.inventoryRole, isActive: c.isActive, sortOrder: c.sortOrder });

export type CategoryNode = CategoryRow & {
  updatedByName: string | null;
  /** Items directly in this category: materials (active), green lots (active), roasted batches / finished lots in stock. */
  itemCount: number;
  /** Active items at or below their reorder point. */
  lowCount: number;
};

/** Every category (archived included when asked), ordered root by root, with its item and low-stock counts. */
export async function categoryTree(opts: { includeArchived?: boolean } = {}): Promise<CategoryNode[]> {
  const [cats, mats, greens, roasted, finished] = await Promise.all([
    prisma.itemCategory.findMany({ where: opts.includeArchived ? {} : { archivedAt: null }, select: SELECT, orderBy: [{ sortOrder: "asc" }, { nameAr: "asc" }] }),
    prisma.materialItem.findMany({ where: { isActive: true }, select: { categoryId: true, quantityOnHand: true, reorderPoint: true } }),
    prisma.greenBean.count({ where: { isActive: true } }),
    prisma.roastingBatch.count({ where: { roastedAvailableKg: { gt: 0.0005 } } }),
    prisma.finishedGoodsLot.count({ where: { status: { not: "SHIPPED" } } }),
  ]);
  const count = new Map<string, number>(), low = new Map<string, number>();
  for (const m of mats) {
    if (!m.categoryId) continue;
    count.set(m.categoryId, (count.get(m.categoryId) ?? 0) + 1);
    if (m.reorderPoint > 0 && m.quantityOnHand <= m.reorderPoint) low.set(m.categoryId, (low.get(m.categoryId) ?? 0) + 1);
  }
  const roots = cats.filter((c) => !c.parentId);
  const out: CategoryNode[] = [];
  const node = (c: (typeof cats)[number]): CategoryNode => ({
    ...c,
    itemCount: c.template === "GREEN_COFFEE" ? greens : c.template === "ROASTED_COFFEE" ? roasted : c.template === "FINISHED" ? finished : count.get(c.id) ?? 0,
    lowCount: low.get(c.id) ?? 0,
  });
  for (const r of roots) {
    out.push(node(r));
    for (const k of cats.filter((c) => c.parentId === r.id)) out.push(node(k));
  }
  // children whose root is archived (only listed with includeArchived) keep a place at the end
  for (const c of cats) if (!out.some((o) => o.id === c.id)) out.push(node(c));
  return out;
}

/** The category and, for a root, its children's ids (the subtree an inventory filter covers). */
export async function subtreeIds(id: string): Promise<CategoryRow[]> {
  return prisma.itemCategory.findMany({ where: { OR: [{ id }, { parentId: id }] }, select: SELECT });
}

function mapDbRefusal(err: unknown): Refusal | null {
  const msg = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "";
  const r = triggerRefusal(msg);
  if (r) return r;
  if (/ItemCategory_active_name_key|Unique constraint/i.test(msg) || (err as { code?: string })?.code === "P2002")
    return refuse(409, "ITEM_CATEGORY_NAME_TAKEN", "A category of this name already exists here.", "يوجد تصنيف بهذا الاسم في المكان نفسه.");
  return null;
}

async function nameTaken(tx: Tx, parentId: string | null, nameAr: string, exceptId?: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "ItemCategory" WHERE COALESCE("parentId", '') = COALESCE(${parentId}, '') AND lower(btrim("nameAr")) = lower(btrim(${nameAr}))
      AND "archivedAt" IS NULL AND "id" <> COALESCE(${exceptId ?? null}, '')`;
  return Number(rows[0]?.n ?? 0) > 0;
}
const TAKEN: Refusal = refuse(409, "ITEM_CATEGORY_NAME_TAKEN", "A category of this name already exists here.", "يوجد تصنيف بهذا الاسم في المكان نفسه.");
const NOT_FOUND: Refusal = refuse(404, "ITEM_CATEGORY_NOT_FOUND", "The category was not found.", "التصنيف غير موجود.");

export async function createCategory(body: Record<string, unknown>, actor: Actor): Promise<Result<CategoryRow>> {
  const parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : null;
  const parent = parentId ? await prisma.itemCategory.findUnique({ where: { id: parentId }, select: SELECT }) : null;
  const v = validateNewCategory(body, parent);
  if (!v.ok) return v;
  try {
    return await prisma.$transaction(async (tx) => {
      if (await nameTaken(tx, v.data.parentId, v.data.nameAr)) return TAKEN;
      const last = await tx.itemCategory.aggregate({ where: { parentId: v.data.parentId }, _max: { sortOrder: true } });
      const row = await tx.itemCategory.create({
        data: { ...v.data, sortOrder: (last._max.sortOrder ?? 0) + 1, isSystem: false, updatedByName: actor.name ?? null },
        select: SELECT,
      });
      await writeSettingsAudit(tx, { section: "inventory", action: "CATEGORY_CREATED", entityType: "ItemCategory", entityId: row.id, changed: ["nameAr", "nameEn", "parentId", "template", "defaultUnit"], after: snap(row), actor });
      return { ok: true as const, data: row };
    });
  } catch (err) {
    const r = mapDbRefusal(err);
    if (r) return r;
    throw err;
  }
}

/** Rename (ar / en), change the default unit, archive or restore. Template, role and parent never change here. */
export async function updateCategory(id: string, body: Record<string, unknown>, actor: Actor): Promise<Result<CategoryRow>> {
  const names = parseNames(body, true);
  if (!names.ok) return names;
  const unit = body.defaultUnit;
  if (unit !== undefined && !(typeof unit === "string" && (ITEM_UNITS as readonly string[]).includes(unit)))
    return refuse(400, "ITEM_CATEGORY_UNIT_INVALID", `The unit must be one of ${ITEM_UNITS.join(", ")}.`, "وحدة القياس غير معروفة.");
  if (body.template !== undefined || body.parentId !== undefined || body.inventoryRole !== undefined)
    return refuse(400, "ITEM_CATEGORY_FIXED", "A category's type and place never change; create a new category instead.", "نوع التصنيف ومكانه لا يتغيّران؛ أنشئ تصنيفًا جديدًا بدلًا من ذلك.");
  const archive = body.archived === true ? true : body.archived === false ? false : undefined;
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ItemCategory" WHERE "id" = ${id} FOR UPDATE`;
      if (!locked.length) return NOT_FOUND;
      const before = (await tx.itemCategory.findUnique({ where: { id }, select: SELECT }))!;
      const data: Prisma.ItemCategoryUpdateInput = { ...names.data, updatedByName: actor.name ?? null };
      if (unit !== undefined) data.defaultUnit = unit as string;
      let action: "CATEGORY_UPDATED" | "CATEGORY_ARCHIVED" | "CATEGORY_RESTORED" = "CATEGORY_UPDATED";
      if (archive === true && before.isActive) {
        if (before.isSystem) return refuse(409, "ITEM_CATEGORY_SYSTEM", "A system category cannot be archived; it can be renamed or reordered.", "لا يُؤرشف التصنيف الأساسي؛ يمكن إعادة تسميته أو ترتيبه فقط.");
        const [kids, items] = await Promise.all([
          tx.itemCategory.count({ where: { parentId: id, archivedAt: null } }),
          tx.materialItem.count({ where: { categoryId: id, isActive: true } }),
        ]);
        if (kids > 0) return refuse(409, "ITEM_CATEGORY_HAS_CHILDREN", "Archive or move its sub-categories first.", "أرشف تصنيفاته الفرعية أولًا.");
        if (items > 0) return refuse(409, "ITEM_CATEGORY_HAS_ITEMS", `This category still holds ${items} active item(s). Move them to another category or deactivate them first.`, `ما زال في هذا التصنيف ${items} صنف نشط. انقلها إلى تصنيف آخر أو أوقفها أولًا.`);
        data.isActive = false; data.archivedAt = new Date(); action = "CATEGORY_ARCHIVED";
      } else if (archive === false && !before.isActive) {
        if (before.parentId) {
          const p = await tx.itemCategory.findUnique({ where: { id: before.parentId }, select: { isActive: true } });
          if (!p?.isActive) return refuse(409, "ITEM_CATEGORY_PARENT_ARCHIVED", "Restore its main category first.", "استعد التصنيف الرئيسي أولًا.");
        }
        data.isActive = true; data.archivedAt = null; action = "CATEGORY_RESTORED";
      }
      const nameAr = names.data.nameAr ?? before.nameAr;
      const willBeActive = data.isActive ?? before.isActive;
      if (willBeActive && (names.data.nameAr !== undefined || action === "CATEGORY_RESTORED") && (await nameTaken(tx, before.parentId, nameAr, id))) return TAKEN;
      const row = await tx.itemCategory.update({ where: { id }, data, select: SELECT });
      const b = snap(before), a = snap(row);
      const changed = Object.keys(a).filter((k) => JSON.stringify(a[k as keyof typeof a]) !== JSON.stringify(b[k as keyof typeof b]));
      if (changed.length) await writeSettingsAudit(tx, { section: "inventory", action, entityType: "ItemCategory", entityId: id, changed, before: b, after: a, actor });
      return { ok: true as const, data: row };
    });
  } catch (err) {
    const r = mapDbRefusal(err);
    if (r) return r;
    throw err;
  }
}

/** Set the order of the categories under one parent (roots: parentId null). Every id must be a sibling. */
export async function reorderCategories(parentId: string | null, ids: unknown, actor: Actor): Promise<Result<{ ids: string[] }>> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((x) => typeof x === "string"))
    return refuse(400, "ITEM_CATEGORY_ORDER_INVALID", "Send the categories of one level in their new order.", "أرسل تصنيفات المستوى الواحد بترتيبها الجديد.");
  const list = ids as string[];
  return prisma.$transaction(async (tx) => {
    const siblings = await tx.itemCategory.findMany({ where: { parentId }, select: { id: true, sortOrder: true } });
    const known = new Set(siblings.map((s) => s.id));
    if (new Set(list).size !== list.length || list.some((x) => !known.has(x)))
      return refuse(400, "ITEM_CATEGORY_ORDER_INVALID", "Send the categories of one level in their new order.", "أرسل تصنيفات المستوى الواحد بترتيبها الجديد.");
    const before = Object.fromEntries(siblings.map((s) => [s.id, s.sortOrder]));
    // listed first, in the given order; any sibling not listed keeps its relative place after them
    const rest = siblings.filter((s) => !list.includes(s.id)).sort((a, b) => a.sortOrder - b.sortOrder).map((s) => s.id);
    const order = [...list, ...rest];
    for (const [i, id] of order.entries()) if (before[id] !== i + 1) await tx.itemCategory.update({ where: { id }, data: { sortOrder: i + 1, updatedByName: actor.name ?? null } });
    const after = Object.fromEntries(order.map((id, i) => [id, i + 1]));
    await writeSettingsAudit(tx, { section: "inventory", action: "CATEGORY_REORDERED", entityType: "ItemCategory", entityId: parentId ?? "root", changed: ["sortOrder"], before, after, actor });
    return { ok: true as const, data: { ids: order } };
  });
}

/**
 * Resolve the category a material is created in or moved to: `categoryId` (preferred) or, for clients that only
 * know the legacy enum, that enum's seeded category. The category must be active and hold materials.
 */
export async function resolveMaterialCategory(tx: Tx | typeof prisma, b: { categoryId?: unknown; category?: unknown }): Promise<Result<CategoryRow>> {
  let id: string | null = null;
  if (typeof b.categoryId === "string" && b.categoryId) id = b.categoryId;
  else if (typeof b.category === "string") {
    if ((MATERIAL_ENUM as readonly string[]).includes(b.category)) id = defaultCategoryOf(b.category);
  }
  if (!id) return refuse(400, "ITEM_CATEGORY_REQUIRED", "Choose the item's category.", "اختر تصنيف الصنف.");
  const c = await tx.itemCategory.findUnique({ where: { id }, select: SELECT });
  if (!c) return NOT_FOUND;
  if (!(MATERIAL_TEMPLATES as readonly string[]).includes(c.template) || !c.legacyMaterialCategory)
    return refuse(400, "ITEM_CATEGORY_NOT_MATERIAL", "Items of this kind are not added to that category.", "لا تُضاف أصناف من هذا النوع إلى هذا التصنيف.");
  if (!c.isActive) return refuse(400, "ITEM_CATEGORY_PARENT_ARCHIVED", "That category is archived.", "هذا التصنيف مؤرشف.");
  return { ok: true, data: c };
}

/**
 * Whether a material may move to `to`: within one inventory role always; across roles only while it has no stock
 * and no cost-ledger holder (CostItem — every CostMove hangs off one). The same rule as the trigger.
 */
export async function checkMaterialMove(tx: Tx, item: { id: string; category: string; categoryId: string | null; quantityOnHand: number }, to: CategoryRow): Promise<Refusal | null> {
  if (item.categoryId === to.id) return null;
  const from = item.categoryId ? await tx.itemCategory.findUnique({ where: { id: item.categoryId }, select: { inventoryRole: true } }) : null;
  if (!roleChanges(from, item.category, to)) return null;
  if (item.quantityOnHand !== 0) return ROLE_CHANGE_REFUSAL;
  const costed = await tx.costItem.count({ where: { kind: "MATERIAL", entityId: item.id } });
  return costed > 0 ? ROLE_CHANGE_REFUSAL : null;
}

export { mapDbRefusal as categoryDbRefusal };
