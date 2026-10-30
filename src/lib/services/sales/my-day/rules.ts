// «يومي» — the rules behind the rep's day, as pure functions (no database, no HTTP), so the screen, the API and the
// tests mean the same thing by every word on it (tests/sales/unit/my-day.test.ts). BATCH24-DESIGN.md §WP-B, owner
// decisions of 2026-10-30:
//
//   * kilograms, not riyals: tiers, growth, share of book and reorder are all measured in kg (an order carries no
//     price). SAR appears only for the target and the commission, which are collections-based.
//   * tiers are DERIVED here at read time from the rep's own book and never stored.
//   * no ranking between reps: everything below is about ONE book.
import { Decimal, ZERO, roundMoney, commissionOnCumulativeBase, type PlanRules } from "@/lib/services/commissions/engine";
import { bonusBracket, overTargetIncentive, type Components } from "@/lib/services/commissions/builder";
import { MONTHLY_KG_WINDOW_DAYS, isBusinessOrder, kgPerMonthOf, medianGapDays, type OrderRow } from "@/lib/services/customers/aggregates";
import { reorderStatus, type ReorderFactors, type ReorderState } from "@/lib/services/customers/reorder";

export const DAY = 86_400_000;
const RIYADH = 3 * 3_600_000;

// ─── Settings ────────────────────────────────────────────────────────────────────────────────

export type MyDaySettings = {
  tierVipTopPct: number; tierVipMinKgMonth: number; tierSmallMaxKgMonth: number;
  growthMinPct: number; growthMinKgMonth: number;
  contactDaysVip: number; contactDaysRegular: number; contactDaysSmall: number; contactDaysNew: number;
  /** Days before a contract's end its account owner is told (WP-C, SystemConfig.contractRenewalNoticeDays; NULL = 45). */
  contractRenewalNoticeDays: number;
  /** Days a LATE customer just contacted stays on the call list as «كلّمته — بانتظار الطلب» (SystemConfig.callAwaitDays; NULL = 3). */
  callAwaitDays: number;
};

/** The owner's values (BATCH24-DESIGN.md «Owner decisions»), also the column defaults of 20261206090000_sales_myday. */
export const DEFAULT_MY_DAY_SETTINGS: MyDaySettings = {
  tierVipTopPct: 20, tierVipMinKgMonth: 40, tierSmallMaxKgMonth: 10,
  growthMinPct: 20, growthMinKgMonth: 10,
  contactDaysVip: 14, contactDaysRegular: 30, contactDaysSmall: 60, contactDaysNew: 7,
  contractRenewalNoticeDays: 45,
  callAwaitDays: 3,
};

export const MY_DAY_SETTING_KEYS = Object.keys(DEFAULT_MY_DAY_SETTINGS) as (keyof MyDaySettings)[];

/** Bounds the API enforces (the same as the CHECK of the migration). */
export const MY_DAY_SETTING_BOUNDS: Record<keyof MyDaySettings, { min: number; max: number; int?: boolean; above0?: boolean }> = {
  tierVipTopPct: { min: 0, max: 100, above0: true },
  tierVipMinKgMonth: { min: 0, max: 100000 },
  tierSmallMaxKgMonth: { min: 0, max: 100000 },
  growthMinPct: { min: 0, max: 1000, above0: true },
  growthMinKgMonth: { min: 0, max: 100000 },
  contactDaysVip: { min: 1, max: 365, int: true },
  contactDaysRegular: { min: 1, max: 365, int: true },
  contactDaysSmall: { min: 1, max: 365, int: true },
  contactDaysNew: { min: 1, max: 365, int: true },
  contractRenewalNoticeDays: { min: 1, max: 365, int: true },
  callAwaitDays: { min: 1, max: 30, int: true },
};

