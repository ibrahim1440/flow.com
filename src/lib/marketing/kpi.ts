// The KPI dictionary and the one place every marketing figure is computed.
//
// Pure (no server, no database): shared by the services, the screens, the reports and the tests.
//
// ── Three rules that every function here keeps ──
//   1. Missing is not zero. An input that a platform did not report is `null`, and any figure
//      that depends on it is `null` — the screen shows «غير متاح». A ratio whose denominator is 0
//      is also `null` (CTR of 0 impressions is not 0%, it is undefined).
//   2. Like with like. Link clicks are never mixed with all clicks, conversions with unique
//      customers, or gross revenue with net revenue: each has its own key and its own formula.
//   3. Platform-reported conversion value is the PLATFORM's attribution. It is kept per platform
//      and never summed across platforms into "revenue" — revenue comes from store orders only.

export type Num = number | null;

export type KpiKey =
  | "spend" | "impressions" | "reach" | "frequency" | "clicks" | "linkClicks" | "ctr" | "linkCtr" | "cpc" | "cpm"
  | "videoViews" | "engagementRate" | "followerGrowth" | "landingPageViews" | "leads" | "purchases" | "orders"
  | "newCustomers" | "cvr" | "cpa" | "cac" | "aov" | "grossRevenue" | "netRevenue" | "roas" | "platformRoas" | "mer"
  | "grossMargin" | "contributionMargin" | "marketingRoi" | "repeatPurchaseRate" | "breakEvenRoas";

export type KpiDef = {
  key: KpiKey;
  ar: string;
  en: string;
  /** How it is computed, in words the owner can check. */
  formulaAr: string;
  formulaEn: string;
  /** Where its inputs come from. */
  sourceAr: string;
  sourceEn: string;
  unit: "SAR" | "count" | "pct" | "ratio" | "x";
  /** Whether a higher value is better (for colouring comparisons), null when it depends. */
  higherIsBetter: boolean | null;
  /** What to be careful about. */
  caveatAr?: string;
  caveatEn?: string;
  /**
   * The standard abbreviation (owner language decision 4): the Arabic name carries it in brackets,
   * «تكلفة اكتساب العميل (CAC)», so the Arabic screens, tiles, tables and the glossary all show it.
   */
  abbr?: string;
};

const ADS = "منصات الإعلان (API أو إدخال يدوي موثّق)";
const STORE = "طلبات المتجر الإلكتروني بعد استبعاد الملغاة";
const ADS_EN = "Ad platforms (API or documented manual entry)";
const STORE_EN = "Online store orders, cancelled ones excluded";

