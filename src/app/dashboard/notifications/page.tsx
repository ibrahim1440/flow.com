"use client";

// «التنبيهات» — the signed-in person's full list (feat/notifications): every category or one, all or
// unread only, newest first, 30 at a time («عرض المزيد»). Each row: the category icon, the title,
// the text, the time and «فتح»; unread rows are marked and «تعليم كمقروء» / «تعليم الكل كمقروء»
// mark them read (nothing is deleted; rows older than 90 days are removed). Every account reaches it
// (the bell's «عرض كل التنبيهات»); GET /api/notifications answers for the session's own account only.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { Btn, OpsEmpty, OpsError, OpsLoading, OpsRoot, PageHeader } from "@/components/ops/ui";
import { Ico } from "@/components/shell/icons";
import { CATEGORIES, CATEGORY_LABEL, type Category } from "@/lib/notifications/catalog";
import { CATEGORY_ICON, markRead, relTime, type Item, type ListResponse } from "@/components/notifications/shared";
import "@/components/notifications/notifications.css";

export default function NotificationsPage() {
  const { lang } = useI18n();
  const ar = lang === "ar";
  const [cat, setCat] = useState<Category | "">("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [data, setData] = useState<ListResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const q = useCallback((before?: string | null) => {
    const p = new URLSearchParams({ limit: "30" });
    if (cat) p.set("category", cat);
    if (unreadOnly) p.set("unread", "1");
    if (before) p.set("before", before);
    return fetch(`/api/notifications?${p}`, { cache: "no-store" }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error ?? String(r.status));
      return (await r.json()) as ListResponse;
    });
  }, [cat, unreadOnly]);
  const load = useCallback(() => { q().then((d) => { setErr(null); setData(d); }, (e: Error) => setErr(e.message)); }, [q]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const on = () => load();
    window.addEventListener("hq-notifications-changed", on);
    window.addEventListener("focus", on);
    return () => { window.removeEventListener("hq-notifications-changed", on); window.removeEventListener("focus", on); };
  }, [load]);
  const loadMore = async () => {
    if (!data?.next) return;
    setMore(true);
    try { const d = await q(data.next); setData({ ...d, items: [...data.items, ...d.items] }); } catch (e) { setErr((e as Error).message); } finally { setMore(false); }
  };
  const label = (c: Category) => (ar ? CATEGORY_LABEL[c].ar : CATEGORY_LABEL[c].en);
  const count = (c: Category | "") => (c ? data?.unreadByCategory[c] ?? 0 : data?.unread ?? 0);
  return (
    <OpsRoot>
      <div className="hr-page" data-testid="nf-page">
      <PageHeader title={ar ? "التنبيهات" : "Notifications"}
        actions={<>
          <Link href="/dashboard/profile?tab=notifications" className="hr-btn is-ghost is-sm">{ar ? "إعدادات التنبيهات" : "Notification settings"}</Link>
          <Btn size="sm" disabled={!data?.unread} onClick={() => void markRead({ all: true, ...(cat ? { category: cat } : {}) })} data-testid="nf-read-all">{ar ? "تعليم الكل كمقروء" : "Mark all as read"}</Btn>
        </>}>
        <span>{data ? (ar ? `${data.unread} غير مقروء` : `${data.unread} unread`) : " "}</span>
      </PageHeader>
      <div className="nf-page-filters">
        <div className="nf-cats" role="group" aria-label={ar ? "الفئة" : "Category"}>
          {(["", ...CATEGORIES] as (Category | "")[]).map((c) => (
            <button key={c || "all"} type="button" className="nf-cat" aria-pressed={cat === c} onClick={() => setCat(c)} data-testid={`nf-cat-${c || "all"}`}>
              {c ? label(c) : ar ? "الكل" : "All"}
              {count(c) ? <span className="n">{count(c)}</span> : null}
            </button>
          ))}
        </div>
        <span className="nf-sp" />
        <label className="nf-switch">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} data-testid="nf-unread-only" />
          {ar ? "غير المقروء فقط" : "Unread only"}
        </label>
      </div>
      {err ? <OpsError message={err} onRetry={load} /> : !data ? <OpsLoading rows={6} /> : data.items.length === 0 ? (
        <OpsEmpty title={unreadOnly ? (ar ? "لا تنبيهات غير مقروءة." : "No unread notifications.") : (ar ? "لا تنبيهات بعد." : "No notifications yet.")}
          body={ar ? "تصلك هنا الأمور التي تخصك: عملاؤك وطلباتهم، الإنتاج، الجودة، المالية، وشؤونك أنت مثل قسيمة الراتب والإجازات." : "What concerns you arrives here: your customers and their orders, production, quality, finance, and your own work such as payslips and leave."} />
      ) : (
        <>
          <ol className="nf-rows" data-testid="nf-rows">
            {data.items.map((n: Item) => (
              <li key={n.id} className={`nf-row tone-${n.severity}${n.readAt ? "" : " unread"}`} data-testid={`nf-row-${n.kind}`}>
                <span className={`nf-ic cat-${n.category}`} aria-hidden><Ico name={CATEGORY_ICON[n.category] ?? "bell"} small /></span>
                <span className="nf-txt">
                  <span className="t">{ar ? n.titleAr : n.titleEn}</span>
                  {(ar ? n.bodyAr : n.bodyEn) ? <span className="b">{ar ? n.bodyAr : n.bodyEn}</span> : null}
                  <span className="nf-meta">
                    <span>{label(n.category)}</span>
                    <time dateTime={n.createdAt}>{relTime(n.createdAt, ar)}</time>
                    {n.emailState === "SENT" ? <span>{ar ? "أُرسل بالبريد" : "e-mailed"}</span> : null}
                  </span>
                </span>
                <span className="nf-acts">
                  {n.readAt ? null : <Btn size="sm" variant="ghost" onClick={() => void markRead({ ids: [n.id] })} aria-label={ar ? "تعليم كمقروء" : "Mark as read"}><Ico name="check" small /></Btn>}
                  {n.link ? <Link href={n.link} className="hr-btn is-sm" onClick={() => { if (!n.readAt) void markRead({ ids: [n.id] }); }}>{ar ? "فتح" : "Open"}</Link> : null}
                </span>
              </li>
            ))}
          </ol>
          {data.next ? <div className="nf-more"><Btn onClick={() => void loadMore()} busy={more}>{ar ? "عرض المزيد" : "Show more"}</Btn></div> : null}
        </>
      )}
      </div>
    </OpsRoot>
  );
}
