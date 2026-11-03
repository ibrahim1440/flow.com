"use client";

// «خطتي» (owner-approved Figma 161:106 / 173:106, 3 Nov 2026): the rep's plan of the day, the week or the month.
// Management goals (blue, locked, «من المشرف») above the rep's own goals and checklist items; every counted goal's
// progress comes from GET /api/sales/plan (services/sales/plans.ts), a custom goal's from what the rep enters.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { D21Dialog } from "@/components/ui/Dialog";
import { Ico } from "@/components/shell/icons";

type Period = "DAY" | "WEEK" | "MONTH";
type Metric = "VISITS" | "CALLS" | "QUOTES" | "COLLECTION" | "NEW_CUSTOMERS" | "SAMPLES" | "CUSTOM";
type Item = { id: string; source: "ADMIN" | "SELF"; kind: "GOAL" | "CHECK"; metric: Metric | null; label: string | null; target: number | null; done: number | null; checked: boolean; setBy: string | null };
type Plan = { period: Period; start: string; end: string; items: Item[]; readOnly: boolean };

export const METRIC_AR: Record<Metric, string> = { VISITS: "زيارات عملاء", CALLS: "مكالمات", QUOTES: "عروض أسعار", COLLECTION: "تحصيل", NEW_CUSTOMERS: "عملاء جدد", SAMPLES: "عيّنات مرسلة", CUSTOM: "هدف خاص" };
const METRIC_EN: Record<Metric, string> = { VISITS: "Customer visits", CALLS: "Calls", QUOTES: "Quotations", COLLECTION: "Collections", NEW_CUSTOMERS: "New customers", SAMPLES: "Samples sent", CUSTOM: "Custom goal" };
export const metricText = (m: Metric, label: string | null, ar: boolean) => (m === "CUSTOM" ? label ?? "" : ar ? METRIC_AR[m] : METRIC_EN[m]);
const PERIOD: Record<Period, [string, string]> = { DAY: ["اليوم", "Today"], WEEK: ["الأسبوع", "This week"], MONTH: ["الشهر", "This month"] };
const fmt = (v: number, m: Metric | null) => (m === "COLLECTION" ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/** The period's last day (the API's `end` is the next period's first). */
const lastDay = (end: string) => new Date(Date.parse(`${end}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function usePlan(period: Period, reload: number) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let off = false;
    fetch(`/api/sales/plan?period=${period}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j: Plan) => { if (!off) { setPlan(j); setFailed(false); } }).catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [period, reload]);
  return { plan, failed };
}

function GoalRow({ it, ar, onManual }: { it: Item; ar: boolean; onManual?: (it: Item) => void }) {
  const t = it.target ?? 0, d = it.done ?? 0;
  const pct = t > 0 ? Math.max(0, Math.min(100, (d / t) * 100)) : 0;
  const met = t > 0 && d >= t;
  return (
    <div className={`pl-goal${it.source === "ADMIN" ? " adm" : ""}`} data-testid="plan-goal">
      <div className="pl-goal-r">
        <span className="pl-goal-n">{it.metric ? metricText(it.metric, it.label, ar) : ""}</span>
        <span className={`pl-goal-v num${met ? " met" : ""}`}>{fmt(d, it.metric)} {ar ? "من" : "of"} {fmt(t, it.metric)}{it.metric === "COLLECTION" ? (ar ? " ر.س" : " SAR") : ""}{met ? " ✓" : ""}</span>
      </div>
      <span className="pl-bar" aria-hidden><i style={{ width: `${pct}%` }} /></span>
      {it.metric === "CUSTOM" && onManual ? <button type="button" className="pl-manual" onClick={() => onManual(it)}>{ar ? "حدّث الإنجاز" : "Update progress"}</button> : null}
    </div>
  );
}