export const KPI_DICTIONARY: KpiDef[] = [
  { key: "spend", ar: "الإنفاق", en: "Spend", formulaAr: "مجموع الإنفاق المبلّغ عنه لكل يوم وحملة", formulaEn: "Sum of reported daily spend", sourceAr: ADS, sourceEn: ADS_EN, unit: "SAR", higherIsBetter: null },
  { key: "impressions", ar: "مرات الظهور", en: "Impressions", formulaAr: "مجموع مرات الظهور", formulaEn: "Sum of impressions", sourceAr: ADS, sourceEn: ADS_EN, unit: "count", higherIsBetter: true },
  { key: "reach", ar: "الوصول", en: "Reach", formulaAr: "الأشخاص الفريدون كما تبلّغ المنصة لليوم", formulaEn: "Unique people as reported per day", sourceAr: ADS, sourceEn: ADS_EN, unit: "count", higherIsBetter: true, caveatAr: "الوصول اليومي لا يُجمع إلى وصول فريد للفترة؛ المجموع تقريبي ويظهر كحد أعلى.", caveatEn: "Daily reach does not add up to unique reach for the period; the total is approximate and shown as an upper bound." },
  { key: "frequency", ar: "معدل التكرار", en: "Frequency", formulaAr: "مرات الظهور ÷ الوصول", formulaEn: "Impressions ÷ reach", sourceAr: ADS, sourceEn: ADS_EN, unit: "x", higherIsBetter: null, caveatAr: "يعتمد على وصول الفترة؛ عند جمع الوصول اليومي يكون أقل من الحقيقي.", caveatEn: "Depends on the period's reach; when daily reach is summed it reads lower than the real figure." },
  { key: "clicks", ar: "النقرات (كل النقرات)", en: "Clicks (all)", formulaAr: "كل النقرات على الإعلان بما فيها الملف والتفاعل", formulaEn: "All clicks incl. profile & engagement", sourceAr: ADS, sourceEn: ADS_EN, unit: "count", higherIsBetter: true },
  { key: "linkClicks", ar: "نقرات الرابط", en: "Link clicks", formulaAr: "النقرات التي تفتح الرابط فقط", formulaEn: "Clicks that open the link", sourceAr: ADS, sourceEn: ADS_EN, unit: "count", higherIsBetter: true, caveatAr: "لا تُخلط بالنقرات الإجمالية.", caveatEn: "Not to be mixed with all clicks." },
  { key: "ctr", ar: "نسبة النقر لكل النقرات (CTR)", en: "CTR (all)", abbr: "CTR", formulaAr: "النقرات ÷ مرات الظهور × 100", formulaEn: "Clicks ÷ impressions × 100", sourceAr: ADS, sourceEn: ADS_EN, unit: "pct", higherIsBetter: true },
  { key: "linkCtr", ar: "نسبة نقر الرابط (Link CTR)", en: "Link CTR", abbr: "Link CTR", formulaAr: "نقرات الرابط ÷ مرات الظهور × 100", formulaEn: "Link clicks ÷ impressions × 100", sourceAr: ADS, sourceEn: ADS_EN, unit: "pct", higherIsBetter: true },
  { key: "cpc", ar: "تكلفة نقرة الرابط (CPC)", en: "CPC (link)", abbr: "CPC", formulaAr: "الإنفاق ÷ نقرات الرابط", formulaEn: "Spend ÷ link clicks", sourceAr: ADS, sourceEn: ADS_EN, unit: "SAR", higherIsBetter: false },
  { key: "cpm", ar: "تكلفة الألف ظهور (CPM)", en: "CPM", abbr: "CPM", formulaAr: "الإنفاق ÷ مرات الظهور × 1000", formulaEn: "Spend ÷ impressions × 1000", sourceAr: ADS, sourceEn: ADS_EN, unit: "SAR", higherIsBetter: false },
  { key: "videoViews", ar: "مشاهدات الفيديو", en: "Video views", formulaAr: "كما تعرّفها كل منصة (تختلف مدة المشاهدة)", formulaEn: "As each platform defines it", sourceAr: ADS, sourceEn: ADS_EN, unit: "count", higherIsBetter: true, caveatAr: "تعريف المشاهدة يختلف بين المنصات؛ لا تقارن المنصات بها مباشرة.", caveatEn: "A view is defined differently by each platform; do not compare platforms on it directly." },
  { key: "engagementRate", ar: "معدل التفاعل", en: "Engagement rate", formulaAr: "التفاعلات ÷ الوصول × 100", formulaEn: "Engagements ÷ reach × 100", sourceAr: "المنصات (عضوي وإعلاني)", sourceEn: "Platforms (organic and paid)", unit: "pct", higherIsBetter: true },
  { key: "followerGrowth", ar: "نمو المتابعين", en: "Follower growth", formulaAr: "مجموع صافي تغيّر المتابعين في الفترة", formulaEn: "Net follower change", sourceAr: "المنصات (عضوي)", sourceEn: "Platforms (organic)", unit: "count", higherIsBetter: true },
  { key: "landingPageViews", ar: "مشاهدات صفحة الهبوط", en: "Landing page views", formulaAr: "كما يبلّغ البكسل/المنصة", formulaEn: "As reported by pixel/platform", sourceAr: ADS, sourceEn: ADS_EN, unit: "count", higherIsBetter: true },
  { key: "leads", ar: "العملاء المحتملون", en: "Leads", formulaAr: "نماذج/عملاء محتملون مبلّغ عنهم", formulaEn: "Reported leads", sourceAr: ADS, sourceEn: ADS_EN, unit: "count", higherIsBetter: true },
  { key: "purchases", ar: "عمليات الشراء (حسب المنصة)", en: "Purchases (platform)", formulaAr: "تحويلات الشراء كما تنسبها المنصة لنفسها", formulaEn: "Platform-attributed purchase conversions", sourceAr: ADS, sourceEn: ADS_EN, unit: "count", higherIsBetter: true, caveatAr: "إسناد المنصة؛ قد تحتسب منصتان الطلب نفسه. لا تُجمع عبر المنصات.", caveatEn: "The platform's own attribution; two platforms may count the same order. Not summed across platforms." },
  { key: "orders", ar: "الطلبات", en: "Orders", formulaAr: "طلبات المتجر غير الملغاة في الفترة", formulaEn: "Non-cancelled store orders", sourceAr: STORE, sourceEn: STORE_EN, unit: "count", higherIsBetter: true },
  { key: "newCustomers", ar: "العملاء الجدد", en: "New customers", formulaAr: "العملاء الذين كان طلبهم الأول في الفترة (فريدون)", formulaEn: "Customers whose first order is in the period", sourceAr: STORE, sourceEn: STORE_EN, unit: "count", higherIsBetter: true, caveatAr: "عدد عملاء فريدين، لا عدد تحويلات.", caveatEn: "A count of unique customers, not of conversions." },
  { key: "cvr", ar: "معدل التحويل (CVR)", en: "Conversion rate", abbr: "CVR", formulaAr: "الطلبات المنسوبة ÷ نقرات الرابط × 100", formulaEn: "Attributed orders ÷ link clicks × 100", sourceAr: `${STORE} + ${ADS}`, sourceEn: `${STORE_EN} + ${ADS_EN}`, unit: "pct", higherIsBetter: true },
  { key: "cpa", ar: "تكلفة الطلب (CPA)", en: "CPA", abbr: "CPA", formulaAr: "الإنفاق ÷ الطلبات المنسوبة", formulaEn: "Spend ÷ attributed orders", sourceAr: `${STORE} + ${ADS}`, sourceEn: `${STORE_EN} + ${ADS_EN}`, unit: "SAR", higherIsBetter: false },
  { key: "cac", ar: "تكلفة اكتساب العميل (CAC)", en: "CAC", abbr: "CAC", formulaAr: "الإنفاق ÷ العملاء الجدد المنسوبون", formulaEn: "Spend ÷ attributed new customers", sourceAr: `${STORE} + ${ADS}`, sourceEn: `${STORE_EN} + ${ADS_EN}`, unit: "SAR", higherIsBetter: false, caveatAr: "على مستوى المنشأة يُقسم إجمالي الإنفاق التسويقي على كل العملاء الجدد (تكلفة اكتساب مجمّعة، Blended CAC).", caveatEn: "At company level, total marketing spend is divided by all new customers (blended CAC)." },
  { key: "aov", ar: "متوسط قيمة الطلب (AOV)", en: "AOV", abbr: "AOV", formulaAr: "صافي الإيراد ÷ الطلبات", formulaEn: "Net revenue ÷ orders", sourceAr: STORE, sourceEn: STORE_EN, unit: "SAR", higherIsBetter: true },
  { key: "grossRevenue", ar: "الإيراد الإجمالي", en: "Gross revenue", formulaAr: "مجموع إجمالي الطلبات غير الملغاة (شامل الشحن والضريبة كما في المتجر)", formulaEn: "Sum of non-cancelled order totals", sourceAr: STORE, sourceEn: STORE_EN, unit: "SAR", higherIsBetter: true },
  { key: "netRevenue", ar: "صافي الإيراد", en: "Net revenue", formulaAr: "الإجمالي − المبالغ المستردة − الضريبة − الشحن", formulaEn: "Gross − refunds − tax − shipping", sourceAr: STORE, sourceEn: STORE_EN, unit: "SAR", higherIsBetter: true, caveatAr: "إذا لم يبلّغ المتجر الضريبة أو الشحن يكون صافي الإيراد غير متاح.", caveatEn: "If the store does not report tax or shipping, net revenue is not available." },
  { key: "roas", ar: "العائد على الإنفاق الإعلاني (ROAS)", en: "ROAS", abbr: "ROAS", formulaAr: "صافي الإيراد المنسوب ÷ الإنفاق", formulaEn: "Attributed net revenue ÷ spend", sourceAr: `${STORE} + ${ADS}`, sourceEn: `${STORE_EN} + ${ADS_EN}`, unit: "x", higherIsBetter: true },
  { key: "platformRoas", ar: "عائد الإنفاق حسب المنصة (Platform ROAS)", en: "Platform ROAS", abbr: "Platform ROAS", formulaAr: "قيمة التحويل التي تنسبها المنصة لنفسها ÷ إنفاقها", formulaEn: "Platform conversion value ÷ its spend", sourceAr: ADS, sourceEn: ADS_EN, unit: "x", higherIsBetter: true, caveatAr: "رقم المنصة نفسها؛ يُعرض للمقارنة ولا يُجمع.", caveatEn: "The platform's own figure; shown for comparison and never summed." },
  { key: "mer", ar: "كفاءة التسويق (MER)", en: "MER", abbr: "MER", formulaAr: "صافي إيراد المتجر كله ÷ إجمالي الإنفاق التسويقي", formulaEn: "Total net revenue ÷ total marketing spend", sourceAr: `${STORE} + ${ADS} + تكلفة الرسائل`, sourceEn: `${STORE_EN} + ${ADS_EN} + messaging cost`, unit: "x", higherIsBetter: true },
  { key: "grossMargin", ar: "هامش الربح الإجمالي", en: "Gross margin", formulaAr: "صافي الإيراد × نسبة الهامش الإجمالي للمنتج", formulaEn: "Net revenue × product gross margin %", sourceAr: "اقتصاديات المنتج المدخلة في الإعدادات", sourceEn: "Product economics entered in settings", unit: "SAR", higherIsBetter: true },
  { key: "contributionMargin", ar: "هامش المساهمة", en: "Contribution margin", formulaAr: "الهامش الإجمالي − التكاليف المتغيرة لكل طلب − الإنفاق التسويقي", formulaEn: "Gross margin − variable costs − marketing spend", sourceAr: "اقتصاديات المنتج + الطلبات + الإنفاق", sourceEn: "Product economics + orders + spend", unit: "SAR", higherIsBetter: true },
  { key: "marketingRoi", ar: "عائد الاستثمار التسويقي (ROI)", en: "Marketing ROI", abbr: "ROI", formulaAr: "(الهامش الإجمالي المنسوب − الإنفاق) ÷ الإنفاق × 100", formulaEn: "(Attributed gross margin − spend) ÷ spend × 100", sourceAr: "اقتصاديات المنتج + الطلبات + الإنفاق", sourceEn: "Product economics + orders + spend", unit: "pct", higherIsBetter: true },
  { key: "repeatPurchaseRate", ar: "معدل تكرار الشراء", en: "Repeat purchase rate", formulaAr: "العملاء الذين لهم أكثر من طلب ÷ العملاء الذين طلبوا في الفترة × 100", formulaEn: "Customers with 2+ orders ÷ ordering customers × 100", sourceAr: STORE, sourceEn: STORE_EN, unit: "pct", higherIsBetter: true },
  { key: "breakEvenRoas", ar: "نقطة تعادل العائد (Break-even ROAS)", en: "Break-even ROAS", abbr: "Break-even ROAS", formulaAr: "1 ÷ (نسبة الهامش الإجمالي − التكاليف المتغيرة ÷ متوسط الطلب)", formulaEn: "1 ÷ contribution margin ratio before ads", sourceAr: "اقتصاديات المنتج", sourceEn: "Product economics", unit: "x", higherIsBetter: null },
];

