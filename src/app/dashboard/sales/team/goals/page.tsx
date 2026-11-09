"use client";

// «أهداف الفريق» (owner-approved Figma 172:106, 3 Nov 2026): the supervisor (sales › lead_assign — the people who set the
// monthly target) sets each rep's management goals for a week or a month. A number sets a goal, an empty box removes it;
// every goal but a custom one is counted from the rep's own records (services/sales/plans.ts), shown beside the box.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLang } from "../../_components/ui";
import { PerfHeader, PerfLoading, PerfNotice } from "../../_components/perf";
import { useUser } from "../../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { METRIC_AR, WeekPlan } from "../../../my-day/_components/khitati";
import { Ico } from "@/components/shell/icons";
import "../../../my-day/my-day.css";
import "./goals.css";

type Metric = "VISITS" | "CALLS" | "QUOTES" | "COLLECTION" | "NEW_CUSTOMERS" | "SAMPLES" | "CUSTOM";
type Rep = { id: string; name: string; customers: number; counts: Record<Exclude<Metric, "CUSTOM">, number>; plan: { planned: number; done: number; offPlan: number }; goals: { id: string; metric: Metric; label: string | null; target: number; done: number | null }[] };
type Data = { period: "WEEK" | "MONTH"; start: string; end: string; reps: Rep[] };
const COLS: Exclude<Metric, "CUSTOM">[] = ["VISITS", "CALLS", "QUOTES", "COLLECTION", "NEW_CUSTOMERS", "SAMPLES"];
const shift = (iso: string, period: "WEEK" | "MONTH", dir: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (period === "WEEK") d.setUTCDate(d.getUTCDate() + 7 * dir); else d.setUTCMonth(d.getUTCMonth() + dir);
  return d.toISOString().slice(0, 10);
};
const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });

export default function TeamGoalsPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const user = useUser();
  const may = !!user && (user.role === "admin" || hasSubPrivilege(user.permissions, "sales", "lead_assign"));
  const [period, setPeriod] = useState<"WEEK" | "MONTH">("WEEK");
  const [date, setDate] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [customs, setCustoms] = useState<Record<string, { label: string; target: string }[]>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // «خطط الفريق» (Figma page 07): one rep's plan open under their row, read-only — the supervisor may add to it.
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (p: "WEEK" | "MONTH", d: string | null) => {
    const r = await fetch(`/api/sales/team-goals?period=${p}${d ? `&date=${d}` : ""}`, { cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) { setMsg({ ok: false, text: j?.error ?? (ar ? "تعذّر التحميل." : "Could not load.") }); return null; }
    return j as Data;
  }, [ar]);
  const fill = (j: Data, keepPeriodOf?: Data) => {
    const v: Record<string, string> = {}; const c: Record<string, { label: string; target: string }[]> = {};
    for (const r of j.reps) {
      for (const g of r.goals) if (g.metric !== "CUSTOM") v[`${r.id}:${g.metric}`] = String(g.target);
      c[r.id] = r.goals.filter((g) => g.metric === "CUSTOM").map((g) => ({ label: g.label ?? "", target: String(g.target) }));
    }
    setVals(v); setCustoms(c);
    if (!keepPeriodOf) setData(j);
  };
  useEffect(() => {
    if (!may) return;
    let off = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fetched goals fill the form once per period
    load(period, date).then((j) => { if (!off && j) fill(j); });
    return () => { off = true; };
  }, [may, period, date, load]);

  const copyPrevious = async () => {
    if (!data) return;
    const prev = await load(period, shift(data.start, period, -1));
    if (!prev) return;
    fill(prev, data);
    setMsg({ ok: true, text: ar ? "نُسخت أهداف الفترة اللي فاتت — راجعها ثم احفظ." : "Copied the previous period's goals — review, then save." });
  };
  const save = async () => {
    if (!data) return;
    setBusy(true); setMsg(null);
    const goals: { employeeId: string; metric: string; label?: string; target: string | null }[] = [];
    for (const r of data.reps) {
      for (const m of COLS) goals.push({ employeeId: r.id, metric: m, target: (vals[`${r.id}:${m}`] ?? "").trim() || null });
      const before = r.goals.filter((g) => g.metric === "CUSTOM").map((g) => g.label ?? "");
      const now = (customs[r.id] ?? []).filter((c) => c.label.trim());
      for (const c of now) goals.push({ employeeId: r.id, metric: "CUSTOM", label: c.label.trim(), target: c.target.trim() || null });
      for (const l of before) if (!now.some((c) => c.label.trim() === l)) goals.push({ employeeId: r.id, metric: "CUSTOM", label: l, target: null });
    }
    const res = await fetch("/api/sales/team-goals", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period: data.period, start: data.start, goals }) });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: ar ? b.error ?? "تعذّر الحفظ." : b.errorEn ?? "Could not save." }); return; }
    setMsg({ ok: true, text: ar ? "حُفظت الأهداف، وتظهر للمندوبين في خطتهم." : "Saved; the reps see them in their plan." });
    const j = await load(data.period, data.start); if (j) fill(j);
  };
  const totals = useMemo(() => {
    const t: Partial<Record<Metric, number>> = {};
    for (const [k, v] of Object.entries(vals)) { const m = k.split(":")[1] as Metric; const x = Number(v.replace(/,/g, "")); if (Number.isFinite(x) && x > 0) t[m] = (t[m] ?? 0) + x; }
    return t;
  }, [vals]);

  if (user && !may) return <div className="pg"><PerfNotice kind="error" ar={ar}>{ar ? "أهداف الفريق للمشرف فقط." : "Team goals are for the supervisor."}</PerfNotice></div>;
  return (
    <div className="pg tg" data-testid="team-goals">
      <PerfHeader ar={ar} title={ar ? "خطة الفريق" : "Team plan"} phoneTitle={ar ? "خطة الفريق" : "Team plan"}
        meta={[ar ? "الأرقام تظهر للمندوب في خطته «من المشرف»، وتنحسب تلقائيًا من نشاطه. افتح خطة أي مندوب وأضف لخطته." : "Shown in each rep's plan «from your supervisor», counted automatically. Open a rep's plan to add items."]}
        actions={<span className="tg-acts"><Link className="btn" href="/dashboard/sales/team">{ar ? "متابعة الفريق" : "Team overview"}</Link>
          <button type="button" className="btn" onClick={copyPrevious} disabled={!data}>{ar ? "انسخ من الفترة اللي فاتت" : "Copy the previous period"}</button>
          <button type="button" className="btn p" onClick={save} disabled={!data || busy} data-testid="team-goals-save">{busy ? "…" : ar ? "حفظ الأرقام" : "Save the numbers"}</button></span>} />
      {msg ? <PerfNotice kind={msg.ok ? "success" : "error"} ar={ar} onDismiss={() => setMsg(null)}>{msg.text}</PerfNotice> : null}
      <div className="tg-bar">
        <span className="tg-seg" role="group">
          {(["WEEK", "MONTH"] as const).map((p) => <button key={p} type="button" aria-pressed={period === p} onClick={() => { setPeriod(p); setDate(null); }}>{p === "WEEK" ? (ar ? "أسبوعي" : "Weekly") : (ar ? "شهري" : "Monthly")}</button>)}
        </span>
        {data ? <span className="tg-nav">
          <button type="button" className="btn sm" onClick={() => setDate(shift(data.start, period, -1))} aria-label={ar ? "الفترة السابقة" : "Previous"}>›</button>
          <b>{ar ? (period === "WEEK" ? "الأسبوع: " : "الشهر: ") : ""}{data.start} – {new Date(Date.parse(`${data.end}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)}</b>
          <button type="button" className="btn sm" onClick={() => setDate(shift(data.start, period, 1))} aria-label={ar ? "الفترة التالية" : "Next"}>‹</button>
        </span> : null}
      </div>
      {!data ? <PerfLoading ar={ar} /> : data.reps.length === 0 ? <p>{ar ? "ما فيه مندوبين." : "No reps."}</p> : (
        <div className="tg-scroll">
          <table className="t tg-table">
            <thead><tr><th>{ar ? "المندوب" : "Rep"}</th>{COLS.map((m) => <th key={m}>{ar ? METRIC_AR[m] : m}{m === "COLLECTION" ? (ar ? " (ر.س)" : " (SAR)") : ""}</th>)}<th>{ar ? "أرقام خاصة" : "Custom numbers"}</th><th>{ar ? "الخطة" : "Plan"}</th><th>{ar ? "خارج الخطة" : "Unplanned"}</th></tr></thead>
            <tbody>
              {data.reps.map((r) => (
                <Fragment key={r.id}>
                <tr data-testid={`tg-rep-${r.id}`}>
                  <td><b>{r.name}</b><small>{ar ? `${r.customers} عميل` : `${r.customers} customers`}</small>
                    <button type="button" className="lk-inline tg-open" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} data-testid={`tg-open-${r.id}`}>
                      <Ico name={open === r.id ? "chevd" : "chev"} small />{open === r.id ? (ar ? "إخفاء خطته" : "Hide the plan") : ar ? "شوف خطته" : "See the plan"}</button></td>
                  {COLS.map((m) => {
                    const v = vals[`${r.id}:${m}`] ?? "";
                    const target = Number(v.replace(/,/g, ""));
                    const done = r.counts[m];
                    return (
                      <td key={m}>
                        <input className="tg-in num" inputMode="decimal" value={v} placeholder="—" aria-label={`${r.name} · ${METRIC_AR[m]}`}
                          onChange={(e) => setVals((x) => ({ ...x, [`${r.id}:${m}`]: e.target.value }))} />
                        <small className={v && done >= target ? "met" : undefined}>{ar ? "حقّق" : "done"} {n(done)}</small>
                      </td>
                    );
                  })}
                  <td className="tg-custom">
                    {(customs[r.id] ?? []).map((c, k) => (
                      <span key={k} className="tg-crow">
                        <input className="tg-in" placeholder={ar ? "اسم الهدف" : "Name"} value={c.label} maxLength={80} onChange={(e) => setCustoms((x) => ({ ...x, [r.id]: x[r.id].map((y, i) => (i === k ? { ...y, label: e.target.value } : y)) }))} />
                        <input className="tg-in num tg-small" inputMode="decimal" placeholder="—" value={c.target} onChange={(e) => setCustoms((x) => ({ ...x, [r.id]: x[r.id].map((y, i) => (i === k ? { ...y, target: e.target.value } : y)) }))} />
                      </span>
                    ))}
                    <button type="button" className="lk-inline" onClick={() => setCustoms((x) => ({ ...x, [r.id]: [...(x[r.id] ?? []), { label: "", target: "" }] }))}>+ {ar ? "رقم خاص" : "Custom"}</button>
                  </td>
                  <td><b className={`num${r.plan.planned && r.plan.done >= r.plan.planned ? " met" : ""}`}>{r.plan.planned ? (ar ? `${r.plan.done} من ${r.plan.planned}` : `${r.plan.done} of ${r.plan.planned}`) : "—"}</b>
                    <small className={r.plan.planned ? undefined : "warn"}>{r.plan.planned ? (ar ? "" : "planned") : ar ? "ما خطط" : "No plan"}</small></td>
                  <td><b className="num">{r.plan.offPlan}</b><small>{ar ? "زيارة ومكالمة" : "visits & calls"}</small></td>
                </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="tg-foot">{ar ? "اترك الخانة فاضية إذا ما تبي تحدد هدف. المجموع: " : "Leave a box empty for no goal. Total: "}{COLS.filter((m) => totals[m]).map((m) => `${METRIC_AR[m]} ${n(totals[m]!)}`).join(" · ") || "—"}</p>
        </div>
      )}
      {data && open ? (() => { const r = data.reps.find((x) => x.id === open); return r ? <section className="tg-plan" data-testid="tg-plan"><WeekPlan ar={ar} rep={{ id: r.id, name: r.name }} date={data.start} /></section> : null; })() : null}
      <div className="tg-how">
        <b>{ar ? "كيف ينحسب كل هدف تلقائيًا" : "How each goal is counted"}</b>
        <ul>
          <li>{ar ? "زيارات عملاء: كل «زيارة» مكتملة سجّلها المندوب." : "Visits: each completed visit the rep logged."}</li>
          <li>{ar ? "مكالمات: كل «مكالمة» مكتملة، ما تنحسب «لا رد»." : "Calls: each completed call, «no answer» excluded."}</li>
          <li>{ar ? "عروض أسعار: كل عرض أصدره المندوب في الفترة." : "Quotations: each quotation the rep issued in the period."}</li>
          <li>{ar ? "تحصيل: التحصيلات المسجّلة قبل الضريبة على صفقاته (نفس رقم «هدف الشهر»)." : "Collections: recorded collections before VAT on the rep's deals."}</li>
          <li>{ar ? "عملاء جدد: العملاء اللي انضافوا في الفترة وهو مسؤولهم." : "New customers: customers added in the period that the rep owns."}</li>
          <li>{ar ? "عيّنات مرسلة: العيّنات اللي انرسلت في الفترة على صفقاته." : "Samples sent: samples sent in the period on the rep's deals."}</li>
          <li>{ar ? "الأهداف الخاصة: المندوب يحدّث إنجازها بنفسه." : "Custom goals: the rep updates the progress."}</li>
        </ul>
      </div>
    </div>
  );
}