/** A settings row (Decimals, numbers or strings) → numbers; anything missing is the default. */
export function settingsFrom(row: Partial<Record<keyof MyDaySettings, unknown>> | null | undefined): MyDaySettings {
  const out = { ...DEFAULT_MY_DAY_SETTINGS };
  for (const k of MY_DAY_SETTING_KEYS) {
    const v = row?.[k];
    const n = v === null || v === undefined ? NaN : Number(typeof v === "object" ? String(v) : v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/**
 * Validate a settings edit. Returns the full next settings or the first problem (Arabic and English).
 * Only the keys present in `patch` change.
 */
export function parseSettingsPatch(current: MyDaySettings, patch: Record<string, unknown>):
  { ok: true; next: MyDaySettings } | { ok: false; error: string; errorEn: string; field: string } {
  const next = { ...current };
  for (const k of MY_DAY_SETTING_KEYS) {
    if (!(k in patch)) continue;
    const raw = patch[k];
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    const b = MY_DAY_SETTING_BOUNDS[k];
    if (!Number.isFinite(n) || n < b.min || n > b.max || (b.above0 && n <= 0) || (b.int && !Number.isInteger(n))) {
      return { ok: false, field: k, error: `القيمة غير صحيحة (${b.int ? "رقم صحيح " : ""}من ${b.above0 ? "أكبر من " : ""}${b.min} إلى ${b.max}).`, errorEn: `${k} must be ${b.int ? "a whole number " : ""}between ${b.min} and ${b.max}.` };
    }
    next[k] = b.int ? n : Math.round(n * 100) / 100;
  }
  if (next.tierSmallMaxKgMonth >= next.tierVipMinKgMonth) {
    return { ok: false, field: "tierSmallMaxKgMonth", error: "حد «صغير» يجب أن يكون أقل من الحد الأدنى لـ VIP.", errorEn: "The «small» limit must be below the VIP floor." };
  }
  return { ok: true, next };
}

// ─── Kilograms per window ──────────────────────────────────────────────────────────────────────

/** Σ kg of the business orders in [from, to). */
export function kgBetween(orders: OrderRow[], from: number, to: number): { kg: number; orders: number } {
  let kg = 0; let n = 0;
  for (const o of orders) {
    const t = o.createdAt.getTime();
    if (!isBusinessOrder(o.status) || t < from || t >= to) continue;
    n += 1;
    for (const i of o.items) if (Number.isFinite(i.quantityKg)) kg += i.quantityKg;
  }
  return { kg: Math.round(kg * 1000) / 1000, orders: n };
}

/** The first instant (UTC) of the Riyadh month `offset` months from the one containing `now` (0 = this month). */
export function riyadhMonthStartAt(now: Date, offset: number): number {
  const r = new Date(now.getTime() + RIYADH);
  return Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + offset, 1) - RIYADH;
}

// ─── Tiers ───────────────────────────────────────────────────────────────────────────────────

/** QUIET «بدون طلبات حديثة»: no order in the last 90 days — outside the ranking, never «صغير» (council fix round 1). */
export type Tier = "VIP" | "REGULAR" | "SMALL" | "QUIET";
/** Under this many customers the book is too small for «top 20%»: the two floors decide alone. */
export const MIN_BOOK_FOR_PERCENTILE = 8;
export const TIER_WINDOW_DAYS = MONTHLY_KG_WINDOW_DAYS;

/**
 * The tier of each customer of ONE rep's book, by kg ordered in the last 90 days (kg/month = kg ÷ 3, `kgPerMonthOf`):
 *   QUIET   no order in the last 90 days — «بدون طلبات حديثة»; NOT counted in the ranking below (council fix round 1:
 *           a book full of dormant accounts would otherwise turn «top 20 %» into the floor alone);
 *   VIP     the top `tierVipTopPct` % of the ACTIVE book by kg (rank, ties at the boundary included) AND ≥ the VIP floor;
 *   SMALL   under the small limit;
 *   REGULAR everyone else.
 * With fewer than 8 active customers: VIP = at or above the floor, SMALL = under the limit.
 */
export function classifyTiers(book: { id: string; kg90: number }[], s: MyDaySettings): Map<string, Tier> {
  const out = new Map<string, Tier>();
  const sorted = [...book].filter((c) => c.kg90 > 0).sort((a, b) => b.kg90 - a.kg90);
  for (const c of book) if (!(c.kg90 > 0)) out.set(c.id, "QUIET");
  let cutoffKg = -Infinity;
  if (sorted.length >= MIN_BOOK_FOR_PERCENTILE) {
    const topCount = Math.max(1, Math.ceil((sorted.length * s.tierVipTopPct) / 100));
    cutoffKg = sorted[Math.min(topCount, sorted.length) - 1].kg90;
  }
  for (const c of sorted) {
    const perMonth = kgPerMonthOf(c.kg90);
    const inTop = sorted.length < MIN_BOOK_FOR_PERCENTILE || c.kg90 >= cutoffKg;
    if (inTop && perMonth >= s.tierVipMinKgMonth && perMonth > 0) out.set(c.id, "VIP");
    else if (perMonth < s.tierSmallMaxKgMonth) out.set(c.id, "SMALL");
    else out.set(c.id, "REGULAR");
  }
  return out;
}

// ─── Growth («ينمون معك») ───────────────────────────────────────────────────────────────────

export type Growth = { lastKg: number; prevKg: number; pct: number; perMonthUp: number; growing: boolean } | null;

/**
 * The last 3 FULL Riyadh months against the 3 before them. Shown only with ≥ 2 business orders in each window (else
 * null: «بيانات غير كافية»); growing = up ≥ `growthMinPct` % AND ≥ `growthMinKgMonth` kg/month.
 */
export function growthOf(orders: OrderRow[], now: Date, s: MyDaySettings): Growth {
  const m0 = riyadhMonthStartAt(now, 0), m3 = riyadhMonthStartAt(now, -3), m6 = riyadhMonthStartAt(now, -6);
  const last = kgBetween(orders, m3, m0);
  const prev = kgBetween(orders, m6, m3);
  if (last.orders < 2 || prev.orders < 2 || prev.kg <= 0) return null;
  const pct = ((last.kg - prev.kg) / prev.kg) * 100;
  const perMonthUp = (last.kg - prev.kg) / 3;
  return {
    lastKg: last.kg, prevKg: prev.kg, pct: Math.round(pct * 10) / 10, perMonthUp: Math.round(perMonthUp * 10) / 10,
    growing: pct >= s.growthMinPct && perMonthUp >= s.growthMinKgMonth,
  };
}

// ─── The call list («كلّمهم اليوم») ────────────────────────────────────────────────────────

export type CallReason =
  | { code: "LATE"; daysLate: number; intervalDays: number }
  | { code: "DUE"; intervalDays: number }
  | { code: "EXPECTED"; inDays: number; intervalDays: number }
  | { code: "SAMPLE"; daysSinceSent: number; sampleId: string; dealId: string }
  | { code: "FOLLOW_UP"; dealId: string; dealTitle: string; amount: string; overdueDays: number }
  | { code: "NO_CONTACT"; days: number | null; thresholdDays: number }
  /** A LATE customer the rep contacted since its last order, within `callAwaitDays`: «كلّمته — بانتظار الطلب». */
  | { code: "CALLED"; daysLate: number; intervalDays: number; calledDaysAgo: number; awaitDays: number };

export const SAMPLE_FEEDBACK_DAYS = 5;
export const EXPECTED_WITHIN_DAYS = 7;

export type BookCustomer = {
  id: string; name: string; nameAr: string | null; phone: string | null; city: string | null;
  createdAt: Date; reorderIntervalDays: number | null;
  orders: OrderRow[];
  firstOrderAt: Date | null;
  lastContactAt: Date | null; lastContactType: string | null;
  snoozedUntil: Date | null;
};

export type CustomerFacts = {
  id: string; createdAt: Date; name: string; nameAr: string | null; phone: string | null; city: string | null;
  kg90: number; kgPerMonth: number; tier: Tier; isNew: boolean;
  reorder: { state: ReorderState; intervalDays: number; daysSince: number; expectedAt: Date } | null;
  medianGapDays: number | null;
  growth: Growth;
  lastOrderAt: Date | null;
  lastContactAt: Date | null; lastContactType: string | null;
  contactThresholdDays: number;
  active: boolean;
  snoozed: boolean;
  contactedToday: boolean;
};

/** Riyadh midnight (UTC instant) of the day containing `now`, plus `days`. */
export function riyadhDayStart(now: Date, days = 0): Date {
  const r = new Date(now.getTime() + RIYADH);
  return new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate() + days) - RIYADH);
}

