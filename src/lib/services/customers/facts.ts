/**
 * The customer page's facts row (batch 24 WP-A §3): «آخر تواصل», «يطلب عادةً», «آخر طلب», «عليه».
 * Pure, from what GET /api/customers/[id]/account already returns — no new query, no new figure.
 */

/** The kinds of activity that are contact with the customer: «واتساب» and «بريد» are WHATSAPP / EMAIL (20261206090000_sales_myday). */
export const CONTACT_TYPES = new Set(["CALL", "VISIT", "MEETING", "WHATSAPP", "EMAIL"]);

export type ContactActivity = { type: string; outcome: string | null; subject: string | null; completedAt: string | Date | null };

export function isContact(a: ContactActivity): boolean {
  if (!a.completedAt) return false;
  if (a.outcome === "NO_ANSWER") return false;
  return CONTACT_TYPES.has(a.type);
}

/** The most recent completed contact (no «لا رد»), or null. */
export function lastContact<T extends ContactActivity>(activities: readonly T[]): T | null {
  let best: T | null = null;
  for (const a of activities) {
    if (!isContact(a)) continue;
    if (!best || new Date(a.completedAt!).getTime() > new Date(best.completedAt!).getTime()) best = a;
  }
  return best;
}

/** The kind word for the facts row: «اتصال», «زيارة», «واتساب»… */
export function contactKind(a: ContactActivity, ar: boolean): string {
  const t = a.type;
  const m: Record<string, [string, string]> = {
    CALL: ["اتصال", "call"], VISIT: ["زيارة", "visit"], MEETING: ["اجتماع", "meeting"], WHATSAPP: ["واتساب", "WhatsApp"], EMAIL: ["بريد", "email"],
  };
  const w = m[t] ?? ["تواصل", "contact"];
  return ar ? w[0] : w[1];
}

/**
 * The usual order size: the median kilograms of the customer's last six orders that were not cancelled
 * or rejected, rounded to a whole kilogram; null with no such order.
 */
export function usualOrderKg(orders: readonly { totalKg: number; status: string; createdAt: string | Date }[]): number | null {
  const kept = orders
    .filter((o) => !["Cancelled", "Rejected"].includes(o.status) && o.totalKg > 0)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 6)
    .map((o) => o.totalKg)
    .sort((a, b) => a - b);
  if (!kept.length) return null;
  const mid = Math.floor(kept.length / 2);
  const med = kept.length % 2 ? kept[mid] : (kept[mid - 1] + kept[mid]) / 2;
  return Math.max(1, Math.round(med));
}
