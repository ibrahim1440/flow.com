"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { routeAllowed, type Viewer } from "@/lib/nav/registry";
import { createActions } from "@/components/shell/creates";
import { Ico } from "@/components/shell/icons";
import { useD21Phone } from "@/components/shell/page-context";
import { OrderStatusBadge } from "@/components/OrderLifecyclePanel";
import { OpsRoot, OpsError, OpsLoading, OpsEmpty, countNoun, ORDER_FORMS, BATCH_FORMS } from "@/components/ops/ui";
import type { TodayData } from "@/lib/services/dashboard/today";
import { useUser } from "./user-context";
import "./home.css";

/**
 * «اليوم» — the operations dashboard, rebuilt to the approved Direction 2.1 frames
 * (Figma 1JbZgpMqmPkUVne8ms9Ozz: Desktop 1440 `20:236`, Compact 1024 `24:842`,
 * Mobile 390 `34:1405` / `37:1376`).
 *
 * Every figure comes from GET /api/dashboard/today (src/lib/services/dashboard/today.ts), which
 * is read-only and gated by the «dashboard» module like the previous /api/analytics. Blocks of
 * the frame the application has no source for — sales and collections money, the priority line
 * (supplier lead time), the roaster timeline (no roaster schedule), the delivery date and value
 * of an order — are not drawn: no placeholder figures (owner decision, Login/Dashboard parity).
 */

type Lang = "ar" | "en";
const DAY_FORMS: [string, string, string, string, string, string] = ["يوم واحد", "يومان", "أيام", "يومًا", "day", "days"];
const HOUR_FORMS: [string, string, string, string, string, string] = ["ساعة واحدة", "ساعتان", "ساعات", "ساعة", "hour", "hours"];

const TX = {
  ar: {
    title: "اليوم", updated: "آخر تحديث", newOrder: "طلب جديد",
    roasted: "مُحمّص اليوم", kg: "كغ", loss: "الفاقد",
    pipeline: "مسار الطلبات", open: "مفتوحًا", onHold: "معلّق",
    stApproval: "بانتظار الاعتماد", stRoasting: "قيد التحميص", stQc: "بانتظار الجودة", stPacking: "قيد التعبئة", stReady: "جاهز للشحن", stDelivered: "سُلّم اليوم",
    longest: "أطول انتظار",
    action: "تحتاج إجراء", oldest: "الأقدم أولًا", allOrders: "كل الطلبات",
    colOrder: "الطلب", colOrders: "الطلبات", colCustomer: "العميل", colKg: "كغ", colStatus: "الحالة",
    open1: "فتح", ship: "تأكيد الشحن", review: "مراجعة",
    noAction: "لا توجد طلبات تنتظر إجراءً الآن.",
    green: "استمرارية البن الأخضر", greenM: "البن الأخضر", cover: "أيام التغطية بمعدل الاستهلاك", coverM: "أيام التغطية",
    scale: (d: number, w: number) => `المقياس حتى ${d} يومًا · الاستهلاك بمتوسط آخر ${w} يومًا`,
    noGreen: "لا يوجد بن أخضر نشط استُهلك في آخر 28 يومًا.",
    loadFailed: "تعذّر تحميل لوحة اليوم.",
  },
  en: {
    title: "Today", updated: "Updated", newOrder: "New order",
    roasted: "Roasted today", kg: "kg", loss: "loss",
    pipeline: "Order pipeline", open: "open", onHold: "on hold",
    stApproval: "Awaiting approval", stRoasting: "Roasting", stQc: "Awaiting QC", stPacking: "Packing", stReady: "Ready to ship", stDelivered: "Delivered today",
    longest: "Longest wait",
    action: "Needs action", oldest: "Oldest first", allOrders: "All orders",
    colOrder: "Order", colOrders: "Orders", colCustomer: "Customer", colKg: "kg", colStatus: "Status",
    open1: "Open", ship: "Confirm shipping", review: "Review",
    noAction: "No orders are waiting on an action right now.",
    green: "Green coffee continuity", greenM: "Green coffee", cover: "Days of cover at the current usage", coverM: "Days of cover",
    scale: (d: number, w: number) => `Scale up to ${d} days · usage averaged over the last ${w} days`,
    noGreen: "No active green coffee was used in the last 28 days.",
    loadFailed: "Could not load today's dashboard.",
  },
} as const;

