"use client";

import Link from "next/link";
import {
  useLang, PageHeader, Spinner, Kpi, Sec, Chip, StatusChip, RangePicker, useRange, useLoad, useMkt, usePageTitle, fmt, fmtDate, platformName,
  CONNECTION_STATUS, OBJECTIVES, Banner, specLabel, type Figure,
} from "./_components/ui";

/**
 * «مركز القيادة التسويقية» — the marketing overview. Every figure comes from /api/marketing/overview
 * with its source and its last update; figures the viewer may not see (revenue without
 * marketing › revenue_view) are simply not returned, and a missing figure reads «غير متاح».
 */

type Overview = {
  period: { from: string; to: string; previousFrom: string; previousTo: string; timezone: string };
  showMoney: boolean;
  figures: Record<string, Figure>;
  posts: { byStatus: Record<string, number>; publishedInPeriod: number; manualRequired: number };
  pendingApprovals: number;
  alerts: { id: string; title: string; detail: string | null; severity: string; createdAt: string }[];
  budget: { period: string; total: { planned: number; pacing: { actual: number | null; remaining: number | null; forecast: number | null; usedPct: number | null; status: string } } | null; actual: { ads: number | null; messaging: number | null; total: number | null }; allocation: { overAllocated: boolean; unallocated: number | null } } | null;
  platforms: { platform: string; spend: number | null; impressions: number | null; linkClicks: number | null; ctr: number | null; cpc: number | null; cpm: number | null; lastUpdated: string; sources: string[] }[];
  best: { id: string; name: string; objective: string; score: number | null; scoreKpi: string }[];
  worst: { id: string; name: string; objective: string; score: number | null; scoreKpi: string }[];
  topPosts: { platform: string; reach: number | null; engagements: number | null; linkClicks: number | null; post: { id: string; title: string } | null; url: string | null }[];
  connections: { platform: string; name: string; status: string; expiringSoon: boolean; missingEnv: number }[];
  tracking: { orders: number; withUtm: number; sharePct: number | null; unknownUtmCampaigns: string[] };
  kill: { all: boolean; publishing: boolean; ads: boolean; messaging: boolean };
  attribution: { model: string; windowDays: number; unattributed: { orders: number; revenue: number }; revenueBasis: string } | null;
};

const ORDER: string[] = ["spend", "netRevenue", "orders", "newCustomers", "cac", "cpa", "roas", "mer", "cvr", "cpc", "ctr", "cpm", "impressions", "linkClicks"];

