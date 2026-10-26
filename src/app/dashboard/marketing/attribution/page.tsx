"use client";

import { useState } from "react";
import { useLang, PageHeader, Spinner, Banner, Sec, Chip, useLoad, useMkt, usePageTitle, fmt, fmtDate, RangePicker, useRange, Select, SearchField, NotAllowed, specLabel } from "../_components/ui";
import { ATTRIBUTION_MODELS } from "@/lib/marketing/attribution";
import { localizeApiError } from "@/lib/i18n/api-errors";

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

const ORDER_STATUS: Record<string, { ar: string; en: string }> = {
  PENDING: { ar: "بانتظار الدفع", en: "Awaiting payment" }, PAID: { ar: "مدفوع", en: "Paid" }, FULFILLED: { ar: "مكتمل", en: "Fulfilled" },
  CANCELLED: { ar: "ملغى", en: "Cancelled" }, REFUNDED: { ar: "مسترد", en: "Refunded" }, PARTIALLY_REFUNDED: { ar: "مسترد جزئياً", en: "Partly refunded" },
};

export default function AttributionPage() {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
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
    setMsg(res.ok
      ? L(`استيراد يدوي: ${b.rows} صف · جديد/محدّث ${b.imported} · دون تغيير ${b.unchanged}${b.errors?.length ? ` · أخطاء ${b.errors.length}: ${b.errors.slice(0, 3).map((e) => `سطر ${e.row} ${e.reason}`).join("؛ ")}` : ""}`,
        `Manual import: ${b.rows} rows · new/updated ${b.imported} · unchanged ${b.unchanged}${b.errors?.length ? ` · errors ${b.errors.length}: ${b.errors.slice(0, 3).map((e) => `row ${e.row} ${e.reason}`).join("; ")}` : ""}`)
      : localizeApiError(b, lang) ?? "");
    reload();
  }

  if (!can("revenue_view")) return <div className="mkt"><NotAllowed what={L("الاطلاع على الإيرادات والإسناد", "viewing revenue and attribution")} /></div>;
  const rep = data?.report;
  return (
    <div className="mkt" data-testid="mkt-attribution">
      <PageHeader title={L("المبيعات والإسناد", "Sales & attribution")} subtitle={L("طلبات المتجر الإلكتروني منسوبة للحملات؛ مجموع المنسوب وغير المنسوب يساوي مبيعات المتجر.", "Online store orders credited to campaigns; attributed plus unattributed equals the store's sales.")} actions={<>
        <RangePicker r={r} />
        <label className="mkt-chip" style={{ cursor: "pointer" }}>{L("استيراد طلبات CSV (يدوي)", "Import orders CSV (manual)")}<input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} /></label>
      </>} />
      <div className="mkt-toolbar">
        <div className="mkt-narrow"><Select id="model" value={model} onChange={setModel}><option value="">{L("النموذج الافتراضي", "Default model")}</option>{ATTRIBUTION_MODELS.map((m) => <option key={m.key} value={m.key} disabled={!m.available}>{L(m.ar, m.en)}{m.available ? "" : L(" (غير متاح)", " (not available)")}</option>)}</Select></div>
        <div className="mkt-narrow"><Select id="win" value={win} onChange={setWin}><option value="">{L("النافذة الافتراضية", "Default window")}</option>{[1, 3, 7, 14, 28, 30].map((d) => <option key={d} value={d}>{L(`${d} يوم`, `${d} days`)}</option>)}</Select></div>
      </div>
      <p className="mkt-muted">{ATTRIBUTION_MODELS.map((m) => `${L(m.ar, m.en)}: ${L(m.noteAr, m.noteEn)}`).join(" · ")}</p>
      <Banner tone="info" onClose={() => setMsg("")}>{msg}</Banner>
      <Banner>{error}</Banner>
      {loading && !data ? <Spinner /> : rep ? <>
        <div className="mkt-grid">
          {[[L("طلبات محتسبة", "Orders counted"), fmt(rep.totals.orders, { unit: "count", lang })], [L("الإيراد الإجمالي", "Gross revenue"), fmt(rep.totals.grossRevenue, { unit: "SAR", lang })], [L("المسترد", "Refunded"), fmt(rep.totals.refunds, { unit: "SAR", lang })], [L("صافي الإيراد", "Net revenue"), fmt(rep.totals.netRevenue, { unit: "SAR", lang })], [L("عملاء جدد", "New customers"), fmt(rep.totals.newCustomers, { unit: "count", lang })], [L("متوسط الطلب", "Average order"), fmt(rep.totals.aov, { unit: "SAR", lang })], [L("تكرار الشراء", "Repeat purchase"), fmt(rep.totals.repeatPurchaseRate, { unit: "pct", lang })]].map(([l, v]) => <div key={l} className="mkt-kpi"><span className={`v ${v === "غير متاح" || v === "Not available" ? "na" : ""}`}><bdi>{v}</bdi></span><span className="l">{l}</span></div>)}
        </div>
        <p className="mkt-muted">{(() => { const m = ATTRIBUTION_MODELS.find((x) => x.key === rep.model); return L(
          `استُبعد ${rep.totals.excludedCancelled} ملغى و${rep.totals.excludedPending} غير مدفوع · النموذج ${m?.ar ?? ""} · نافذة ${rep.windowDays} يوم · أساس الإسناد: ${rep.revenueBasis === "NET" ? "صافي الإيراد" : "الإجمالي ناقص المسترد (الضريبة أو الشحن غير مبلّغ)"}`,
          `Excluded ${rep.totals.excludedCancelled} cancelled and ${rep.totals.excludedPending} unpaid · model ${m?.en ?? ""} · window ${rep.windowDays} days · attribution basis: ${rep.revenueBasis === "NET" ? "net revenue" : "gross less refunds (tax or shipping not reported)"}`); })()}</p>
        <Sec title={L("الإسناد حسب الحملة", "Attribution by campaign")} testId="by-campaign">
          <div className="mkt-scroll"><table className="mkt-table"><thead><tr><th>{L("الحملة", "Campaign")}</th><th className="n">{L("طلبات منسوبة", "Attributed orders")}</th><th className="n">{L("إيراد منسوب", "Attributed revenue")}</th><th className="n">{L("عملاء جدد", "New customers")}</th></tr></thead><tbody>
            {rep.byCampaign.map((c) => <tr key={c.campaignId}><td>{c.campaign?.name ?? c.campaignId}<div className="mkt-muted"><bdi>{c.campaign?.utmCampaign}</bdi></div></td><td className="n">{fmt(c.orders)}</td><td className="n">{fmt(c.revenue, { unit: "SAR" })}</td><td className="n">{fmt(c.newCustomers)}</td></tr>)}
            <tr><td><strong>{L("غير منسوب", "Unattributed")}</strong><div className="mkt-muted">{L("بلا نقطة تواصل:", "No touch:")} {rep.unattributed.noTouch} · {L("خارج النافذة:", "Outside the window:")} {rep.unattributed.outsideWindow}</div></td><td className="n">{rep.unattributed.orders}</td><td className="n">{fmt(rep.unattributed.revenue, { unit: "SAR" })}</td><td /></tr>
          </tbody></table></div>
          {rep.unknownUtmCampaigns.length ? <div className="mkt-banner warn" style={{ marginTop: 8 }}>{L("طلبات برموز حملات غير معرّفة:", "Orders with undefined campaign codes:")} <bdi>{rep.unknownUtmCampaigns.join(", ")}</bdi> {L("— أنشئ حملات بهذه الرموز لتُنسب.", "— create campaigns with these codes to attribute them.")}</div> : null}
        </Sec>
        <Sec title={L("طلبات المتجر", "Store orders")} actions={<><SearchField value={q} onChange={setQ} placeholder={L("رقم الطلب أو رمز الحملة", "Order number or campaign code")} label={L("بحث", "Search")} /><label className="mkt-chip"><input type="checkbox" checked={unattributed} onChange={(e) => setUnattributed(e.target.checked)} /> {L("بلا حملة فقط", "Without a campaign only")}</label></>}>
          {data!.orders.length === 0 ? <p className="mkt-muted">{L("لا طلبات في الفترة. تصل الطلبات من ويبهوك المتجر أو الاستيراد اليدوي.", "No orders in this period. Orders arrive from the store webhook or a manual import.")}</p> : <div className="mkt-scroll"><table className="mkt-table" data-testid="store-orders"><thead><tr><th>{L("الطلب", "Order")}</th><th>{L("التاريخ", "Date")}</th><th>{L("الحالة", "Status")}</th><th className="n">{L("الإجمالي", "Total")}</th><th className="n">{L("المسترد", "Refunded")}</th><th>{L("عميل جديد", "New customer")}</th><th>{L("المصدر", "Source")}</th><th>{L("الحملة", "Campaign")}</th></tr></thead><tbody>
            {data!.orders.map((o) => <tr key={o.id}><td><bdi>{o.orderNumber ?? o.externalId}</bdi><div className="mkt-muted">{o.customerName}</div></td><td className="mkt-muted">{fmtDate(o.placedAt, true)}</td><td>{specLabel(ORDER_STATUS, o.status, lang)}</td><td className="n">{fmt(o.total, { unit: "SAR" })}</td><td className="n">{fmt(o.refunded, { unit: "SAR" })}</td><td>{o.isFirstOrder === null ? "—" : o.isFirstOrder ? L("نعم", "Yes") : L("لا", "No")}</td><td className="mkt-muted"><bdi>{[o.utmSource, o.utmCampaign].filter(Boolean).join(" / ") || "—"}</bdi>{o.couponCode ? ` · ${o.couponCode}` : ""}</td><td>{o.campaign ? <Chip tone="good">{o.campaign.name}</Chip> : <Chip>{L("غير منسوب", "Unattributed")}</Chip>}</td></tr>)}
          </tbody></table></div>}
        </Sec>
      </> : null}
    </div>
  );
}