/** Everything the day says about one customer of the book. */
export function customerFacts(c: BookCustomer, tier: Tier, kg90: number, s: MyDaySettings, factors: ReorderFactors, now: Date): CustomerFacts {
  const status = reorderStatus(c.orders, c.reorderIntervalDays, factors, now);
  const median = c.reorderIntervalDays ?? medianGapDays(c.orders, now);
  const since90 = now.getTime() - TIER_WINDOW_DAYS * DAY;
  const firstAt = c.firstOrderAt ?? null;
  const isNew = firstAt ? firstAt.getTime() >= since90 : c.createdAt.getTime() >= since90;
  const business = c.orders.filter((o) => isBusinessOrder(o.status));
  const lastOrderAt = business.reduce<Date | null>((m, o) => (!m || o.createdAt > m ? o.createdAt : m), null);
  // «نشط»: an order within max(2 × its rhythm, 90 days).
  const window = Math.max(2 * (status?.intervalDays ?? 0), TIER_WINDOW_DAYS) * DAY;
  const active = !!lastOrderAt && now.getTime() - lastOrderAt.getTime() <= window;
  const threshold = isNew ? s.contactDaysNew : tier === "VIP" ? s.contactDaysVip : tier === "SMALL" || tier === "QUIET" ? s.contactDaysSmall : s.contactDaysRegular;
  return {
    id: c.id, createdAt: c.createdAt, name: c.name, nameAr: c.nameAr, phone: c.phone, city: c.city,
    kg90, kgPerMonth: kgPerMonthOf(kg90), tier, isNew,
    reorder: status ? { state: status.state, intervalDays: status.intervalDays, daysSince: status.daysSince, expectedAt: status.expectedAt } : null,
    medianGapDays: median,
    growth: growthOf(c.orders, now, s),
    lastOrderAt,
    lastContactAt: c.lastContactAt, lastContactType: c.lastContactType,
    contactThresholdDays: threshold,
    active,
    snoozed: !!c.snoozedUntil && c.snoozedUntil.getTime() > now.getTime(),
    contactedToday: !!c.lastContactAt && c.lastContactAt.getTime() >= riyadhDayStart(now).getTime(),
  };
}