export default function MarketingOverview() {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  usePageTitle("نظرة عامة", "Overview", lang);
  const r = useRange(30);
  const { can } = useMkt();
  const { data, error, loading } = useLoad<Overview>(`/api/marketing/overview?${r.qs}`);

  const kills = data ? Object.entries(data.kill).filter(([, v]) => v).map(([k]) => (lang === "ar" ? { all: "كل الأتمتة", publishing: "النشر", ads: "الإعلانات", messaging: "الرسائل" }[k] : { all: "all automation", publishing: "publishing", ads: "ads", messaging: "messaging" }[k])) : [];

  return (
    <div className="mkt" data-testid="mkt-overview">
      <PageHeader title={L("مركز القيادة التسويقية", "Marketing command centre")} subtitle={L("كل رقم بمصدره وتاريخ آخر تحديث وتعريفه؛ «غير متاح» يعني أن البيانات لم تصل، لا أنها صفر.", "Every figure with its source, last update and definition; “Not available” means the data has not arrived, not that it is zero.")} actions={<RangePicker r={r} />} />
      {kills.length ? <Banner>{L(`الإيقاف الطارئ مفعّل: ${kills.join("، ")}. لا يخرج شيء من النظام في هذا النطاق حتى يُلغى من إعدادات التسويق.`, `Emergency stop is on: ${kills.join(", ")}. Nothing leaves the system in this scope until it is lifted in marketing settings.`)}</Banner> : null}
      <Banner onClose={undefined}>{error}</Banner>
      {loading && !data ? <Spinner /> : data ? (
        <>
          <div className="mkt-grid" data-testid="kpis">
            {ORDER.filter((k) => data.figures[k]).map((k) => <Kpi key={k} f={data.figures[k]} testId={`kpi-${k}`} lang={lang} />)}
          </div>
          {!data.showMoney ? <p className="mkt-muted">{L("الإيرادات وتكلفة الاكتساب (CAC) والعائد (ROAS) تظهر لمن يملك صلاحية «الإيرادات والإسناد».", "Revenue, acquisition cost and return are shown to holders of the “Revenue & attribution” permission.")}</p> : null}
          {data.attribution ? (
            <p className="mkt-muted" data-testid="attr-note">
              {L("الإسناد:", "Attribution:")} {data.attribution.model === "LAST_TOUCH" ? L("آخر نقطة تواصل", "last touch") : data.attribution.model === "FIRST_TOUCH" ? L("أول نقطة تواصل", "first touch") : L("توزيع متساوٍ", "even split")} {L(`خلال ${data.attribution.windowDays} أيام`, `within ${data.attribution.windowDays} days`)} ·{" "}
              {L("أساس الإيراد:", "Revenue basis:")} {data.attribution.revenueBasis === "NET" ? L("صافي", "net") : L("الإجمالي ناقص المسترد (الضريبة/الشحن غير مبلّغة)", "gross less refunds (tax/shipping not reported)")} · {L("طلبات غير منسوبة:", "Unattributed orders:")} {data.attribution.unattributed.orders} ({fmt(data.attribution.unattributed.revenue, { unit: "SAR", lang })}).
            </p>
          ) : null}

          <div className="mkt-grid-2">
            <Sec title={L("المحتوى والنشر", "Content & publishing")} testId="sec-posts" actions={<Link className="mkt-chip" href="/dashboard/marketing/calendar">{L("التقويم", "Calendar")}</Link>}>
              <div className="mkt-toolbar">
                <Chip>{L("منشور في الفترة:", "Published in period:")} {data.posts.publishedInPeriod}</Chip>
                <Chip tone="info">{L("مجدول:", "Scheduled:")} {data.posts.byStatus.SCHEDULED ?? 0}</Chip>
                <Chip>{L("مسودات:", "Drafts:")} {data.posts.byStatus.DRAFT ?? 0}</Chip>
                <Chip tone="warn">{L("بانتظار الاعتماد:", "Awaiting approval:")} {data.posts.byStatus.IN_REVIEW ?? 0}</Chip>
                <Chip tone="bad">{L("فشل:", "Failed:")} {(data.posts.byStatus.FAILED ?? 0) + (data.posts.byStatus.PARTIAL ?? 0)}</Chip>
                <Chip tone="warn">{L("بانتظار نشر يدوي:", "Awaiting manual publishing:")} {data.posts.manualRequired}</Chip>
              </div>
              <p className="mkt-muted" style={{ marginTop: 10 }}>{L("طلبات اعتماد معلّقة:", "Pending approval requests:")} <Link href="/dashboard/marketing/approvals">{data.pendingApprovals}</Link></p>
            </Sec>
            <Sec title={L("الميزانية (الشهر الحالي)", "Budget (this month)")} testId="sec-budget" actions={<Link className="mkt-chip" href="/dashboard/marketing/budgets">{L("الميزانيات", "Budgets")}</Link>}>
              {!data.budget ? <p className="mkt-muted">{L("لا صلاحية لعرض الميزانية.", "No permission to view the budget.")}</p> : !data.budget.total ? <p className="mkt-muted">{L(`لا توجد ميزانية كلية لشهر ${data.budget.period}. أضفها من الميزانيات.`, `No total budget for ${data.budget.period}. Add one in Budgets.`)}</p> : (
                <div className="mkt-toolbar">
                  <Chip>{L("المخطط:", "Planned:")} {fmt(data.budget.total.planned, { unit: "SAR", lang })}</Chip>
                  <Chip>{L("المصروف:", "Spent:")} {fmt(data.budget.total.pacing.actual, { unit: "SAR", lang })}</Chip>
                  <Chip>{L("المتبقي:", "Remaining:")} {fmt(data.budget.total.pacing.remaining, { unit: "SAR", lang })}</Chip>
                  <Chip tone={data.budget.total.pacing.status === "EXCEEDED" ? "bad" : data.budget.total.pacing.status === "OVER_PACE" ? "warn" : undefined}>{L("المتوقع لنهاية الشهر:", "Month-end forecast:")} {fmt(data.budget.total.pacing.forecast, { unit: "SAR", lang })}</Chip>
                  {data.budget.allocation.overAllocated ? <Chip tone="bad">{L("التوزيع يتجاوز الميزانية الكلية", "The allocation exceeds the total budget")}</Chip> : null}
                </div>
              )}
            </Sec>
          </div>

          <Sec title={L("أداء المنصات المدفوعة", "Paid platform performance")} caption={L("من الإنفاق المبلّغ لكل منصة (API أو استيراد أو إدخال يدوي موثّق).", "From the spend each platform reported (API, import or documented manual entry).")} testId="sec-platforms">
            {data.platforms.length === 0 ? <p className="mkt-muted">{L("لا توجد بيانات إنفاق في الفترة. اربط حساباً إعلانياً أو استورد تقرير المنصة من «التحليلات والمؤشرات».", "No spend data in this period. Connect an ad account or import the platform report from “Analytics & KPIs”.")}</p> : (
              <div className="mkt-scroll"><table className="mkt-table">
                <thead><tr><th>{L("المنصة", "Platform")}</th><th className="n">{L("الإنفاق", "Spend")}</th><th className="n">{L("الظهور", "Impressions")}</th><th className="n">{L("نقرات الرابط", "Link clicks")}</th><th className="n">{L("نسبة النقر (CTR)", "CTR")}</th><th className="n">{L("تكلفة النقرة (CPC)", "CPC")}</th><th className="n">{L("تكلفة الألف ظهور (CPM)", "CPM")}</th><th>{L("المصدر", "Source")}</th></tr></thead>
                <tbody>{data.platforms.map((p) => (
                  <tr key={p.platform}><td>{platformName(p.platform, lang)}</td><td className="n">{fmt(p.spend, { unit: "SAR", lang })}</td><td className="n">{fmt(p.impressions, { unit: "count", lang })}</td><td className="n">{fmt(p.linkClicks, { unit: "count", lang })}</td><td className="n">{fmt(p.ctr, { unit: "pct", lang })}</td><td className="n">{fmt(p.cpc, { unit: "SAR", lang })}</td><td className="n">{fmt(p.cpm, { unit: "SAR", lang })}</td><td className="mkt-muted"><bdi>{p.sources.join(L("، ", ", "))}</bdi> · <bdi>{fmtDate(p.lastUpdated, true)}</bdi></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </Sec>

          <div className="mkt-grid-2">
            <Sec title={L("أفضل الحملات", "Best campaigns")} caption={L("حسب مؤشر هدف كل حملة: العائد (ROAS) لحملات المبيعات، ونسبة النقر (CTR) لغيرها.", "By each campaign's objective KPI: ROAS for sales campaigns, click-through rate for the rest.")} testId="sec-best">
              {data.best.length === 0 ? <p className="mkt-muted">{L("لا حملات بها بيانات كافية.", "No campaign has enough data.")}</p> : <CampaignList rows={data.best} lang={lang} />}
            </Sec>
            <Sec title={L("أضعف الحملات", "Weakest campaigns")} testId="sec-worst">
              {data.worst.length === 0 ? <p className="mkt-muted">{L("تظهر عند وجود أكثر من ثلاث حملات بها بيانات.", "Shown once more than three campaigns have data.")}</p> : <CampaignList rows={data.worst} lang={lang} />}
            </Sec>
          </div>

          <div className="mkt-grid-2">
            <Sec title={L("أفضل المنشورات", "Top posts")} caption={L("حسب التفاعل المسجل على مستوى المنشور.", "By the engagement recorded per post.")} testId="sec-top-posts">
              {data.topPosts.length === 0 ? <p className="mkt-muted">{L("لا توجد مقاييس منشورات في الفترة.", "No post metrics in this period.")}</p> : (
                <div className="mkt-list">{data.topPosts.map((t, i) => (
                  <div className="mkt-item" key={i}><div><div className="t">{t.post?.title ?? L("منشور خارج النظام", "Post outside the system")}</div><div className="s">{platformName(t.platform, lang)} · {L("وصول", "Reach")} {fmt(t.reach, { unit: "count", lang })} · {L("تفاعل", "Engagements")} {fmt(t.engagements, { unit: "count", lang })} · {L("نقرات", "Clicks")} {fmt(t.linkClicks, { unit: "count", lang })}</div></div>{t.url ? <a className="mkt-chip" href={t.url} target="_blank" rel="noreferrer">{L("فتح", "Open")}</a> : null}</div>
                ))}</div>
              )}
            </Sec>
            <Sec title={L("التنبيهات", "Alerts")} testId="sec-alerts">
              {data.alerts.length === 0 ? <p className="mkt-muted">{L("لا تنبيهات مفتوحة.", "No open alerts.")}</p> : (
                <div className="mkt-list">{data.alerts.map((a) => (
                  <div className="mkt-item" key={a.id}><div><div className="t">{a.title}</div>{a.detail ? <div className="s">{a.detail}</div> : null}</div><Chip tone={a.severity === "CRITICAL" ? "bad" : a.severity === "WARNING" ? "warn" : "info"}>{a.severity === "CRITICAL" ? L("حرج", "Critical") : a.severity === "WARNING" ? L("تحذير", "Warning") : L("معلومة", "Info")}</Chip></div>
                ))}</div>
              )}
            </Sec>
          </div>

          <div className="mkt-grid-2">
            <Sec title={L("حالة الربط", "Connection status")} testId="sec-connections" actions={<Link className="mkt-chip" href="/dashboard/marketing/integrations">{L("التكاملات", "Integrations")}</Link>}>
              <div className="mkt-list">{data.connections.map((c) => (
                <div className="mkt-item" key={c.platform}><span>{platformName(c.platform, lang)}</span><span className="mkt-toolbar"><StatusChip map={CONNECTION_STATUS} value={c.status} />{c.expiringSoon ? <Chip tone="warn">{L("ينتهي قريباً", "Expires soon")}</Chip> : null}</span></div>
              ))}</div>
            </Sec>
            <Sec title={L("صحة التتبع", "Tracking health")} caption={L("نسبة طلبات المتجر التي وصلت برمز حملة (utm_campaign).", "The share of store orders that arrived with a campaign code (utm_campaign).")} testId="sec-tracking">
              {data.tracking.orders === 0 ? <p className="mkt-muted">{L("لا طلبات متجر في الفترة؛ صحة التتبع غير معروفة.", "No store orders in this period; tracking health is unknown.")}</p> : (
                <p>{L("طلبات بها رمز حملة:", "Orders with a campaign code:")} <bdi>{data.tracking.withUtm}</bdi> {L("من", "of")} <bdi>{data.tracking.orders}</bdi> ({fmt(data.tracking.sharePct, { unit: "pct", lang })})</p>
              )}
              {data.tracking.unknownUtmCampaigns.length ? <p className="mkt-muted">{L("رموز حملات غير معرّفة في النظام:", "Campaign codes not defined in the system:")} <bdi>{data.tracking.unknownUtmCampaigns.join(", ")}</bdi></p> : null}
              {can("revenue_view") ? <Link className="mkt-chip" href="/dashboard/marketing/attribution">{L("المبيعات والإسناد", "Sales & attribution")}</Link> : null}
            </Sec>
          </div>
        </>
      ) : null}
    </div>
  );
}

function CampaignList({ rows, lang }: { rows: { id: string; name: string; objective: string; score: number | null; scoreKpi: string }[]; lang: "ar" | "en" }) {
  return (
    <div className="mkt-list">{rows.map((c) => (
      <Link key={c.id} href={`/dashboard/marketing/campaigns/${c.id}`} className="mkt-item"><div><div className="t">{c.name}</div><div className="s">{specLabel(OBJECTIVES, c.objective, lang)}</div></div><Chip>{c.scoreKpi === "roas" ? `${lang === "ar" ? "العائد (ROAS)" : "ROAS"} ${fmt(c.score, { unit: "x", lang })}` : `${lang === "ar" ? "نسبة النقر (CTR)" : "CTR"} ${fmt(c.score, { unit: "pct", lang })}`}</Chip></Link>
    ))}</div>
  );
}
