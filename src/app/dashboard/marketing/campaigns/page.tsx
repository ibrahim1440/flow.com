"use client";

import Link from "next/link";
import { useState } from "react";
import {
  useLang, PageHeader, Spinner, Button, Banner, Sec, StatusChip, useLoad, useMkt, usePageTitle, fmt, fmtDate, platformName, CAMPAIGN_STATUS, OBJECTIVES, SearchField,
} from "../_components/ui";
import { CampaignForm, type CampaignRow } from "./form";

export default function CampaignsPage() {
  const lang = useLang();
  usePageTitle("الحملات", "Campaigns", lang);
  const { can } = useMkt();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useLoad<{ rows: (CampaignRow & { spend: number | null; counts: { posts: number; messages: number; storeOrders: number } })[] }>(`/api/marketing/campaigns?q=${encodeURIComponent(q)}&status=${status}`);
  const [editing, setEditing] = useState<CampaignRow | "new" | null>(null);

  return (
    <div className="mkt" data-testid="mkt-campaigns">
      <PageHeader title="الحملات" subtitle="العمود الفقري للتسويق: كل منشور ورسالة وبند ميزانية وطلب متجر يرتبط بحملة عبر رمز utm_campaign." actions={can("campaigns_manage") ? <Button testId="new-campaign" onClick={() => setEditing("new")}>حملة جديدة</Button> : null} />
      <div className="mkt-toolbar">
        <SearchField value={q} onChange={setQ} placeholder="ابحث باسم الحملة أو رمزها" label="بحث" />
        <div className="mkt-seg" role="group" aria-label="الحالة">
          {["", "DRAFT", "PLANNED", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"].map((s) => (
            <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? CAMPAIGN_STATUS[s].ar : "الكل"}</button>
          ))}
        </div>
      </div>
      <Banner>{error}</Banner>
      {loading && !data ? <Spinner /> : data && data.rows.length === 0 ? (
        <Sec title="لا توجد حملات">{q || status ? <p className="mkt-muted">لا نتائج لهذه الفلاتر.</p> : <p className="mkt-muted">ابدأ بإنشاء حملة: اسمها وهدفها ومنتجها ورابط هبوطها، ويُنشأ رمز التتبع تلقائياً.</p>}</Sec>
      ) : data ? (
        <Sec title={`الحملات (${data.rows.length})`}>
          <div className="mkt-scroll"><table className="mkt-table" data-testid="campaigns-table">
            <thead><tr><th>الحملة</th><th>الهدف</th><th>الحالة</th><th>القنوات</th><th>الفترة</th><th className="n">الميزانية المخططة</th><th className="n">الإنفاق المسجل</th><th className="n">منشورات</th><th className="n">طلبات</th></tr></thead>
            <tbody>{data.rows.map((c) => (
              <tr key={c.id} data-testid={`campaign-${c.utmCampaign}`}>
                <td><Link href={`/dashboard/marketing/campaigns/${c.id}`} className="font-semibold">{c.name}</Link><div className="mkt-muted"><bdi>{c.utmCampaign}</bdi></div></td>
                <td>{OBJECTIVES[c.objective]}</td>
                <td><StatusChip map={CAMPAIGN_STATUS} value={c.status} /></td>
                <td className="mkt-muted">{c.channels.map((ch) => platformName(ch)).join("، ") || "—"}</td>
                <td className="mkt-muted">{fmtDate(c.startAt)} → {fmtDate(c.endAt)}</td>
                <td className="n">{fmt(c.plannedBudget, { unit: "SAR" })}</td>
                <td className="n">{fmt(c.spend, { unit: "SAR" })}</td>
                <td className="n">{c.counts.posts}</td>
                <td className="n">{c.counts.storeOrders}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Sec>
      ) : null}
      {editing ? <CampaignForm existing={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} /> : null}
    </div>
  );
}