export type DealRow = {
  id: string; title: string; amount: string; customerId: string | null; customerName: string | null; customerNameAr: string | null;
  customerPhone: string | null; nextFollowUpAt: Date | null; purpose: string | null; stageAr: string; stageEn: string;
};
export type SampleRow = { id: string; dealId: string; customerId: string | null; sentAt: Date; description: string };

export type CallItem = {
  key: string; customerId: string | null; name: string; nameAr: string | null; phone: string | null;
  tier: Tier | null; kgPerMonth: number; reason: CallReason; others: CallReason["code"][];
  score: number; ratio: number;
  /** The customer's usual rhythm and last contact, for the one-line «why». */
  intervalDays: number | null; lastContactDays: number | null;
};

const days = (a: number, b: number) => Math.floor((b - a) / DAY);

/**
 * The call list: every reason a customer of the book (or a deal of the rep) wants a call today, ONE row per customer
 * with its strongest reason, ranked by lateness ratio × kg/month (VIP first on ties). Snoozed customers and customers
 * already contacted today are not on it — except a LATE customer contacted since its last order, which stays for
 * `awaitDays` as CALLED («كلّمته — بانتظار الطلب», council fix round 2, item 7), at the bottom of the list.
 *
 *   LATE / DUE   the reorder state (services/customers/reorder.ts: interval × 1.3 late, the interval due);
 *   EXPECTED     ON_TRACK, but the MEDIAN gap says the next order is within 7 days (and half the rhythm has passed);
 *   SAMPLE       a sample sent ≥ 5 days ago with no feedback recorded;
 *   FOLLOW_UP    a deal's next follow-up is due (today or before);
 *   NO_CONTACT   no completed contact (call, visit, meeting, WhatsApp, email; «no answer» does not count) for longer
 *                than the tier's threshold — 7 days for a new customer in its first 90 days.
 */