/** «خطة هذا الأسبوع» on «اليوم»: the goals' progress in a few lines, the way into the plan. */
export function PlanCard({ ar }: { ar: boolean }) {
  const { plan, failed } = usePlan("WEEK", 0);
  if (failed) return null;
  const goals = (plan?.items ?? []).filter((i) => i.kind === "GOAL");
  const checks = (plan?.items ?? []).filter((i) => i.kind === "CHECK");
  return (
    <section className="md-card pl-card" data-testid="md-plan" aria-labelledby="md-plan-h">
      <div className="md-h"><h2 id="md-plan-h"><Ico name="check" small className="md-h-ico2" />{ar ? "خطة هذا الأسبوع" : "This week's plan"}</h2>
        <Link className="lk" href="/dashboard/my-day?tab=tasks">{goals.length || checks.length ? (ar ? "افتح الخطة" : "Open the plan") : (ar ? "سوّ خطتك" : "Make your plan")}</Link></div>
      {!plan ? <p className="md-empty-line">{ar ? "جارٍ التحميل…" : "Loading…"}</p>
        : goals.length === 0 && checks.length === 0 ? (
          <div className="md-empty"><span>{ar ? "ما عندك خطة لهذا الأسبوع. حط لك أهداف وبنود، وتنحسب لك تلقائيًا." : "No plan for this week yet."}</span>
            <Link className="btn sm" href="/dashboard/my-day?tab=tasks&plan=edit">{ar ? "سوّ خطتك" : "Make your plan"}</Link></div>
        ) : (
          <div className="pl-goals">
            {goals.slice(0, 4).map((g) => <GoalRow key={g.id} it={g} ar={ar} />)}
            {checks.length ? <p className="md-note">{ar ? `البنود: ${checks.filter((c) => c.checked).length} من ${checks.length} خلصت` : `Items: ${checks.filter((c) => c.checked).length} of ${checks.length} done`}</p> : null}
          </div>
        )}
    </section>
  );
}

