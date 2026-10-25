"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLang, PageHeader, Spinner, Button, Banner, Sec, Chip, useLoad, useMkt, usePageTitle, api, platformName, POST_STATUS, OBJECTIVES, Select } from "../_components/ui";
import { PostEditor, type PostRow } from "./editor";
import { SOCIAL_PLATFORMS } from "@/lib/marketing/platforms";

/**
 * «تقويم النشر» — month and week views in Asia/Riyadh. Drag a post to another day to move it
 * (the time of day is kept); a post that is already approved asks for the reason, which is stored
 * with who moved it. Insights beside it: empty days, near-duplicate captions, objective mix and the
 * account's own best publishing hours (or «بيانات غير كافية»).
 */

const TZ = "Asia/Riyadh";
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

function monthGrid(year: number, month: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(first.getTime() - first.getUTCDay() * 86_400_000);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * 86_400_000));
}

export default function CalendarRoute() {
  return <Suspense fallback={<Spinner />}><CalendarPage /></Suspense>;
}

function CalendarPage() {
  const lang = useLang();
  usePageTitle("تقويم النشر", "Publishing calendar", lang);
  const { can } = useMkt();
  const search = useSearchParams();
  const [now] = useState(() => new Date());
  const [y, setY] = useState(Number(ymd(now).slice(0, 4)));
  const [m, setM] = useState(Number(ymd(now).slice(5, 7)) - 1);
  const [view, setView] = useState<"month" | "week">("month");
  const [weekStart, setWeekStart] = useState(() => { const t = new Date(`${ymd(now)}T00:00:00Z`); return new Date(t.getTime() - t.getUTCDay() * 86_400_000); });
  const [platform, setPlatform] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; date?: string } | null>(() => (search.get("post") ? { id: search.get("post") } : null));
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const days = view === "month" ? monthGrid(y, m) : Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * 86_400_000));
  const from = `${days[0].toISOString().slice(0, 10)}T00:00:00+03:00`;
  const to = `${new Date(days[days.length - 1].getTime() + 86_400_000).toISOString().slice(0, 10)}T00:00:00+03:00`;
  const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&platform=${platform}&campaignId=${campaignId}`;
  const posts = useLoad<{ rows: PostRow[] }>(`/api/marketing/posts?${qs}`);
  const drafts = useLoad<{ rows: PostRow[] }>(`/api/marketing/posts?unscheduled=1&campaignId=${campaignId}`);
  const campaigns = useLoad<{ rows: { id: string; name: string }[] }>("/api/marketing/campaigns");
  const insights = useLoad<{ plan: { total: number; gaps: string[]; objectiveMix: Record<string, number>; duplicates: { a: string; b: string; similarity: number }[] }; bestHours: Record<string, { measured: number; hours: { hour: number; avgEngagements: number; posts: number }[] | null }> }>(`/api/marketing/posts/insights?from=${days[0].toISOString().slice(0, 10)}&to=${days[days.length - 1].toISOString().slice(0, 10)}`);


  const byDay = useMemo(() => {
    const map = new Map<string, PostRow[]>();
    for (const p of posts.data?.rows ?? []) if (p.scheduledAt) (map.get(ymd(new Date(p.scheduledAt))) ?? map.set(ymd(new Date(p.scheduledAt)), []).get(ymd(new Date(p.scheduledAt)))!).push(p);
    return map;
  }, [posts.data]);

  async function drop(day: string) {
    const p = posts.data?.rows.find((x) => x.id === dragId) ?? drafts.data?.rows.find((x) => x.id === dragId);
    setDragId(null); setOver(null);
    if (!p || !can("content_manage")) return;
    const time = p.scheduledAt ? new Date(new Date(p.scheduledAt).getTime() + 3 * 3600_000).toISOString().slice(11, 16) : "19:00";
    let reason: string | null = null;
    if (["APPROVED", "SCHEDULED", "IN_REVIEW"].includes(p.status)) {
      reason = prompt(`سبب نقل «${p.title}» إلى ${day}:`);
      if (!reason) return;
    }
    const r = await api(`/api/marketing/posts/${p.id}/schedule`, { method: "POST", body: { scheduledAt: `${day}T${time}:00+03:00`, reason } });
    if (!r.ok) setErr(r.data.error ?? "");
    posts.reload(); drafts.reload(); insights.reload();
  }

  const card = (p: PostRow) => (
    <button key={p.id} type="button" className="mkt-card" data-status={p.status} draggable={can("content_manage") && !["PUBLISHED", "PUBLISHING", "CANCELLED"].includes(p.status)}
      onDragStart={() => setDragId(p.id)} onClick={() => setEditing({ id: p.id })} title={`${p.title} · ${POST_STATUS[p.status]?.ar} · ${p.variants.map((v) => platformName(v.platform)).join("، ")}`} data-testid={`card-${p.id}`}>
      {p.scheduledAt ? <bdi>{new Date(new Date(p.scheduledAt).getTime() + 3 * 3600_000).toISOString().slice(11, 16)}</bdi> : null} {p.title}
    </button>
  );
  const dayCell = (d: Date, extra = "") => {
    const key = d.toISOString().slice(0, 10);
    return (
      <div key={key} className={`day ${extra} ${key === ymd(now) ? "today" : ""} ${over === key ? "drop" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(key); }} onDragLeave={() => setOver(null)} onDrop={() => drop(key)} data-testid={`day-${key}`}>
        <span className="dn"><bdi>{d.getUTCDate()}</bdi></span>
        {(byDay.get(key) ?? []).map(card)}
        {can("content_manage") ? <button type="button" className="mkt-muted" style={{ textAlign: "start" }} onClick={() => setEditing({ id: null, date: key })} aria-label={`منشور جديد في ${key}`}>+</button> : null}
      </div>
    );
  };

  return (
    <div className="mkt" data-testid="mkt-calendar">
      <PageHeader title="تقويم النشر وخطة المحتوى" subtitle="اسحب المنشور ليوم آخر لتغيير موعده. التوقيت: الرياض." actions={can("content_manage") ? <Button onClick={() => setEditing({ id: null })} testId="new-post">منشور جديد</Button> : null} />
      <div className="mkt-toolbar">
        <div className="mkt-seg" role="group" aria-label="العرض">
          <button type="button" aria-pressed={view === "month"} onClick={() => setView("month")}>شهري</button>
          <button type="button" aria-pressed={view === "week"} onClick={() => setView("week")}>أسبوعي</button>
        </div>
        {view === "month" ? <>
          <Button variant="secondary" onClick={() => (m === 0 ? (setM(11), setY(y - 1)) : setM(m - 1))}>السابق</Button>
          <strong data-testid="month-label">{MONTHS[m]} <bdi>{y}</bdi></strong>
          <Button variant="secondary" onClick={() => (m === 11 ? (setM(0), setY(y + 1)) : setM(m + 1))}>التالي</Button>
        </> : <>
          <Button variant="secondary" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * 86_400_000))}>الأسبوع السابق</Button>
          <strong><bdi>{days[0].toISOString().slice(0, 10)}</bdi> → <bdi>{days[6].toISOString().slice(0, 10)}</bdi></strong>
          <Button variant="secondary" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * 86_400_000))}>الأسبوع التالي</Button>
        </>}
        <span className="sp" />
        <div className="mkt-narrow"><Select id="f-pl" value={platform} onChange={setPlatform}><option value="">كل المنصات</option>{SOCIAL_PLATFORMS.map((p) => <option key={p} value={p}>{platformName(p)}</option>)}</Select></div>
        <div className="mkt-narrow"><Select id="f-c" value={campaignId} onChange={setCampaignId}><option value="">كل الحملات</option>{campaigns.data?.rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
      </div>
      <Banner onClose={() => setErr("")}>{err || posts.error}</Banner>
      <div className="mkt-toolbar">{Object.entries(POST_STATUS).filter(([k]) => k !== "CANCELLED").map(([k, s]) => <span key={k} className="mkt-card" data-status={k} style={{ width: "auto", cursor: "default" }}>{s.ar}</span>)}</div>

      {posts.loading && !posts.data ? <Spinner /> : view === "month" ? (
        <div className="mkt-cal" data-testid="month-grid">
          {DAYS.map((d) => <div key={d} className="hd">{d}</div>)}
          {days.map((d) => dayCell(d, d.getUTCMonth() !== m ? "out" : ""))}
        </div>
      ) : (
        <div className="mkt-week" data-testid="week-grid">
          {days.map((d, i) => (
            <div key={i} className={`col ${over === d.toISOString().slice(0, 10) ? "drop" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(d.toISOString().slice(0, 10)); }} onDrop={() => drop(d.toISOString().slice(0, 10))}>
              <strong>{DAYS[d.getUTCDay()]} <bdi>{d.toISOString().slice(5, 10)}</bdi></strong>
              {(byDay.get(d.toISOString().slice(0, 10)) ?? []).map(card)}
              {can("content_manage") ? <button type="button" className="mkt-muted" onClick={() => setEditing({ id: null, date: d.toISOString().slice(0, 10) })}>+ منشور</button> : null}
            </div>
          ))}
        </div>
      )}

      <div className="mkt-grid-2">
        <Sec title="مسودات بلا موعد" caption="اسحبها إلى يوم في التقويم." testId="unscheduled">
          {drafts.data?.rows.length ? <div className="mkt-list">{drafts.data.rows.map(card)}</div> : <p className="mkt-muted">لا مسودات بلا موعد.</p>}
        </Sec>
        <Sec title="تحليل الخطة" testId="insights">
          {!insights.data ? <Spinner /> : <>
            <p>منشورات الفترة: <bdi>{insights.data.plan.total}</bdi> · أيام بلا محتوى: <bdi>{insights.data.plan.gaps.length}</bdi></p>
            <div className="mkt-toolbar">{Object.entries(insights.data.plan.objectiveMix).map(([k, n]) => <Chip key={k}>{OBJECTIVES[k] ?? k}: {n}</Chip>)}</div>
            {insights.data.plan.duplicates.length ? <div className="mkt-banner warn" style={{ marginTop: 8 }}>نصوص متشابهة: {insights.data.plan.duplicates.map((d) => `«${d.a}» و«${d.b}» (${d.similarity}%)`).join("، ")}</div> : null}
            <h3 className="font-bold text-sm mt-3">أفضل ساعات النشر لحساباتكم</h3>
            {Object.keys(insights.data.bestHours).length === 0 ? <p className="mkt-muted">بيانات غير كافية: تحتاج منشورات منشورة بمقاييس تفاعل على مستوى المنشور.</p> : Object.entries(insights.data.bestHours).map(([pl, b]) => (
              <p key={pl} className="mkt-muted">{platformName(pl)}: {b.hours ? b.hours.map((h) => `${h.hour}:00 (متوسط ${h.avgEngagements} تفاعل، ${h.posts} منشور)`).join("، ") : `بيانات غير كافية (${b.measured} منشور مقاس، المطلوب 5)`}</p>
            ))}
          </>}
        </Sec>
      </div>

      {editing ? <PostEditor postId={editing.id} initialDate={editing.date} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); posts.reload(); drafts.reload(); insights.reload(); }} /> : null}
    </div>
  );
}
