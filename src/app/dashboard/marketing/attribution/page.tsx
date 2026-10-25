"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Banner, Sec, Chip, useLoad, useMkt, usePageTitle, fmt, fmtDate, RangePicker, useRange, Select, SearchField, NotAllowed } from "../_components/ui";
import { ATTRIBUTION_MODELS } from "@/lib/marketing/attribution";

/**
 * «المبيعات والإسناد» — store orders (store mirror) credited to campaigns under the chosen model.
 * The credits of all campaigns plus «غير منسوب» add up to the store's revenue — an order is never
 * counted twice, unlike the platforms' own conversion figures.
 */

type Report = {
  model: string; windowDays: number; revenueBasis: string;
  totals: { orders: number; grossRevenue: number; refunds: number; netRevenue: number | null; newCustomers: number | null; aov: number | null; repeatPurchaseRate: number | null; excludedCancelled: number; excludedPending: number };
  byCampaign: { campaignId: string; orders: number; revenue: number; newCustomers: number; campaign: { name: string; utmCampaign: string } | null }[];
  unattributed: { orders: number; revenue: number; noTouch: number; outsideWindow: number };
  unknownUtmCampaigns: string[];
};
type Order = { id: string; externalId: string; orderNumber: string | null; status: string; total: number | null; refunded: number | null; placedAt: string; isFirstOrder: boolean | null; utmSource: string | null; utmCampaign: string | null; couponCode: string | null; campaign: { id: string; name: string } | null; customerName: string | null };

const ORDER_STATUS: Record<string, string> = { PENDING: "بانتظار الدفع", PAID: "مدفوع", FULFILLED: "مكتمل", CANCELLED: "ملغى", REFUNDED: "مسترد", PARTIALLY_REFUNDED: "مسترد جزئياً" };

