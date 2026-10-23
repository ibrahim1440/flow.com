"use client";

// «التنبيهات» — the bell in the top bar of EVERY signed-in account (feat/notifications; it replaces
// the Settings-only system alerts bell, whose storage incidents are now «system» notifications).
// The unread count, and a panel of the latest items — icon, title, time, link — with «تعليم الكل
// كمقروء» and «عرض كل التنبيهات». Polls every 60 s and when the window regains focus; no websockets.
// GET /api/notifications answers for the session's own account only. Direction 2.1 tokens only.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Ico } from "@/components/shell/icons";
import { CATEGORY_ICON, markRead, relTime, type ListResponse, type Item } from "./shared";
import "./notifications.css";

const POLL_MS = 60_000;
/** The shell draws a phone header below 768 px and the top bar above (direction-2.1.css). */
const PHONE_MQ = "(max-width: 767px)";
const subscribe = (cb: () => void) => { const m = window.matchMedia(PHONE_MQ); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };
const isPhone = () => window.matchMedia(PHONE_MQ).matches;

/** Both placements are mounted by the shell; only the one on screen is drawn and polls. */
export function NotificationsBell({ lang, phone = false }: { lang: "ar" | "en"; phone?: boolean }) {
  const phoneNow = useSyncExternalStore(subscribe, isPhone, () => false);
  if (phoneNow !== phone) return null;
  return <Bell lang={lang} phone={phone} />;
}

function Bell({ lang, phone }: { lang: "ar" | "en"; phone: boolean }) {
  const ar = lang === "ar";
  const router = useRouter();
  const [data, setData] = useState<ListResponse | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const load = useCallback(() => {
    fetch("/api/notifications?limit=8", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ListResponse | null) => { if (d) setData(d); })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    const onFocus = () => load();
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("hq-notifications-changed", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("hq-notifications-changed", onFocus); };
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  if (!data) return null;
  const unread = data.unread;
  const openItem = async (n: Item) => {
    setOpen(false);
    if (!n.readAt) await markRead({ ids: [n.id] });
    if (n.link) router.push(n.link);
  };
  return (
    <div className={`d21-bell nf-bell${phone ? " ph" : ""}`} ref={box} data-testid="notifications-bell">
      <button type="button" className="d21-ib d21-bell-btn" aria-haspopup="dialog" aria-expanded={open}
        aria-label={ar ? `التنبيهات${unread ? ` (${unread} غير مقروء)` : ""}` : `Notifications${unread ? ` (${unread} unread)` : ""}`}
        onClick={() => { setOpen((v) => !v); if (!open) load(); }}>
        <Ico name="bell" small={!phone} />
        {unread ? <span className="d21-bell-n" data-testid="notifications-unread">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="d21-bell-panel nf-panel" role="dialog" aria-label={ar ? "التنبيهات" : "Notifications"} data-testid="notifications-panel">
          <div className="d21-bell-h">
            <b>{ar ? "التنبيهات" : "Notifications"}</b>
            {unread ? <button type="button" onClick={() => void markRead({ all: true })} data-testid="notifications-read-all">{ar ? "تعليم الكل كمقروء" : "Mark all as read"}</button> : null}
          </div>
          {data.items.length === 0 ? <p className="d21-bell-empty">{ar ? "لا تنبيهات بعد." : "No notifications yet."}</p> : (
            <ol className="nf-list">
              {data.items.map((n) => (
                <li key={n.id}>
                  <button type="button" className={`nf-item tone-${n.severity}${n.readAt ? "" : " unread"}`} onClick={() => void openItem(n)} data-testid={`notification-${n.kind}`}>
                    <span className={`nf-ic cat-${n.category}`} aria-hidden><Ico name={CATEGORY_ICON[n.category] ?? "bell"} small /></span>
                    <span className="nf-txt">
                      <span className="t">{ar ? n.titleAr : n.titleEn}</span>
                      {(ar ? n.bodyAr : n.bodyEn) ? <span className="b">{ar ? n.bodyAr : n.bodyEn}</span> : null}
                      <time className="w" dateTime={n.createdAt}>{relTime(n.createdAt, ar)}</time>
                    </span>
                    {n.readAt ? null : <span className="nf-dot" aria-label={ar ? "غير مقروء" : "Unread"} />}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="nf-foot">
            <Link href="/dashboard/notifications" onClick={() => setOpen(false)} data-testid="notifications-all">{ar ? "عرض كل التنبيهات" : "See all notifications"}</Link>
            <Link href="/dashboard/profile?tab=notifications" onClick={() => setOpen(false)}>{ar ? "إعدادات التنبيهات" : "Notification settings"}</Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
