"use client";

import Link from "next/link";
import {
  useLang, PageHeader, Spinner, Kpi, Sec, Chip, StatusChip, RangePicker, useRange, useLoad, useMkt, usePageTitle, fmt, fmtDate, platformName,
  CONNECTION_STATUS, OBJECTIVES, Banner, type Figure,
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
  usePageTitle("نظرة عامة", "Overview", lang);
  const r = useRange(30);
  const { can } = useMkt();
  const { data, error, loading } = useLoad<Overview>(`/api/marketing/overview?${r.qs}`);

  const kills = data ? Object.entries(data.kill).filter(([, v]) => v).map(([k]) => ({ all: "كل الأتمتة", publishing: "النشر", ads: "الإعلانات", messaging: "الرسائل" }[k])) : [];

  return (
    <div className="mkt" data-testid="mkt-overview">
      <PageHeader title="مركز القيادة التسويقية" subtitle="كل رقم بمصدره وتاريخ آخر تحديث وتعريفه؛ «غير متاح» يعني أن البيانات لم تصل، لا أنها صفر." actions={<RangePicker r={r} />} />
      {kills.length ? <Banner>الإيقاف الطارئ مفعّل: {kills.join("، ")}. لا يخرج شيء من النظام في هذا النطاق حتى يُلغى من إعدادات التسويق.</Banner> : null}
      <Banner onClose={undefined}>{error}</Banner>
      {loading && !data ? <Spinner /> : data ? (
        <>
          <div className="mkt-grid" data-testid="kpis">
            {ORDER.filter((k) => data.figures[k]).map((k) => <Kpi key={k} f={data.figures[k]} testId={`kpi-${k}`} />)}
          </div>
          {!data.showMoney ? <p className="mkt-muted">الإيرادات وتكلفة الاكتساب والعائد تظهر لمن يملك صلاحية «الإيرادات والإسناد».</p> : null}
          {data.attribution ? (
            <p className="mkt-muted" data-testid="attr-note">
              الإسناد: {data.attribution.model === "LAST_TOUCH" ? "آخر نقطة تواصل" : data.attribution.model === "FIRST_TOUCH" ? "أول نقطة تواصل" : "توزيع متساوٍ"} خلال {data.attribution.windowDays} أيام ·
              أساس الإيراد: {data.attribution.revenueBasis === "NET" ? "صافي" : "الإجمالي ناقص المسترد (الضريبة/الشحن غير مبلّغة)"} · طلبات غير منسوبة: {data.attribution.unattributed.orders} ({fmt(data.attribution.unattributed.revenue, { unit: "SAR" })}).
            </p>
          ) : null}

          <div className="mkt-grid-2">
            <Sec title="المحتوى والنشر" testId="sec-posts" actions={<Link className="mkt-chip" href="/dashboard/marketing/calendar">التقويم</Link>}>
              <div className="mkt-toolbar">
                <Chip>منشور في الفترة: {data.posts.publishedInPeriod}</Chip>
                <Chip tone="info">مجدول: {data.posts.byStatus.SCHEDULED ?? 0}</Chip>
                <Chip>مسودات: {data.posts.byStatus.DRAFT ?? 0}</Chip>
                <Chip tone="warn">بانتظار الاعتماد: {data.posts.byStatus.IN_REVIEW ?? 0}</Chip>
                <Chip tone="bad">فشل: {(data.posts.byStatus.FAILED ?? 0) + (data.posts.byStatus.PARTIAL ?? 0)}</Chip>
                <Chip tone="warn">بانتظار نشر يدوي: {data.posts.manualRequired}</Chip>
              </div>
              <p className="mkt-muted" style={{ marginTop: 10 }}>طلبات اعتماد معلّقة: <Link href="/dashboard/marketing/approvals">{data.pendingApprovals}</Link></p>
            </Sec>
            <Sec title="الميزانية (الشهر الحالي)" testId="sec-budget" actions={<Link className="mkt-chip" href="/dashboard/marketing/budgets">الميزانيات</Link>}>
              {!data.budget ? <p className="mkt-muted">لا صلاحية لعرض الميزانية.</p> : !data.budget.total ? <p className="mkt-muted">لا توجد ميزانية كلية لشهر {data.budget.period}. أضفها من الميزانيات.</p> : (
                <div className="mkt-toolbar">
                  <Chip>المخطط: {fmt(data.budget.total.planned, { unit: "SAR" })}</Chip>
                  <Chip>المصروف: {fmt(data.budget.total.pacing.actual, { unit: "SAR" })}</Chip>
                  <Chip>المتبقي: {fmt(data.budget.total.pacing.remaining, { unit: "SAR" })}</Chip>
                  <Chip tone={data.budget.total.pacing.status === "EXCEEDED" ? "bad" : data.budget.total.pacing.status === "OVER_PACE" ? "warn" : undefined}>المتوقع لنهاية الشهر: {fmt(data.budget.total.pacing.forecast, { unit: "SAR" })}</Chip>
                  {data.budget.allocation.overAllocated ? <Chip tone="bad">التوزيع يتجاوز الميزانية الكلية</Chip> : null}
                </div>
              )}
            </Sec>
          </div>

          <Sec title="أداء المنصات المدفوعة" caption="من الإنفاق المبلّغ لكل منصة (API أو استيراد أو إدخال يدوي موثّق)." testId="sec-platforms">
            {data.platforms.length === 0 ? <p className="mkt-muted">لا توجد بيانات إنفاق في الفترة. اربط حساباً إعلانياً أو استورد تقرير المنصة من «التحليلات والمؤشرات».</p> : (
              <div className="mkt-scroll"><table className="mkt-table">
                <thead><tr><th>المنصة</th><th className="n">الإنفاق</th><th className="n">الظهور</th><th className="n">نقرات الرابط</th><th className="n">CTR</th><th className="n">CPC</th><th className="n">CPM</th><th>المصدر</th></tr></thead>
                <tbody>{data.platforms.map((p) => (
                  <tr key={p.platform}><td>{platformName(p.platform)}</td><td className="n">{fmt(p.spend, { unit: "SAR" })}</td><td className="n">{fmt(p.impressions, { unit: "count" })}</td><td className="n">{fmt(p.linkClicks, { unit: "count" })}</td><td className="n">{fmt(p.ctr, { unit: "pct" })}</td><td className="n">{fmt(p.cpc, { unit: "SAR" })}</td><td className="n">{fmt(p.cpm, { unit: "SAR" })}</td><td className="mkt-muted"><bdi>{p.sources.join("، ")}</bdi> · <bdi>{fmtDate(p.lastUpdated, true)}</bdi></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </Sec>

          <div className="mkt-grid-2">
            <Sec title="أفضل الحملات" caption="حسب مؤشر هدف كل حملة: العائد لحملات المبيعات، نسبة النقر لغيرها." testId="sec-best">
              {data.best.length === 0 ? <p className="mkt-muted">لا حملات بها بيانات كافية.</p> : <CampaignList rows={data.best} />}
            </Sec>
            <Sec title="أضعف الحملات" testId="sec-worst">
              {data.worst.length === 0 ? <p className="mkt-muted">تظهر عند وجود أكثر من ثلاث حملات بها بيانات.</p> : <CampaignList rows={data.worst} />}
            </Sec>
          </div>

          <div className="mkt-grid-2">
            <Sec title="أفضل المنشورات" caption="حسب التفاعل المسجل على مستوى المنشور." testId="sec-top-posts">
              {data.topPosts.length === 0 ? <p className="mkt-muted">لا توجد مقاييس منشورات في الفترة.</p> : (
                <div className="mkt-list">{data.topPosts.map((t, i) => (
                  <div className="mkt-item" key={i}><div><div className="t">{t.post?.title ?? "منشور خارج النظام"}</div><div className="s">{platformName(t.platform)} · وصول {fmt(t.reach, { unit: "count" })} · تفاعل {fmt(t.engagements, { unit: "count" })} · نقرات {fmt(t.linkClicks, { unit: "count" })}</div></div>{t.url ? <a className="mkt-chip" href={t.url} target="_blank" rel="noreferrer">فتح</a> : null}</div>
                ))}</div>
              )}
            </Sec>
            <Sec title="التنبيهات" testId="sec-alerts">
              {data.alerts.length === 0 ? <p className="mkt-muted">لا تنبيهات مفتوحة.</p> : (
                <div className="mkt-list">{data.alerts.map((a) => (
                  <div className="mkt-item" key={a.id}><div><div className="t">{a.title}</div>{a.detail ? <div className="s">{a.detail}</div> : null}</div><Chip tone={a.severity === "CRITICAL" ? "bad" : a.severity === "WARNING" ? "warn" : "info"}>{a.severity === "CRITICAL" ? "حرج" : a.severity === "WARNING" ? "تحذير" : "معلومة"}</Chip></div>
                ))}</div>
              )}
            </Sec>
          </div>

          <div className="mkt-grid-2">
            <Sec title="حالة الربط" testId="sec-connections" actions={<Link className="mkt-chip" href="/dashboard/marketing/integrations">التكاملات</Link>}>
              <div className="mkt-list">{data.connections.map((c) => (
                <div className="mkt-item" key={c.platform}><span>{c.name}</span><span className="mkt-toolbar"><StatusChip map={CONNECTION_STATUS} value={c.status} />{c.expiringSoon ? <Chip tone="warn">ينتهي قريباً</Chip> : null}</span></div>
              ))}</div>
            </Sec>
            <Sec title="صحة التتبع" caption="نسبة طلبات المتجر التي وصلت برمز حملة (utm_campaign)." testId="sec-tracking">
              {data.tracking.orders === 0 ? <p className="mkt-muted">لا طلبات متجر في الفترة؛ صحة التتبع غير معروفة.</p> : (
                <p>طلبات بها رمز حملة: <bdi>{data.tracking.withUtm}</bdi> من <bdi>{data.tracking.orders}</bdi> ({fmt(data.tracking.sharePct, { unit: "pct" })})</p>
              )}
              {data.tracking.unknownUtmCampaigns.length ? <p className="mkt-muted">رموز حملات غير معرّفة في النظام: <bdi>{data.tracking.unknownUtmCampaigns.join(", ")}</bdi></p> : null}
              {can("revenue_view") ? <Link className="mkt-chip" href="/dashboard/marketing/attribution">المبيعات والإسناد</Link> : null}
            </Sec>
          </div>
        </>
      ) : null}
    </div>
  );
}

function CampaignList({ rows }: { rows: { id: string; name: string; objective: string; score: number | null; scoreKpi: string }[] }) {
  return (
    <div className="mkt-list">{rows.map((c) => (
      <Link key={c.id} href={`/dashboard/marketing/campaigns/${c.id}`} className="mkt-item"><div><div className="t">{c.name}</div><div className="s">{OBJECTIVES[c.objective] ?? c.objective}</div></div><Chip>{c.scoreKpi === "roas" ? `العائد ${fmt(c.score, { unit: "x" })}` : `CTR ${fmt(c.score, { unit: "pct" })}`}</Chip></Link>
    ))}</div>
  );
}
