"use client";

import Link from "next/link";
import { useState } from "react";
import {
  useLang, PageHeader, Spinner, Button, Banner, Sec, StatusChip, useLoad, useMkt, usePageTitle, fmt, fmtDate, platformName, CAMPAIGN_STATUS, OBJECTIVES, SearchField, specLabel,
} from "../_components/ui";
import { CampaignForm, type CampaignRow } from "./form";

export default function CampaignsPage() {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  usePageTitle("الحملات", "Campaigns", lang);
  const { can } = useMkt();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useLoad<{ rows: (CampaignRow & { spend: number | null; counts: { posts: number; messages: number; storeOrders: number } })[] }>(`/api/marketing/campaigns?q=${encodeURIComponent(q)}&status=${status}`);
  const [editing, setEditing] = useState<CampaignRow | "new" | null>(null);

  return (
    <div className="mkt" data-testid="mkt-campaigns">
      <PageHeader title={L("الحملات", "Campaigns")} subtitle={L("العمود الفقري للتسويق: كل منشور ورسالة وبند ميزانية وطلب متجر يرتبط بحملة عبر رمز utm_campaign.", "The backbone of marketing: every post, message, budget line and store order links to a campaign through its utm_campaign code.")} actions={can("campaigns_manage") ? <Button testId="new-campaign" onClick={() => setEditing("new")}>{L("حملة جديدة", "New campaign")}</Button> : null} />
      <div className="mkt-toolbar">
        <SearchField value={q} onChange={setQ} placeholder={L("ابحث باسم الحملة أو رمزها", "Search by campaign name or code")} label={L("بحث", "Search")} />
        <div className="mkt-seg" role="group" aria-label={L("الحالة", "Status")}>
          {["", "DRAFT", "PLANNED", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"].map((s) => (
            <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? specLabel(CAMPAIGN_STATUS, s, lang) : L("الكل", "All")}</button>
          ))}
        </div>
      </div>
      <Banner>{error}</Banner>
      {loading && !data ? <Spinner /> : data && data.rows.length === 0 ? (
        <Sec title={L("لا توجد حملات", "No campaigns")}>{q || status ? <p className="mkt-muted">{L("لا نتائج لهذه الفلاتر.", "No results for these filters.")}</p> : <p className="mkt-muted">{L("ابدأ بإنشاء حملة: اسمها وهدفها ومنتجها ورابط هبوطها، ويُنشأ رمز التتبع تلقائياً.", "Start by creating a campaign: its name, objective, product and landing page; the tracking code is created automatically.")}</p>}</Sec>
      ) : data ? (
        <Sec title={L(`الحملات (${data.rows.length})`, `Campaigns (${data.rows.length})`)}>
          <div className="mkt-scroll"><table className="mkt-table" data-testid="campaigns-table">
            <thead><tr><th>{L("الحملة", "Campaign")}</th><th>{L("الهدف", "Objective")}</th><th>{L("الحالة", "Status")}</th><th>{L("القنوات", "Channels")}</th><th>{L("الفترة", "Period")}</th><th className="n">{L("الميزانية المخططة", "Planned budget")}</th><th className="n">{L("الإنفاق المسجل", "Recorded spend")}</th><th className="n">{L("منشورات", "Posts")}</th><th className="n">{L("طلبات", "Orders")}</th></tr></thead>
            <tbody>{data.rows.map((c) => (
              <tr key={c.id} data-testid={`campaign-${c.utmCampaign}`}>
                <td><Link href={`/dashboard/marketing/campaigns/${c.id}`} className="font-semibold">{c.name}</Link><div className="mkt-muted"><bdi>{c.utmCampaign}</bdi></div></td>
                <td>{specLabel(OBJECTIVES, c.objective, lang)}</td>
                <td><StatusChip map={CAMPAIGN_STATUS} value={c.status} /></td>
                <td className="mkt-muted">{c.channels.map((ch) => platformName(ch, lang)).join(L("، ", ", ")) || "—"}</td>
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
