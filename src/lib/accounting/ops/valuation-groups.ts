// Unified inventory phase 4 — «تقييم المخزون» by the phase-1 categories and the phase-3 locations. Pure (no database):
// the read model (valuation-report.ts) feeds it rows, the tests feed it fixtures.
//
// Accounting rules (council 01 / 04 / 06; F1 of the phase-4 review):
//   • The VALUE is the cost ledger's: each holder's value (moving weighted average × the ledger's quantity). A category
//     only groups holders; a sub-category belongs to exactly ONE inventory account (its template's role — a material
//     never changes role while it holds stock, src/lib/services/item-categories.ts), so Σ categories = Σ accounts =
//     the cost ledger, to the halala. The GL comparison stays per account (reconciliation()).
//   • The LOCATION split is an ESTIMATE: valuation is company-wide (one moving average per item, transfers move value
//     at cost and post nothing). A multi-site item (green lot, material): the holder's BOOK VALUE is allocated over the
//     sites in proportion to their quantities, the largest site taking the halala remainder — so Σ sites = the book
//     value, always. When the sites hold exactly the ledger's quantity this is site qty × the company average. When
//     they do not, the quantity difference (ledger − Σ sites) is reported on its own, as a quantity to count — never
//     as money. A single-site holder (a finished lot: its site; unpacked roasted coffee: the production site) is
//     wholly there. «غير موزّع» is only the value of holders with NO site quantity at all (never negative).
import { Decimal, ZERO, roundMoney } from "../money";
import { qty4 } from "./costing";
import { SEED, defaultCategoryOf } from "@/lib/inventory/item-categories";

export type SiteQty = { locationId: string; qty: number | string };
export type SiteShare = { locationId: string; qty: string; value: string };

/** The category a cost holder is shown under: a material by its own category, the coffee kinds by their system one. */
export function holderCategoryId(kind: string, material?: { categoryId?: string | null; category?: string | null } | null): string {
  if (kind === "GREEN_BEAN") return SEED.green;
  if (kind === "ROASTED_BATCH") return SEED.roasted;
  if (kind === "FG_LOT") return SEED.finished;
  return material?.categoryId || defaultCategoryOf(material?.category ?? null);
}

/**
 * The location shares of one holder (see the header). `single` names the one site of a single-site holder; `sites`
 * are a multi-site item's balances (any order; qty ≤ 0 ignored). Value and qty strings, 2 / 4 decimals. Σ values =
 * the holder's value whenever any site holds a positive quantity.
 */
export function siteShares(h: { qty: Decimal | string; value: Decimal | string; avgCost?: Decimal | string }, sites: SiteQty[], single: string | null): SiteShare[] {
  const value = new Decimal(h.value), qty = new Decimal(h.qty);
  if (single !== null) return value.isZero() && qty.isZero() ? [] : [{ locationId: single, qty: qty.toFixed(4), value: value.toFixed(2) }];
  const list = sites.map((s) => ({ locationId: s.locationId, qty: qty4(Number(s.qty)) })).filter((s) => s.qty.gt(0));
  if (!list.length) return [];
  // Largest site last: it takes the remainder (stable order by quantity, then id).
  list.sort((a, b) => (a.qty.cmp(b.qty) || (a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : 0)));
  const siteQty = list.reduce((a, s) => a.plus(s.qty), ZERO);
  const out = list.map((s) => ({ locationId: s.locationId, qty: s.qty, value: roundMoney(value.times(s.qty).dividedBy(siteQty)) }));
  const others = out.slice(0, -1).reduce((a, s) => a.plus(s.value), ZERO);
  out[out.length - 1].value = value.minus(others);
  return out.map((s) => ({ locationId: s.locationId, qty: s.qty.toFixed(4), value: s.value.toFixed(2) }));
}

/** Ledger quantity − Σ site quantities of a multi-site holder (null when they agree to 4 decimals or it has no sites list). */
export function siteQtyDifference(h: { qty: Decimal | string }, sites: SiteQty[]): string | null {
  const siteQty = sites.reduce((a, s) => (Number(s.qty) > 0 ? a.plus(qty4(Number(s.qty))) : a), ZERO);
  const d = new Decimal(h.qty).minus(siteQty);
  return d.abs().lte("0.0001") ? null : d.toFixed(4);
}