export const KPI: Record<KpiKey, KpiDef> = Object.fromEntries(KPI_DICTIONARY.map((d) => [d.key, d])) as Record<KpiKey, KpiDef>;

// ── Arithmetic that keeps "unknown" unknown ──────────────────────────────────────────────────

/** Sum where any reported value counts; all-null stays null (nothing was reported). */
export function sumN(values: Num[]): Num {
  let seen = false;
  let total = 0;
  for (const v of values) {
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    seen = true;
    total += v;
  }
  return seen ? round(total, 6) : null;
}

/** a ÷ b; null when either is unknown or b is 0. */
export function ratio(a: Num, b: Num): Num {
  if (a === null || b === null || a === undefined || b === undefined) return null;
  if (b === 0) return null;
  return a / b;
}

export function pct(a: Num, b: Num): Num {
  const r = ratio(a, b);
  return r === null ? null : r * 100;
}

export function round(v: number, places = 2): number {
  const f = 10 ** places;
  return Math.round((v + Number.EPSILON) * f) / f;
}

export function roundN(v: Num, places = 2): Num {
  return v === null ? null : round(v, places);
}

// ── The metric totals of a period ────────────────────────────────────────────────────────────

/** One snapshot row (a day × object), as the database holds it, numbers already parsed. */
export type MetricRow = {
  spend: Num; impressions: Num; reach: Num; clicks: Num; linkClicks: Num; landingPageViews: Num;
  videoViews: Num; engagements: Num; followersDelta: Num; leads: Num; purchases: Num; conversionValue: Num;
};