export function buildCallList(facts: CustomerFacts[], deals: DealRow[], samples: SampleRow[], now: Date,
  awaitDays: number = DEFAULT_MY_DAY_SETTINGS.callAwaitDays): CallItem[] {
  const t = now.getTime();
  const endOfToday = riyadhDayStart(now, 1).getTime();
  const byCustomer = new Map(facts.map((f) => [f.id, f]));
  const cands: { key: string; f: CustomerFacts | null; deal: DealRow | null; reason: CallReason; ratio: number }[] = [];

  for (const f of facts) {
    const r = f.reorder;
    // «كلّمته — بانتظار الطلب» (council fix round 2, item 7): a LATE customer contacted SINCE its last order stays on the
    // list, marked called and awaiting the order, for `awaitDays` days — at the bottom, nothing to do. An order ends it
    // (the customer is no longer late); after `awaitDays` with no order it is a late customer to call again.
    if (r && r.state === "LATE" && f.lastContactAt && (!f.lastOrderAt || f.lastContactAt.getTime() > f.lastOrderAt.getTime())
      && t - f.lastContactAt.getTime() < awaitDays * DAY) {
      cands.push({ key: f.id, f, deal: null, ratio: 0, reason: {
        code: "CALLED", daysLate: Math.max(0, r.daysSince - r.intervalDays), intervalDays: r.intervalDays,
        calledDaysAgo: days(f.lastContactAt.getTime(), t), awaitDays,
      } });
      continue;
    }
    if (r && r.state === "LATE") cands.push({ key: f.id, f, deal: null, ratio: r.daysSince / r.intervalDays, reason: { code: "LATE", daysLate: Math.max(0, r.daysSince - r.intervalDays), intervalDays: r.intervalDays } });
    else if (r && r.state === "DUE") cands.push({ key: f.id, f, deal: null, ratio: Math.max(1, r.daysSince / r.intervalDays), reason: { code: "DUE", intervalDays: r.intervalDays } });
    else if (r && r.state === "ON_TRACK" && f.medianGapDays && f.lastOrderAt) {
      const expected = f.lastOrderAt.getTime() + f.medianGapDays * DAY;
      const inDays = Math.ceil((expected - t) / DAY);
      // Within 7 days — and past half the rhythm: a café on a 10-day cycle is «expected within 7 days» the day after
      // every order, which is noise, not a reason to call.
      if (inDays >= 0 && inDays <= Math.min(EXPECTED_WITHIN_DAYS, Math.floor(f.medianGapDays / 2))) {
        cands.push({ key: f.id, f, deal: null, ratio: r.daysSince / f.medianGapDays, reason: { code: "EXPECTED", inDays, intervalDays: f.medianGapDays } });
      }
    }
    const since = f.lastContactAt ? days(f.lastContactAt.getTime(), t) : null;
    // Never contacted: measured from the last order, else from when the customer was opened — and only for a customer
    // who is buying or new (a stopped account with no contact at all is the «متوقفين» count, not a daily call).
    const measured = since ?? (f.active || f.isNew ? days((f.lastOrderAt ?? f.createdAt).getTime(), t) : null);
    if (measured !== null && measured > f.contactThresholdDays) {
      cands.push({ key: f.id, f, deal: null, ratio: measured / f.contactThresholdDays, reason: { code: "NO_CONTACT", days: since, thresholdDays: f.contactThresholdDays } });
    }
  }
  for (const s of samples) {
    const d = days(s.sentAt.getTime(), t);
    if (d < SAMPLE_FEEDBACK_DAYS) continue;
    const f = s.customerId ? byCustomer.get(s.customerId) ?? null : null;
    const deal = deals.find((x) => x.id === s.dealId) ?? null;
    cands.push({ key: s.customerId ?? `deal:${s.dealId}`, f, deal, ratio: d / SAMPLE_FEEDBACK_DAYS, reason: { code: "SAMPLE", daysSinceSent: d, sampleId: s.id, dealId: s.dealId } });
  }
  for (const d of deals) {
    if (!d.nextFollowUpAt || d.nextFollowUpAt.getTime() >= endOfToday) continue;
    const f = d.customerId ? byCustomer.get(d.customerId) ?? null : null;
    const overdue = Math.max(0, days(d.nextFollowUpAt.getTime(), t));
    cands.push({ key: d.customerId ?? `deal:${d.id}`, f, deal: d, ratio: 1 + overdue / 7, reason: { code: "FOLLOW_UP", dealId: d.id, dealTitle: d.title, amount: d.amount, overdueDays: overdue } });
  }

  const tierRank = (x: Tier | null) => (x === "VIP" ? 0 : x === "REGULAR" ? 1 : x === "SMALL" ? 2 : x === "QUIET" ? 3 : 4);
  const scored = cands
    .filter((c) => c.reason.code === "CALLED" ? !c.f?.snoozed : !(c.f?.snoozed || c.f?.contactedToday))
    .map((c) => ({ ...c, score: c.ratio * Math.max(1, c.f?.kgPerMonth ?? 0) }));
  const best = new Map<string, (typeof scored)[number] & { others: CallReason["code"][] }>();
  // On an equal score the more concrete reason names the row: an order that is late says more than «no contact».
  const PRIORITY: CallReason["code"][] = ["LATE", "FOLLOW_UP", "SAMPLE", "DUE", "EXPECTED", "NO_CONTACT", "CALLED"];
  const stronger = (a: { score: number; reason: CallReason }, b: { score: number; reason: CallReason }) =>
    Math.abs(a.score - b.score) > 1e-9 ? a.score > b.score : PRIORITY.indexOf(a.reason.code) < PRIORITY.indexOf(b.reason.code);
  for (const c of scored) {
    const cur = best.get(c.key);
    if (!cur) { best.set(c.key, { ...c, others: [] }); continue; }
    if (stronger(c, cur)) best.set(c.key, { ...c, others: [...cur.others, cur.reason.code] });
    else cur.others.push(c.reason.code);
  }
  return [...best.values()]
    .map((c): CallItem => ({
      key: c.key,
      customerId: c.f?.id ?? c.deal?.customerId ?? null,
      name: c.f?.name ?? c.deal?.customerName ?? c.deal?.title ?? "",
      nameAr: c.f?.nameAr ?? c.deal?.customerNameAr ?? null,
      phone: c.f?.phone ?? c.deal?.customerPhone ?? null,
      tier: c.f?.tier ?? null,
      kgPerMonth: c.f?.kgPerMonth ?? 0,
      reason: c.reason, others: [...new Set(c.others)].filter((o) => o !== c.reason.code),
      score: Math.round(c.score * 1000) / 1000, ratio: Math.round(c.ratio * 1000) / 1000,
      intervalDays: c.f?.reorder?.intervalDays ?? c.f?.medianGapDays ?? null,
      lastContactDays: c.f?.lastContactAt ? days(c.f.lastContactAt.getTime(), t) : null,
    }))
    // The «awaiting the order» rows close the list: everything above them still wants a call.
    .sort((a, b) => Number(a.reason.code === "CALLED") - Number(b.reason.code === "CALLED")
      || b.score - a.score || tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name));
}


