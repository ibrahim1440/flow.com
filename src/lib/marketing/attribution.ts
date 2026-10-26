// Attribution: which campaign gets credit for which store order. Pure.
//
// ── What this promises ──
// Every order's credit sums to exactly 1 (or 0 when it cannot be attributed), so adding the
// attributed revenue of every campaign gives back the attributed revenue of the store — never more.
// That is the difference from the platforms' own figures, where Meta and TikTok can both claim the
// same order: those are kept apart (kpi.ts platformRoas) and never summed here.
//
// ── Models ──
//   FIRST_TOUCH  the earliest touch inside the window gets 1.
//   LAST_TOUCH   the latest touch at or before the order gets 1 (default).
//   LINEAR       every distinct campaign touched inside the window shares equally.
// "Data-driven" needs path data and conversion volume this business does not have yet; it is
// refused with a reason rather than approximated (DATA_DRIVEN_UNAVAILABLE).
//
// Touches are what the system actually knows: the order's own UTM (from the store), WhatsApp
// messages the customer received and clicked, tracked links. A touch AFTER the order never counts.

export type AttributionModel = "FIRST_TOUCH" | "LAST_TOUCH" | "LINEAR";
export const ATTRIBUTION_MODELS: { key: AttributionModel | "DATA_DRIVEN"; ar: string; en: string; available: boolean; noteAr: string; noteEn: string }[] = [
  { key: "LAST_TOUCH", ar: "آخر نقطة تواصل", en: "Last touch", available: true, noteAr: "الحملة الأخيرة قبل الطلب تأخذ الطلب كاملاً.", noteEn: "The last campaign before the order takes the whole order." },
  { key: "FIRST_TOUCH", ar: "أول نقطة تواصل", en: "First touch", available: true, noteAr: "أول حملة داخل نافذة الإسناد تأخذ الطلب كاملاً.", noteEn: "The first campaign inside the attribution window takes the whole order." },
  { key: "LINEAR", ar: "توزيع متساوٍ", en: "Even split", available: true, noteAr: "تتقاسم كل الحملات داخل النافذة الطلب بالتساوي.", noteEn: "Every campaign inside the window shares the order equally." },
  { key: "DATA_DRIVEN", ar: "مبني على البيانات", en: "Data-driven", available: false, noteAr: "غير متاح: يحتاج بيانات مسارات وأحجام تحويل كافية لم تتوفر بعد.", noteEn: "Not available: it needs enough path and conversion volume data, which is not there yet." },
];

export type Touch = { at: Date; campaignId: string | null; channel: string };

export type AttributableOrder = {
  id: string;
  placedAt: Date;
  /** The campaign the order's own UTM resolved to, if any. */
  utmCampaignId: string | null;
  /** Touches of the same customer (phone / customer id), any order. */
  touches: Touch[];
};

export type Credit = { campaignId: string; share: number };

export type OrderAttribution = {
  orderId: string;
  credits: Credit[];
  /** Why there is no credit, when there is none. */
  unattributedReason: "NO_TOUCH" | "OUTSIDE_WINDOW" | null;
};

const DAY = 86_400_000;

export function attributeOrder(order: AttributableOrder, model: AttributionModel, windowDays: number): OrderAttribution {
  const all: Touch[] = [...order.touches];
  if (order.utmCampaignId) all.push({ at: order.placedAt, campaignId: order.utmCampaignId, channel: "UTM" });
  const before = all.filter((t) => t.campaignId && t.at.getTime() <= order.placedAt.getTime());
  if (before.length === 0) return { orderId: order.id, credits: [], unattributedReason: "NO_TOUCH" };
  const start = order.placedAt.getTime() - windowDays * DAY;
  const inWindow = before.filter((t) => t.at.getTime() >= start).sort((a, b) => a.at.getTime() - b.at.getTime());
  if (inWindow.length === 0) return { orderId: order.id, credits: [], unattributedReason: "OUTSIDE_WINDOW" };

  if (model === "FIRST_TOUCH") return { orderId: order.id, credits: [{ campaignId: inWindow[0].campaignId!, share: 1 }], unattributedReason: null };
  if (model === "LAST_TOUCH") return { orderId: order.id, credits: [{ campaignId: inWindow[inWindow.length - 1].campaignId!, share: 1 }], unattributedReason: null };
  const ids = [...new Set(inWindow.map((t) => t.campaignId!))];
  return { orderId: order.id, credits: ids.map((campaignId) => ({ campaignId, share: 1 / ids.length })), unattributedReason: null };
}

export type CampaignCredit = { campaignId: string; orders: number; revenue: number; newCustomers: number };

/**
 * Credit per campaign. `orders` and `newCustomers` are fractional under LINEAR (shares), and the
 * totals across campaigns plus `unattributed` equal the input — checked by the unit tests.
 */
export function aggregateCredit(
  results: OrderAttribution[],
  orderValue: Map<string, { revenue: number; isNew: boolean }>,
): { byCampaign: CampaignCredit[]; unattributed: { orders: number; revenue: number; noTouch: number; outsideWindow: number } } {
  const by = new Map<string, CampaignCredit>();
  const un = { orders: 0, revenue: 0, noTouch: 0, outsideWindow: 0 };
  for (const r of results) {
    const v = orderValue.get(r.orderId);
    if (!v) continue;
    if (r.credits.length === 0) {
      un.orders += 1;
      un.revenue += v.revenue;
      if (r.unattributedReason === "NO_TOUCH") un.noTouch += 1;
      else un.outsideWindow += 1;
      continue;
    }
    for (const c of r.credits) {
      const row = by.get(c.campaignId) ?? { campaignId: c.campaignId, orders: 0, revenue: 0, newCustomers: 0 };
      row.orders += c.share;
      row.revenue += v.revenue * c.share;
      if (v.isNew) row.newCustomers += c.share;
      by.set(c.campaignId, row);
    }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    byCampaign: [...by.values()].map((c) => ({ ...c, orders: r2(c.orders), revenue: r2(c.revenue), newCustomers: r2(c.newCustomers) })).sort((a, b) => b.revenue - a.revenue),
    unattributed: { ...un, revenue: r2(un.revenue) },
  };
}