/** «خطتي» at the top of «مهامي»: the period, the management goals, the rep's own goals and items, the editor. */
export function PlanSection({ ar }: { ar: boolean }) {
  const [period, setPeriod] = useState<Period>("WEEK");
  const [reload, setReload] = useState(0);
  const { plan, failed } = usePlan(period, reload);
  const [editing, setEditing] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("plan") === "edit");
  const [manual, setManual] = useState<Item | null>(null);
  const bump = useCallback(() => setReload((r) => r + 1), []);
  const tick = async (it: Item) => {
    await fetch(`/api/sales/plan/items/${it.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ checked: !it.checked }) });
    bump();
  };
  const admin = (plan?.items ?? []).filter((i) => i.source === "ADMIN");
  const mineGoals = (plan?.items ?? []).filter((i) => i.source === "SELF" && i.kind === "GOAL");
  const checks = (plan?.items ?? []).filter((i) => i.kind === "CHECK");
  const setBy = admin.find((a) => a.setBy)?.setBy;
  return (
    <section className="md-card pl-section" id="plan" data-testid="md-plan-section" aria-labelledby="md-plan-s-h">
      <div className="md-h">
        <h2 id="md-plan-s-h"><Ico name="check" small className="md-h-ico2" />{ar ? "خطتي" : "My plan"}</h2>
        <span className="pl-seg" role="group" aria-label={ar ? "فترة الخطة" : "Plan period"}>
          {(["DAY", "WEEK", "MONTH"] as Period[]).map((p) => <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)} data-testid={`plan-period-${p}`}>{ar ? PERIOD[p][0] : PERIOD[p][1]}</button>)}
        </span>
      </div>
      {failed ? <p className="md-empty-line">{ar ? "تعذّر تحميل الخطة." : "Could not load the plan."}</p> : !plan ? <p className="md-empty-line">{ar ? "جارٍ التحميل…" : "Loading…"}</p> : (
        <div className="pl-body">
          <p className="md-note">{ar ? `من ${plan.start} إلى ${lastDay(plan.end)}` : `${plan.start} → ${lastDay(plan.end)}`}</p>
          {admin.length ? (
            <div className="pl-block adm" data-testid="plan-admin">
              <div className="pl-block-h"><b><Ico name="settings" small />{ar ? "أهداف إدارية" : "Management goals"}</b><span>{ar ? `حدّدها المشرف${setBy ? `: ${setBy}` : ""} · تنحسب تلقائيًا` : `Set by ${setBy ?? "the supervisor"} · counted automatically`}</span></div>
              {admin.map((g) => <GoalRow key={g.id} it={g} ar={ar} onManual={setManual} />)}
            </div>
          ) : period !== "DAY" ? <p className="md-note">{ar ? "ما فيه أهداف من المشرف لهذي الفترة." : "No management goals for this period."}</p> : null}
          <div className="pl-block mine" data-testid="plan-mine">
            <div className="pl-block-h"><b>{ar ? "أهدافي" : "My goals"}</b><span>{ar ? "خاصة فيك، المشرف يشوفها بس" : "Yours; the supervisor only reads them"}</span></div>
            {mineGoals.map((g) => <GoalRow key={g.id} it={g} ar={ar} onManual={setManual} />)}
            {checks.map((c) => (
              <label key={c.id} className={`pl-check${c.checked ? " on" : ""}`} data-testid="plan-check">
                <input type="checkbox" checked={c.checked} onChange={() => tick(c)} /><span>{c.label}</span>
              </label>
            ))}
            {mineGoals.length === 0 && checks.length === 0 ? <p className="md-empty-line">{ar ? "ما حطيت أهداف ولا بنود لهذي الفترة." : "No goals or items yet."}</p> : null}
            <button type="button" className="btn sm" onClick={() => setEditing(true)} data-testid="plan-edit">{mineGoals.length || checks.length ? (ar ? "عدّل خطتي" : "Edit my plan") : (ar ? "سوّ خطتك" : "Make your plan")}</button>
          </div>
        </div>
      )}
      {editing && plan ? <PlanEditor ar={ar} plan={plan} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); bump(); }} /> : null}
      {manual ? <ManualDialog ar={ar} it={manual} onClose={() => setManual(null)} onSaved={() => { setManual(null); bump(); }} /> : null}
    </section>
  );
}

type Row = { id?: string; kind: "GOAL" | "CHECK"; metric: Metric; label: string; target: string; checked?: boolean };

function PlanEditor({ ar, plan, onClose, onSaved }: { ar: boolean; plan: Plan; onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => plan.items.filter((i) => i.source === "SELF").map((i) => ({ id: i.id, kind: i.kind, metric: i.metric ?? "VISITS", label: i.label ?? "", target: i.target === null ? "" : String(i.target), checked: i.checked })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: number, p: Partial<Row>) => setRows((r) => r.map((x, i) => (i === k ? { ...x, ...p } : x)));
  const save = async () => {
    setBusy(true); setErr("");
    const res = await fetch("/api/sales/plan", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period: plan.period, start: plan.start, items: rows.map((r) => ({ id: r.id, kind: r.kind, metric: r.kind === "GOAL" ? r.metric : null, label: r.label, target: r.kind === "GOAL" ? r.target : null, checked: r.checked })) }) });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(ar ? b.error ?? "تعذّر الحفظ." : b.errorEn ?? "Could not save."); return; }
    onSaved();
  };
  const admin = plan.items.filter((i) => i.source === "ADMIN");
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={ar ? `خطة ${PERIOD[plan.period][0]}` : `Plan — ${PERIOD[plan.period][1]}`} onClose={onClose} width={520} testId="plan-editor"
      actions={<><button type="button" className="btn p" disabled={busy} onClick={save} data-testid="plan-save">{busy ? "…" : ar ? "حفظ الخطة" : "Save the plan"}</button><button type="button" className="btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button></>}>
      <div className="pl-editor">
        {admin.length ? <div className="pl-block adm"><div className="pl-block-h"><b>{ar ? "من المشرف (ما تتعدّل)" : "From your supervisor (locked)"}</b></div>
          <p className="md-note" style={{ margin: 0 }}>{admin.map((a) => `${a.metric ? metricText(a.metric, a.label, ar) : ""} ${fmt(a.target ?? 0, a.metric)}`).join(" · ")}</p></div> : null}
        <b className="pl-ed-h">{ar ? "أهدافي (اختياري)" : "My goals (optional)"}</b>
        {rows.map((r, k) => r.kind !== "GOAL" ? null : (
          <div key={k} className="pl-ed-row">
            <select className="pl-in" value={r.metric} onChange={(e) => set(k, { metric: e.target.value as Metric })} aria-label={ar ? "نوع الهدف" : "Goal kind"}>
              {(Object.keys(METRIC_AR) as Metric[]).map((m) => <option key={m} value={m}>{ar ? METRIC_AR[m] : METRIC_EN[m]}</option>)}
            </select>
            {r.metric === "CUSTOM" ? <input className="pl-in" placeholder={ar ? "اسم الهدف" : "Goal name"} value={r.label} maxLength={80} onChange={(e) => set(k, { label: e.target.value })} /> : null}
            <input className="pl-in num pl-num" inputMode="decimal" placeholder={ar ? "العدد" : "Target"} value={r.target} onChange={(e) => set(k, { target: e.target.value })} aria-label={ar ? "رقم الهدف" : "Target"} />
            <button type="button" className="pl-del" onClick={() => setRows((x) => x.filter((_, i) => i !== k))} aria-label={ar ? "حذف" : "Remove"}>✕</button>
          </div>
        ))}
        <b className="pl-ed-h">{ar ? "بنود أشطبها بنفسي" : "Items I tick myself"}</b>
        {rows.map((r, k) => r.kind !== "CHECK" ? null : (
          <div key={k} className="pl-ed-row">
            <input className="pl-in" placeholder={ar ? "مثال: زيارة مقهى رواية" : "e.g. visit a customer"} value={r.label} maxLength={200} onChange={(e) => set(k, { label: e.target.value })} />
            <button type="button" className="pl-del" onClick={() => setRows((x) => x.filter((_, i) => i !== k))} aria-label={ar ? "حذف" : "Remove"}>✕</button>
          </div>
        ))}
        <div className="pl-ed-add">
          <button type="button" className="btn sm" onClick={() => setRows((x) => [...x, { kind: "GOAL", metric: "VISITS", label: "", target: "" }])} data-testid="plan-add-goal">+ {ar ? "هدف" : "Goal"}</button>
          <button type="button" className="btn sm" onClick={() => setRows((x) => [...x, { kind: "CHECK", metric: "VISITS", label: "", target: "" }])} data-testid="plan-add-check">+ {ar ? "بند" : "Item"}</button>
        </div>
        {err ? <p className="pl-err" role="alert">{err}</p> : null}
        <p className="md-note">{ar ? "خطتك خاصة فيك، والمشرف يشوفها بس. الأهداف (ما عدا الخاصة) تنحسب تلقائيًا من نشاطك." : "Your plan is yours; the supervisor only reads it."}</p>
      </div>
    </D21Dialog>
  );
}

function ManualDialog({ ar, it, onClose, onSaved }: { ar: boolean; it: Item; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(String(it.done ?? 0));
  const [err, setErr] = useState("");
  const save = async () => {
    const res = await fetch(`/api/sales/plan/items/${it.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manualDone: v }) });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(b.error ?? "تعذّر الحفظ."); return; }
    onSaved();
  };
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={it.label ?? ""} sub={ar ? `الهدف: ${it.target}` : `Target: ${it.target}`} onClose={onClose} width={360}
      actions={<><button type="button" className="btn p" onClick={save}>{ar ? "حفظ" : "Save"}</button><button type="button" className="btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button></>}>
      <label className="pl-ed-h" style={{ display: "grid", gap: 6 }}>{ar ? "كم أنجزت؟" : "How much is done?"}
        <input className="pl-in num" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} /></label>
      {err ? <p className="pl-err" role="alert">{err}</p> : null}
    </D21Dialog>
  );
}