// ─── Target, streak and the commission estimate ──────────────────────────────────────────────

/**
 * «سلسلة أسابيعك»: how many completed Riyadh weeks (Sunday–Saturday) in a row, counting back from last week, the rep
 * collected at least 80 % of the week's share of that month's target (target × 7 ÷ days in the month). A week with no
 * target set is the end of the streak. Personal only — never compared with anybody.
 */
export function weeklyStreak(collections: { at: Date; amount: number }[], targetFor: (monthStart: number) => number | null, now: Date, maxWeeks = 26): number {
  const today = riyadhDayStart(now).getTime();
  const r = new Date(today + RIYADH);
  const thisWeekStart = today - r.getUTCDay() * DAY; // Sunday
  let streak = 0;
  for (let w = 1; w <= maxWeeks; w++) {
    const from = thisWeekStart - w * 7 * DAY, to = from + 7 * DAY;
    const mid = new Date(from + 3 * DAY);
    const monthStart = riyadhMonthStartAt(mid, 0);
    const target = targetFor(monthStart);
    if (!target || target <= 0) break;
    const daysInMonth = Math.round((riyadhMonthStartAt(mid, 1) - monthStart) / DAY);
    const weekTarget = (target * 7) / daysInMonth;
    const got = collections.filter((c) => c.at.getTime() >= from && c.at.getTime() < to).reduce((a, c) => a + c.amount, 0);
    if (got < weekTarget * 0.8) break;
    streak += 1;
  }
  return streak;
}