export default function AttributionPage() {
  const lang = useLang();
  usePageTitle("المبيعات والإسناد", "Sales & attribution", lang);
  const { can } = useMkt();
  const r = useRange(30);
  const [model, setModel] = useState("");
  const [win, setWin] = useState("");
  const [q, setQ] = useState("");
  const [unattributed, setUnattributed] = useState(false);
  const { data, error, loading, reload } = useLoad<{ report: Report; orders: Order[] }>(can("revenue_view") ? `/api/marketing/attribution?${r.qs}&model=${model}&window=${win}&q=${encodeURIComponent(q)}&unattributed=${unattributed ? 1 : 0}` : null);
  const [msg, setMsg] = useState("");

  async function importCsv(file: File) {
    const res = await fetch("/api/marketing/store/import", { method: "POST", body: await file.text(), headers: { "Content-Type": "text/csv" } });
    const b = (await res.json().catch(() => ({}))) as { error?: string; rows?: number; imported?: number; unchanged?: number; errors?: { row: number; reason: string }[] };
    setMsg(res.ok ? `استيراد يدوي: ${b.rows} صف · جديد/محدّث ${b.imported} · دون تغيير ${b.unchanged}${b.errors?.length ? ` · أخطاء ${b.errors.length}: ${b.errors.slice(0, 3).map((e) => `سطر ${e.row} ${e.reason}`).join("؛ ")}` : ""}` : b.error ?? "");
    reload();
  }

  if (!can("revenue_view")) return <div className="mkt"><NotAllowed what="الاطلاع على الإيرادات والإسناد" /></div>;
  const rep = data?.report;
  return (
    <div className="mkt" data-testid="mkt-attribution">
      <PageHeader title="المبيعات والإسناد" subtitle="طلبات المتجر الإلكتروني منسوبة للحملات؛ مجموع المنسوب وغير المنسوب يساوي مبيعات المتجر." actions={<>
        <RangePicker r={r} />
        <label className="mkt-chip" style={{ cursor: "pointer" }}>استيراد طلبات CSV (يدوي)<input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} /></label>
      </>} />
      <div className="mkt-toolbar">
        <div className="mkt-narrow"><Select id="model" value={model} onChange={setModel}><option value="">النموذج الافتراضي</option>{ATTRIBUTION_MODELS.map((m) => <option key={m.key} value={m.key} disabled={!m.available}>{m.ar}{m.available ? "" : " (غير متاح)"}</option>)}</Select></div>
        <div className="mkt-narrow"><Select id="win" value={win} onChange={setWin}><option value="">النافذة الافتراضية</option>{[1, 3, 7, 14, 28, 30].map((d) => <option key={d} value={d}>{d} يوم</option>)}</Select></div>
      </div>
      <p className="mkt-muted">{ATTRIBUTION_MODELS.map((m) => `${m.ar}: ${m.noteAr}`).join(" · ")}</p>
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner>{error}</Banner>
      {loading && !data ? <Spinner /> : rep ? <>
        <div className="mkt-grid">
          {[["طلبات محتسبة", fmt(rep.totals.orders, { unit: "count" })], ["الإيراد الإجمالي", fmt(rep.totals.grossRevenue, { unit: "SAR" })], ["المسترد", fmt(rep.totals.refunds, { unit: "SAR" })], ["صافي الإيراد", fmt(rep.totals.netRevenue, { unit: "SAR" })], ["عملاء جدد", fmt(rep.totals.newCustomers, { unit: "count" })], ["متوسط الطلب", fmt(rep.totals.aov, { unit: "SAR" })], ["تكرار الشراء", fmt(rep.totals.repeatPurchaseRate, { unit: "pct" })]].map(([l, v]) => <div key={l} className="mkt-kpi"><span className={`v ${v === "غير متاح" ? "na" : ""}`}><bdi>{v}</bdi></span><span className="l">{l}</span></div>)}
        </div>
        <p className="mkt-muted">استُبعد {rep.totals.excludedCancelled} ملغى و{rep.totals.excludedPending} غير مدفوع · النموذج {ATTRIBUTION_MODELS.find((m) => m.key === rep.model)?.ar} · نافذة {rep.windowDays} يوم · أساس الإسناد: {rep.revenueBasis === "NET" ? "صافي الإيراد" : "الإجمالي ناقص المسترد (الضريبة أو الشحن غير مبلّغ)"}</p>
        <Sec title="الإسناد حسب الحملة" testId="by-campaign">
          <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>الحملة</th><th className="n">طلبات منسوبة</th><th className="n">إيراد منسوب</th><th className="n">عملاء جدد</th></tr></thead><tbody>
            {rep.byCampaign.map((c) => <tr key={c.campaignId}><td>{c.campaign?.name ?? c.campaignId}<div className="mkt-muted"><bdi>{c.campaign?.utmCampaign}</bdi></div></td><td className="n">{fmt(c.orders)}</td><td className="n">{fmt(c.revenue, { unit: "SAR" })}</td><td className="n">{fmt(c.newCustomers)}</td></tr>)}
            <tr><td><strong>غير منسوب</strong><div className="mkt-muted">بلا نقطة تواصل: {rep.unattributed.noTouch} · خارج النافذة: {rep.unattributed.outsideWindow}</div></td><td className="n">{rep.unattributed.orders}</td><td className="n">{fmt(rep.unattributed.revenue, { unit: "SAR" })}</td><td /></tr>
          </tbody></table></div>
          {rep.unknownUtmCampaigns.length ? <div className="mkt-banner warn" style={{ marginTop: 8 }}>طلبات برموز حملات غير معرّفة: <bdi>{rep.unknownUtmCampaigns.join(", ")}</bdi> — أنشئ حملات بهذه الرموز لتُنسب.</div> : null}
        </Sec>
        <Sec title="طلبات المتجر" actions={<><SearchField value={q} onChange={setQ} placeholder="رقم الطلب أو رمز الحملة" label="بحث" /><label className="mkt-chip"><input type="checkbox" checked={unattributed} onChange={(e) => setUnattributed(e.target.checked)} /> بلا حملة فقط</label></>}>
          {data!.orders.length === 0 ? <p className="mkt-muted">لا طلبات في الفترة. تصل الطلبات من ويبهوك المتجر أو الاستيراد اليدوي.</p> : <div className="mkt-scroll"><table className="mkt-table" data-testid="store-orders"><thead><tr><th>الطلب</th><th>التاريخ</th><th>الحالة</th><th className="n">الإجمالي</th><th className="n">المسترد</th><th>عميل جديد</th><th>المصدر</th><th>الحملة</th></tr></thead><tbody>
            {data!.orders.map((o) => <tr key={o.id}><td><bdi>{o.orderNumber ?? o.externalId}</bdi><div className="mkt-muted">{o.customerName}</div></td><td className="mkt-muted">{fmtDate(o.placedAt, true)}</td><td>{ORDER_STATUS[o.status]}</td><td className="n">{fmt(o.total, { unit: "SAR" })}</td><td className="n">{fmt(o.refunded, { unit: "SAR" })}</td><td>{o.isFirstOrder === null ? "—" : o.isFirstOrder ? "نعم" : "لا"}</td><td className="mkt-muted"><bdi>{[o.utmSource, o.utmCampaign].filter(Boolean).join(" / ") || "—"}</bdi>{o.couponCode ? ` · ${o.couponCode}` : ""}</td><td>{o.campaign ? <Chip tone="good">{o.campaign.name}</Chip> : <Chip>غير منسوب</Chip>}</td></tr>)}
          </tbody></table></div>}
        </Sec>
      </> : null}
    </div>
  );
}