const fmt = (n: number, d = 1) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Riyadh date and time, Latin digits, Gregorian (the shell's rule). */
function stamp(iso: string, lang: Lang) {
  const d = new Date(iso);
  const date = d.toLocaleDateString(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { timeZone: "Asia/Riyadh", weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", minute: "2-digit", hour12: false });
  return { date, time };
}

export default function DashboardPage() {
  const { lang: rawLang } = useI18n();
  const lang: Lang = rawLang === "en" ? "en" : "ar";
  const t = TX[lang];
  const user = useUser();
  const viewer: Viewer | null = user ? { permissions: user.permissions, role: user.role } : null;
  const can = (href: string) => !!viewer && routeAllowed(viewer, href);
  const newOrder = viewer ? createActions(viewer, "operations").find((a) => a.id === "orders.order.new") ?? null : null;

  const [data, setData] = useState<TodayData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch("/api/dashboard/today", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) { setState("denied"); return; }
      if (!res.ok) { setState("error"); return; }
      setData(await res.json());
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);
  useEffect(() => { load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect -- the first load is the page's own fetch

  const when = data ? stamp(data.generatedAt, lang) : null;
  useD21Phone(when ? { title: t.title, sub: `${when.date} · ${lang === "ar" ? "محدّث" : "updated"} ${when.time}` } : { title: t.title });

  if (state === "denied") {
    return (
      <OpsRoot>
        <div className="dh-page" data-testid="dashboard-denied">
          <OpsEmpty title={lang === "ar" ? "لا يوجد وصول للوحة التحكم" : "No dashboard access"} body={lang === "ar" ? "استخدم القائمة الجانبية للتنقل إلى الوحدات المخصصة لك." : "Use the sidebar to navigate to your assigned modules."} />
        </div>
      </OpsRoot>
    );
  }

  const head = (
    <div className="dh-head">
      <div>
        <h1>{t.title}</h1>
        <div className="dh-meta" data-testid="dash-meta">
          {/* PageHeader meta (I101:7003;41:242): date • branch • last updated. The branch segment is
              left out: the application has no configured site / branch to name (no fabrication). */}
          {when ? <><span>{when.date}</span><i aria-hidden /><span>{t.updated} <span className="hr-num">{when.time}</span></span></> : <span>&nbsp;</span>}
        </div>
      </div>
      {newOrder ? (
        <div className="dh-actions">
          <Link href={newOrder.href} className="hr-btn is-primary" data-testid="dash-new-order"><Ico name="plus" small />{t.newOrder}</Link>
        </div>
      ) : null}
    </div>
  );

  if (state === "error") {
    return <OpsRoot><div className="dh-page">{head}<div style={{ marginTop: 24 }}><OpsError message={t.loadFailed} onRetry={load} /></div></div></OpsRoot>;
  }
  if (state === "loading" || !data) {
    return <OpsRoot><div className="dh-page">{head}<div style={{ marginTop: 24 }}><OpsLoading rows={8} /></div></div></OpsRoot>;
  }

  const p = data.pipeline;
  const stages: { key: string; n: number; label: string; warn?: boolean; sub?: string }[] = [
    { key: "approval", n: p.approval, label: t.stApproval },
    { key: "roasting", n: p.roasting, label: t.stRoasting },
    { key: "qc", n: p.qc, label: t.stQc, warn: p.qcOverdue, sub: p.qcLongestHours !== null ? `${t.longest} ${countNoun(p.qcLongestHours, lang, HOUR_FORMS)}` : undefined },
    { key: "packing", n: p.packing, label: t.stPacking },
    { key: "ready", n: p.ready, label: t.stReady },
    { key: "delivered", n: p.deliveredToday, label: t.stDelivered },
  ];
  const openText = lang === "ar" ? `${countNoun(p.open, "ar", ORDER_FORMS)} ${p.open === 1 ? "مفتوح" : p.open === 2 ? "مفتوحان" : t.open}` : `${p.open} ${t.open}`;
  const holdText = p.onHold > 0 ? ` · ${p.onHold} ${t.onHold}` : "";

  const actionFor = (stage: string): { label: string; href: string } => {
    if (stage === "ready") return { label: t.ship, href: "/dashboard/dispatch" };
    if (stage === "approval") return { label: t.review, href: "/dashboard/orders" };
    return { label: t.open1, href: "/dashboard/orders" };
  };
  const na = data.needsAction;
  const name = (c: { name: string; nameAr: string | null }) => (lang === "ar" && c.nameAr ? c.nameAr : c.name);
  const r = data.roasted;

  return (
    <OpsRoot>
      <div className="dh-page" data-testid="dashboard-today">
        {head}

        {/* MetricStrip 101:6845 — only the metric with a source: roasted today (42:8). */}
        <div className="dh-metrics" data-testid="dash-metrics">
          <div className="dh-metric" data-testid="metric-roasted">
            <span className="dh-mlabel">{t.roasted}</span>
            <span className="dh-mvalue"><b>{fmt(r.kg)}</b><small>{t.kg}</small></span>
            <span className="dh-mcap">
              {countNoun(r.batches, lang, BATCH_FORMS)}{r.lossPct !== null ? <> · {t.loss} <span className="hr-num">{fmt(r.lossPct)}%</span></> : null}
            </span>
          </div>
        </div>

        {/* Order pipeline 20:300 / 20:303. */}
        <div className="dh-block dh-pipehead">
          <h2>{t.pipeline}</h2>
          <p data-testid="pipe-open">{openText}{holdText}</p>
        </div>
        <ol className="dh-pipe" data-testid="dash-pipeline">
          {stages.map((s) => (
            <li key={s.key} className={`dh-stage${s.warn ? " is-warning" : ""}`} data-testid={`stage-${s.key}`}>
              <b>{s.n}</b>
              <span>{s.label}{s.sub ? <small>{s.sub}</small> : null}</span>
            </li>
          ))}
        </ol>

        <hr className="dh-divider" />

        <div className="dh-cols">
          {/* «تحتاج إجراء» 20:460 (desktop table) / 37:1376 (phone list). */}
          <section className="dh-col" aria-labelledby="dh-action-h" data-testid="dash-actions">
            <div className="dh-block">
              <h2 id="dh-action-h">{t.action}</h2>
              <p data-testid="action-total">{`${data.needsAction.total} · ${t.oldest}`}</p>
              {can("/dashboard/orders") ? <Link href="/dashboard/orders" className="dh-lk">{t.allOrders}<Ico name="chev" small /></Link> : null}
            </div>
            {na.rows.length === 0 ? <p className="dh-empty">{t.noAction}</p> : na.detail ? (
              <>
                <table className="dh-table" data-detail="customer">
                  <thead>
                    <tr><th>{t.colOrder}</th><th>{t.colCustomer}</th><th className="num">{t.colKg}</th><th>{t.colStatus}</th><th aria-label={lang === "ar" ? "إجراء" : "Action"} /></tr>
                  </thead>
                  <tbody>
                    {na.rows.map((o) => {
                      const a = actionFor(o.stage);
                      return (
                        <tr key={o.id} data-testid={`action-row-${o.orderNumber}`}>
                          <td className="id">#{o.orderNumber}</td>
                          <td className="who">{name(o.customer)}</td>
                          <td className="num">{fmt(o.kg, o.kg % 1 ? 1 : 0)}</td>
                          <td><OrderStatusBadge status={o.status} /></td>
                          <td>{can(a.href) ? <Link href={a.href} className="dh-sbtn">{a.label}</Link> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <ul className="dh-list" data-detail="customer">
                  {na.rows.map((o) => {
                    const a = actionFor(o.stage);
                    return (
                      <li key={o.id}>
                        <div className="l1"><span><span className="id">#{o.orderNumber}</span><span className="who">{name(o.customer)}</span></span><OrderStatusBadge status={o.status} /></div>
                        <div className="l2"><span><span className="hr-num">{fmt(o.kg, o.kg % 1 ? 1 : 0)}</span> {t.kg}</span>{can(a.href) ? <Link href={a.href} className="dh-sbtn">{a.label}</Link> : null}</div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              /* Owner decision F4: without a customer-detail right the server sends one
                 aggregate row per status (orders, kg) — no order numbers, no customers.
                 Figma 20:460 has no masked state, so the customer column is omitted and
                 the order column carries the order count. */
              <>
                <table className="dh-table" data-detail="aggregate">
                  <thead>
                    <tr><th>{t.colOrders}</th><th className="num">{t.colKg}</th><th>{t.colStatus}</th><th aria-label={lang === "ar" ? "إجراء" : "Action"} /></tr>
                  </thead>
                  <tbody>
                    {na.rows.map((g) => {
                      const a = actionFor(g.stage);
                      return (
                        <tr key={g.status} data-testid={`action-group-${g.status}`}>
                          <td className="cnt">{countNoun(g.orders, lang, ORDER_FORMS)}</td>
                          <td className="num">{fmt(g.kg, g.kg % 1 ? 1 : 0)}</td>
                          <td><OrderStatusBadge status={g.status} /></td>
                          <td>{can(a.href) ? <Link href={a.href} className="dh-sbtn">{a.label}</Link> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <ul className="dh-list" data-detail="aggregate">
                  {na.rows.map((g) => {
                    const a = actionFor(g.stage);
                    return (
                      <li key={g.status}>
                        <div className="l1"><span><span className="cnt">{countNoun(g.orders, lang, ORDER_FORMS)}</span></span><OrderStatusBadge status={g.status} /></div>
                        <div className="l2"><span><span className="hr-num">{fmt(g.kg, g.kg % 1 ? 1 : 0)}</span> {t.kg}</span>{can(a.href) ? <Link href={a.href} className="dh-sbtn">{a.label}</Link> : null}</div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>

          {/* «استمرارية البن الأخضر» 20:416 — days of cover; the supplier lead-time marker has no source. */}
          <section className="dh-col" aria-labelledby="dh-green-h" data-testid="dash-green">
            <div className="dh-block">
              <h2 id="dh-green-h">{t.green}</h2>
              <p>{t.cover}</p>
            </div>
            {data.green.rows.length === 0 ? <p className="dh-empty">{t.noGreen}</p> : (
              <>
                <ul className="dh-green">
                  {data.green.rows.map((g) => (
                    <li key={g.id} data-testid="green-row">
                      <span className="dh-gname" title={lang === "ar" && g.nameAr ? g.nameAr : g.name}>{lang === "ar" && g.nameAr ? g.nameAr : g.name}</span>
                      <span className="dh-gkg"><bdi dir="ltr"><span className="hr-num">{fmt(g.kg, g.kg % 1 ? 1 : 0)}</span></bdi> {t.kg}</span>
                      <span className="dh-track" role="img" aria-label={countNoun(g.days, lang, DAY_FORMS)}><i style={{ width: `${Math.min(100, (g.days / data.green.scaleDays) * 100)}%` }} /></span>
                      <span className="dh-gdays">{countNoun(g.days, lang, DAY_FORMS)}</span>
                    </li>
                  ))}
                </ul>
                <p className="dh-legend">{t.scale(data.green.scaleDays, data.green.windowDays)}</p>
              </>
            )}
          </section>
        </div>
      </div>
    </OpsRoot>
  );
}