export type PlanForEstimate =
  | { kind: "TIERED"; rules: PlanRules }
  | { kind: "COMPONENTS"; components: Components }
  | null;

/**
 * «متوقعة لو وصلت الهدف» — an ESTIMATE, labelled «تقدير» wherever it is shown, never a payable:
 *   TIERED plan      the plan's commission on a month base of max(target, collected);
 *   COMPONENTS plan  (council fix round 1, H2) the engine's own figures, never counted twice:
 *       accrued now
 *     − the target bonus and over-target incentive ALREADY inside it (the engine accrues them: totalVariable,
 *       commissions/builder.ts), computed on the month's QUALIFIED collections `qualifiedNow` exactly as the engine does
 *       (`achievementBase`: all collected, or new-client sales only)
 *     + the rest of the target at the existing-client rate (the conservative row: nobody can know which collections
 *       will be new clients)
 *     + the bonus and incentive on the PROJECTED qualified base: + the rest of the target when everything collected
 *       counts; unchanged when only new-client sales count (the rest is assumed existing clients).
 *     A DISCRETIONARY bracket is a management decision: it is NOT counted and `discretionary` says so.
 *   With `collected ≥ target` nothing is left to collect, so the estimate is what is accrued.
 * Null without a target or a plan.
 */
export function estimateAtTarget(plan: PlanForEstimate, target: Decimal | null, collected: Decimal, accrued: Decimal, qualifiedNow?: Decimal | null):
  { amount: Decimal; discretionary: boolean } | null {
  if (!plan || !target || target.lessThanOrEqualTo(0)) return null;
  if (plan.kind === "TIERED") return { amount: commissionOnCumulativeBase(Decimal.max(target, collected), plan.rules).amount, discretionary: false };
  const c = plan.components;
  const allCounts = c.achievementBase === "ALL_COLLECTED" || !c.orderSequence.enabled;
  const qNow = qualifiedNow ?? (allCounts ? collected : ZERO);
  const remaining = Decimal.max(ZERO, target.minus(collected));
  const rate = c.orderSequence.enabled ? new Decimal(c.orderSequence.existingClientRatePercent) : ZERO;
  const qAt = allCounts ? qNow.plus(remaining) : qNow;
  const bonusOn = (q: Decimal) => {
    const hit = bonusBracket(c, q, target);
    const fixed = hit?.kind === "FIXED" ? hit.planAmount : ZERO;
    return { amount: fixed.plus(overTargetIncentive(c, q, target).exact), discretionary: hit?.kind === "DISCRETIONARY" };
  };
  const included = bonusOn(qNow);
  const projected = bonusOn(qAt);
  const amount = Decimal.max(ZERO, accrued.minus(included.amount)).plus(remaining.times(rate).dividedBy(100)).plus(projected.amount);
  return { amount: roundMoney(Decimal.max(amount, accrued)), discretionary: projected.discretionary };
}

/** Whole days left in the Riyadh month, today included. */
export function daysLeftInMonth(now: Date): number {
  return Math.max(1, Math.round((riyadhMonthStartAt(now, 1) - riyadhDayStart(now).getTime()) / DAY));
}