export type GroupRow = { role: string; categoryId: string; value: string };
export type CategoryInfo = { id: string; nameAr: string; nameEn: string | null; parentId: string | null; sortOrder: number; inventoryRole: string };
export type CategoryGroup = {
  id: string; nameAr: string; nameEn: string | null; value: string; count: number;
  /** Holders filed directly on the root (finished lots; a material on a root category). */
  direct: { value: string; count: number; role: string | null };
  children: { id: string; nameAr: string; nameEn: string | null; role: string; value: string; count: number }[];
};

/** Root → sub-category subtotals, in the categories' order. Unknown ids (a deleted category) group under «بلا تصنيف». */
export function groupByCategory(rows: GroupRow[], cats: CategoryInfo[]): CategoryGroup[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const sums = new Map<string, { value: Decimal; count: number; roles: Set<string> }>();
  for (const r of rows) {
    const id = byId.has(r.categoryId) ? r.categoryId : "_none";
    const s = sums.get(id) ?? { value: ZERO, count: 0, roles: new Set<string>() };
    s.value = s.value.plus(r.value); s.count += 1; s.roles.add(r.role); sums.set(id, s);
  }
  const roots = cats.filter((c) => !c.parentId).sort((a, b) => a.sortOrder - b.sortOrder || a.nameAr.localeCompare(b.nameAr));
  const out: CategoryGroup[] = [];
  for (const root of roots) {
    const kids = cats.filter((c) => c.parentId === root.id).sort((a, b) => a.sortOrder - b.sortOrder || a.nameAr.localeCompare(b.nameAr));
    const children = kids.filter((k) => sums.has(k.id)).map((k) => { const s = sums.get(k.id)!; return { id: k.id, nameAr: k.nameAr, nameEn: k.nameEn, role: k.inventoryRole, value: s.value.toFixed(2), count: s.count }; });
    const d = sums.get(root.id);
    if (!children.length && !d) continue;
    const value = children.reduce((a, c) => a.plus(c.value), d?.value ?? ZERO);
    out.push({ id: root.id, nameAr: root.nameAr, nameEn: root.nameEn, value: value.toFixed(2), count: children.reduce((a, c) => a + c.count, d?.count ?? 0), direct: { value: (d?.value ?? ZERO).toFixed(2), count: d?.count ?? 0, role: d ? (d.roles.size === 1 ? [...d.roles][0] : null) : null }, children });
  }
  const none = sums.get("_none");
  if (none) out.push({ id: "_none", nameAr: "بلا تصنيف", nameEn: "Uncategorised", value: none.value.toFixed(2), count: none.count, direct: { value: none.value.toFixed(2), count: none.count, role: none.roles.size === 1 ? [...none.roles][0] : null }, children: [] });
  return out;
}

/** Σ value and count per inventory role (the account subtotals). */
export function totalsByRole(rows: { role: string; value: string }[], roles: readonly string[]): { role: string; value: string; count: number }[] {
  return roles.map((role) => {
    const mine = rows.filter((r) => r.role === role);
    return { role, value: mine.reduce((a, r) => a.plus(r.value), ZERO).toFixed(2), count: mine.length };
  });
}

/** Σ estimated value per location, and the value no site holds (holders with no site quantity — never negative). */
export function totalsByLocation(rows: { value: string; sites: SiteShare[] }[], locationIds: string[]): { byLocation: Map<string, { value: Decimal; count: number }>; unallocated: Decimal; unallocatedCount: number; total: Decimal } {
  const by = new Map<string, { value: Decimal; count: number }>(locationIds.map((id) => [id, { value: ZERO, count: 0 }]));
  let total = ZERO, unallocated = ZERO, unallocatedCount = 0;
  for (const r of rows) {
    total = total.plus(r.value);
    if (!r.sites.length) { if (!new Decimal(r.value).isZero()) { unallocated = unallocated.plus(r.value); unallocatedCount++; } continue; }
    for (const s of r.sites) {
      const e = by.get(s.locationId) ?? { value: ZERO, count: 0 };
      e.value = e.value.plus(s.value); e.count += 1; by.set(s.locationId, e);
    }
  }
  return { byLocation: by, unallocated, unallocatedCount, total };
}

/** Does a holder belong to a category filter (a root matches its own items and all its sub-categories')? */
export function inCategory(categoryId: string, filter: string | null, parentOf: Map<string, string | null>): boolean {
  if (!filter) return true;
  return categoryId === filter || parentOf.get(categoryId) === filter;
}