/**
 * `partial`: fields some rows report and others do not. Their sum is shown as reported, but no ratio is built
 * on it — spend from a platform that gave no link clicks must not be divided by another platform's clicks.
 */
export type MetricTotals = MetricRow & { rows: number; partial: (keyof MetricRow)[] };

export const METRIC_FIELDS: (keyof MetricRow)[] = [
  "spend", "impressions", "reach", "clicks", "linkClicks", "landingPageViews", "videoViews", "engagements",
  "followersDelta", "leads", "purchases", "conversionValue",
];

export function totals(rows: MetricRow[]): MetricTotals {
  const out = { rows: rows.length, partial: [] } as unknown as MetricTotals;
  for (const f of METRIC_FIELDS) {
    out[f] = sumN(rows.map((r) => r[f]));
    const known = rows.filter((r) => r[f] !== null && r[f] !== undefined && !Number.isNaN(r[f])).length;
    if (known > 0 && known < rows.length) out.partial.push(f);
  }
  return out;
}

/** A total that may feed a ratio: null when only some rows reported it (MetricTotals.partial). */
export function whole(t: MetricRow & { partial?: (keyof MetricRow)[] }, f: keyof MetricRow): Num {
  return t.partial?.includes(f) ? null : t[f];
}

/** The calendar day an instant falls on in `timeZone`, as the DATE column stores it (that day at UTC midnight). */
export function dayLabel(d: Date, timeZone = "Asia/Riyadh"): Date {
  return new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone }).format(d)}T00:00:00Z`);
}

/** The instant a day label (UTC midnight of a calendar day) starts in `timeZone`: 2026-10-01 → 2026-09-30T21:00Z. */
export function localMidnightOf(label: Date, timeZone = "Asia/Riyadh"): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(label).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(label.getTime() - (wall - label.getTime()));
}

/**
 * The stored days (DATE, the calendar day written as UTC midnight) an INSTANT range covers: every day from the one
 * `from` falls in, through the one just before `to` (exclusive). Comparing the DATE column with the instants
 * themselves would cast them to UTC dates and drop Riyadh's day between 21:00 and 24:00 UTC. Ranges that are
 * already day labels (budget periods) are used as they are, never passed through here.
 */
export function dayBounds(from: Date, to: Date, timeZone = "Asia/Riyadh"): { gte: Date; lt: Date } {
  const last = dayLabel(new Date(to.getTime() - 1), timeZone);
  return { gte: dayLabel(from, timeZone), lt: new Date(last.getTime() + 86_400_000) };
}

/** The last `n` whole local days ending with today: [local midnight n−1 days ago, tomorrow's local midnight). */
export function lastDays(n: number, now = new Date(), timeZone = "Asia/Riyadh"): { from: Date; to: Date } {
  const tomorrow = new Date(dayLabel(now, timeZone).getTime() + 86_400_000);
  return { from: localMidnightOf(new Date(tomorrow.getTime() - n * 86_400_000), timeZone), to: localMidnightOf(tomorrow, timeZone) };
}

export function deliveryKpis(t: MetricRow & { partial?: (keyof MetricRow)[] }) {
  const w = (f: keyof MetricRow) => whole(t, f);
  return {
    spend: t.spend,
    impressions: t.impressions,
    reach: t.reach,
    frequency: roundN(ratio(w("impressions"), w("reach")), 2),
    clicks: t.clicks,
    linkClicks: t.linkClicks,
    ctr: roundN(pct(w("clicks"), w("impressions")), 2),
    linkCtr: roundN(pct(w("linkClicks"), w("impressions")), 2),
    cpc: roundN(ratio(w("spend"), w("linkClicks")), 2),
    cpm: roundN(w("spend") === null ? null : ratio(w("spend")! * 1000, w("impressions")), 2),
    videoViews: t.videoViews,
    engagementRate: roundN(pct(w("engagements"), w("reach")), 2),
    followerGrowth: t.followersDelta,
    landingPageViews: t.landingPageViews,
    leads: t.leads,
    purchases: t.purchases,
    platformRoas: roundN(ratio(w("conversionValue"), w("spend")), 2),
    /** Totals only some rows reported: shown as reported, kept out of every ratio above. */
    partial: t.partial ?? [],
  };
}

// ── Store orders → revenue figures ───────────────────────────────────────────────────────────

export type OrderLike = {
  status: string;
  total: number;
  refunded: number;
  tax: Num;
  shipping: Num;
  customerKey: string | null;
  isFirstOrder: boolean | null;
};

/** Cancelled orders are not revenue. Fully refunded orders count with their refund netted out. */
export function countsAsOrder(o: { status: string }): boolean {
  return o.status !== "CANCELLED" && o.status !== "PENDING";
}

export function revenueOf(orders: OrderLike[]) {
  const live = orders.filter(countsAsOrder);
  const gross = live.reduce((n, o) => n + o.total, 0);
  const refunds = live.reduce((n, o) => n + o.refunded, 0);
  // Net needs tax and shipping on every order; one order without them makes net unknown.
  const netKnown = live.every((o) => o.tax !== null && o.shipping !== null);
  const net = netKnown ? live.reduce((n, o) => n + o.total - o.refunded - (o.tax ?? 0) - (o.shipping ?? 0), 0) : null;
  const newCustomers = new Set(live.filter((o) => o.isFirstOrder === true && o.customerKey).map((o) => o.customerKey)).size;
  const firstKnown = live.every((o) => o.isFirstOrder !== null);
  const byCustomer = new Map<string, number>();
  for (const o of live) if (o.customerKey) byCustomer.set(o.customerKey, (byCustomer.get(o.customerKey) ?? 0) + 1);
  const repeaters = [...byCustomer.values()].filter((n) => n > 1).length;
  return {
    orders: live.length,
    grossRevenue: round(gross),
    refunds: round(refunds),
    netRevenue: net === null ? null : round(net),
    newCustomers: firstKnown ? newCustomers : null,
    aov: roundN(ratio(net, live.length), 2),
    repeatPurchaseRate: roundN(pct(repeaters, byCustomer.size), 2),
    excludedCancelled: orders.filter((o) => o.status === "CANCELLED").length,
    excludedPending: orders.filter((o) => o.status === "PENDING").length,
  };
}

// ── Efficiency and profitability ─────────────────────────────────────────────────────────────

export type Economics = { grossMarginPct: Num; variableCostPerOrder: Num; avgOrderValue: Num };

/**
 * Break-even ROAS: the revenue per riyal of spend at which a sale neither makes nor loses money
 * after cost of goods and variable costs. 1 ÷ contribution ratio (before ads). Null when the
 * economics are not entered, or when the product loses money before any ad (ratio ≤ 0).
 */
export function breakEvenRoas(e: Economics): Num {
  if (e.grossMarginPct === null) return null;
  const variableShare = e.variableCostPerOrder === null ? 0 : e.avgOrderValue ? e.variableCostPerOrder / e.avgOrderValue : null;
  if (variableShare === null) return null;
  const contribution = e.grossMarginPct - variableShare;
  if (contribution <= 0) return null;
  return round(1 / contribution, 2);
}

export function efficiencyKpis(args: { spend: Num; linkClicks: Num; orders: Num; newCustomers: Num; netRevenue: Num; totalNetRevenue?: Num; totalSpend?: Num; economics?: Economics }) {
  const { spend, linkClicks, orders, newCustomers, netRevenue } = args;
  const grossMargin = args.economics?.grossMarginPct != null && netRevenue !== null ? netRevenue * args.economics.grossMarginPct : null;
  const variable = args.economics?.variableCostPerOrder != null && orders !== null ? args.economics.variableCostPerOrder * orders : null;
  const contribution = grossMargin !== null && variable !== null && spend !== null ? grossMargin - variable - spend : null;
  return {
    cvr: roundN(pct(orders, linkClicks), 2),
    cpa: roundN(ratio(spend, orders), 2),
    cac: roundN(ratio(spend, newCustomers), 2),
    roas: roundN(ratio(netRevenue, spend), 2),
    mer: roundN(ratio(args.totalNetRevenue ?? null, args.totalSpend ?? null), 2),
    grossMargin: roundN(grossMargin, 2),
    contributionMargin: roundN(contribution, 2),
    marketingRoi: roundN(grossMargin !== null && spend !== null && spend !== 0 ? ((grossMargin - spend) / spend) * 100 : null, 2),
  };
}

/** Period-over-period change in percent; null when either side is unknown or the base is 0. */
export function change(current: Num, previous: Num): Num {
  if (current === null || previous === null || previous === 0) return null;
  return round(((current - previous) / Math.abs(previous)) * 100, 1);
}

/** The previous period of the same length, ending the instant this one starts. */
export function previousPeriod(from: Date, to: Date): { from: Date; to: Date } {
  const len = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - len), to: new Date(from.getTime()) };
}
