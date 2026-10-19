/**
 * The purchases register's period and sort (Figma 221:748 «الفترة: آخر 90 يومًا», «الأحدث») — pure,
 * shared by the page, GET /api/purchases and its CSV export, unit-tested.
 */
export const PURCHASE_PERIODS = ["30", "90", "365", "all"] as const;
export type PurchasePeriod = (typeof PURCHASE_PERIODS)[number];
export const PURCHASE_SORTS = ["newest", "oldest", "cost", "qty"] as const;
export type PurchaseSort = (typeof PURCHASE_SORTS)[number];

export const parsePeriod = (v: string | null | undefined): PurchasePeriod =>
  (PURCHASE_PERIODS as readonly string[]).includes(v ?? "") ? (v as PurchasePeriod) : "90";
export const parseSort = (v: string | null | undefined): PurchaseSort =>
  (PURCHASE_SORTS as readonly string[]).includes(v ?? "") ? (v as PurchaseSort) : "newest";

/** The first instant inside the period: now − N days (null for «all»). */
export function periodStart(period: PurchasePeriod, now = new Date()): Date | null {
  if (period === "all") return null;
  return new Date(now.getTime() - Number(period) * 86_400_000);
}

type P = { purchaseDate: string | Date; totalCost: number; quantity: number; createdAt?: string | Date };
const ms = (d: string | Date) => (d instanceof Date ? d.getTime() : Date.parse(d));

export function sortPurchases<T extends P>(rows: T[], sort: PurchaseSort): T[] {
  const out = [...rows];
  const tie = (a: T, b: T) => ms(b.createdAt ?? b.purchaseDate) - ms(a.createdAt ?? a.purchaseDate);
  if (sort === "newest") out.sort((a, b) => ms(b.purchaseDate) - ms(a.purchaseDate) || tie(a, b));
  if (sort === "oldest") out.sort((a, b) => ms(a.purchaseDate) - ms(b.purchaseDate) || -tie(a, b));
  if (sort === "cost") out.sort((a, b) => b.totalCost - a.totalCost || tie(a, b));
  if (sort === "qty") out.sort((a, b) => b.quantity - a.quantity || tie(a, b));
  return out;
}

/** Metrics over a set: spend, kg, average SAR/kg (Σ cost / Σ kg — weighted, not a mean of prices). */
export function purchaseTotals(rows: P[]) {
  const spend = rows.reduce((s, p) => s + (Number.isFinite(p.totalCost) ? p.totalCost : 0), 0);
  const kg = rows.reduce((s, p) => s + (Number.isFinite(p.quantity) ? p.quantity : 0), 0);
  return { count: rows.length, spend: Number(spend.toFixed(2)), kg: Number(kg.toFixed(3)), avgPerKg: kg > 0 ? Number((spend / kg).toFixed(2)) : null };
}
