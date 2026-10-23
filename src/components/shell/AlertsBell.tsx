"use client";

// «التنبيهات» — the system alerts bell (feat/credit-hold). The ERP had no in-app notification
// mechanism, so this is the minimal one: a bell in the top bar for the accounts that hold Settings
// at edit (GET /api/system/alerts re-checks it), its unread count, and a small panel of the latest
// alerts (storage incidents and their recovery) with «تحديد الكل كمقروء». Direction 2.1 tokens only.
import { useEffect, useRef, useState } from "react";
import { Ico } from "./icons";
import "./alerts-bell.css";

type Alert = { id: string; kind: string; severity: "danger" | "warning" | "success" | "info"; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; createdAt: string; readAt: string | null; emailStatus: string };
type Data = { alerts: Alert[]; unread: number };

const fmt = (iso: string, ar: boolean) =>
  new Intl.DateTimeFormat(ar ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { timeZone: "Asia/Riyadh", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

export function AlertsBell({ lang, phone = false }: { lang: "ar" | "en"; phone?: boolean }) {
  const ar = lang === "ar";
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let off = false;
    const run = () => fetch("/api/system/alerts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Data | null) => { if (!off && d) setData(d); })
      .catch(() => undefined);
    void run();
    const t = setInterval(run, 180_000);
    return () => { off = true; clearInterval(t); };
  }, [tick]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  async function markAll() {
    await fetch("/api/system/alerts/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    setTick((x) => x + 1);
  }
  if (!data) return null;
  const unread = data.unread;
  return (
    <div className={`d21-bell${phone ? " ph" : ""}`} ref={box} data-testid="alerts-bell">
      <button type="button" className="d21-ib d21-bell-btn" aria-haspopup="dialog" aria-expanded={open}
        aria-label={ar ? `التنبيهات${unread ? ` (${unread} غير مقروء)` : ""}` : `Alerts${unread ? ` (${unread} unread)` : ""}`}
        onClick={() => setOpen((v) => !v)}>
        <Ico name="bell" small={!phone} />
        {unread ? <span className="d21-bell-n" data-testid="alerts-unread">{unread > 9 ? "9+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="d21-bell-panel" role="dialog" aria-label={ar ? "التنبيهات" : "Alerts"} data-testid="alerts-panel">
          <div className="d21-bell-h">
            <b>{ar ? "تنبيهات النظام" : "System alerts"}</b>
            {unread ? <button type="button" onClick={markAll} data-testid="alerts-read-all">{ar ? "تحديد الكل كمقروء" : "Mark all read"}</button> : null}
          </div>
          {data.alerts.length === 0 ? <p className="d21-bell-empty">{ar ? "لا تنبيهات." : "No alerts."}</p> : (
            <ol className="d21-bell-list">
              {data.alerts.map((a) => (
                <li key={a.id} className={`tone-${a.severity}${a.readAt ? "" : " unread"}`} data-testid={`alert-${a.kind}`}>
                  <div className="t">{ar ? a.titleAr : a.titleEn}</div>
                  <div className="b">{ar ? a.bodyAr : a.bodyEn}</div>
                  <div className="w">{fmt(a.createdAt, ar)} · {a.emailStatus === "SENT" ? (ar ? "أُرسل بالبريد" : "e-mailed") : a.emailStatus === "FAILED" ? (ar ? "تعذّر إرسال البريد" : "e-mail failed") : a.emailStatus === "NO_RECIPIENTS" ? (ar ? "لا يوجد بريد مسجّل" : "no e-mail on record") : (ar ? "البريد غير مُعدّ" : "e-mail not configured")}</div>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  );
}
