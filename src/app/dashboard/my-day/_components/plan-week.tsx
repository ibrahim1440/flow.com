"use client";

// D16 phase 2 «خطّط أسبوعك» (owner-approved Figma D16 B1–B4, 9 Nov 2026) — three steps, then «ثبّت خطتي»:
//   1. «مين تبي توصل له هالأسبوع؟» — suggestions with a reason each, ✓ to pick: late to reorder against their usual cycle,
//      money owed, a contract ending soon, not contacted lately — the same figures «يومي» shows (GET /api/sales/my-day).
//   2. «وزّعهم على الأيام» — spread evenly over the week's remaining working days; one tap on a day chip moves one.
//   3. «راجع وثبّت» — the week's targets against what is planned (what was already in the plan plus these), a nudge where
//      a target is short, then one POST /api/sales/plan/items { items } (a twin already in the plan is skipped).
// Suggested, never required: the Sunday card offers it and «مو الحين» hides it for the week.
import { useEffect, useState } from "react";
import { D21Dialog } from "@/components/ui/Dialog";
import { Ico } from "@/components/shell/icons";
import { dayName, dayNum, weekOf } from "./plan-dates";
import { GOAL_T, KINDS, send, usePlanData } from "./khitati";
import { useBackLayer } from "./back-layer";
import { countNoun } from "@/components/ops/ui";

/** «عميل واحد / عميلين / 3 عملاء / 11 عميل» (the counted-noun rule of components/ops/ui.tsx). */
const CUSTOMER_FORMS: [string, string, string, string, string, string] = ["عميل واحد", "عميلين", "عملاء", "عميل", "customer", "customers"];
import { CYCLE, GROUPS, planDays, suggestionsOf, type AMetric, type Sug, type WeekSource } from "./plan-logic";

const kindName = (m: AMetric, ar: boolean) => { const k = KINDS.find((x) => x.k === m)!; return ar ? k.ar : k.en; };
export { suggestionsOf, type WeekSource };


export function PlanWeekWizard({ ar, today, source, onClose, onDone }: { ar: boolean; today: string; source: WeekSource; onClose: () => void; onDone: (msg: string) => void }) {
  const days = planDays(today);
  const ws = weekOf(days[0]);
  const [step, setStep] = useState(1);
  const [sugs, setSugs] = useState<Sug[]>(() => suggestionsOf(source, ar));
  const [dayOf, setDayOf] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [customers, setCustomers] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const { plan } = usePlanData("WEEK", 0, undefined, ws);
  // Back (the device's) goes to the step before, and from the first step closes (D16 gate, «أبو فهد»).
  useBackLayer(step, () => (step > 1 ? setStep(step - 1) : onClose()));
  // Who is already in that week's plan is not suggested again (one added a minute ago included).
  const plannedIds = new Set((plan?.items ?? []).filter((i) => i.kind === "ACTION" && i.customer).map((i) => i.customer!.id));
  const shownSugs = sugs.filter((s) => s.group === "added" || !plannedIds.has(s.id));
  const picked = shownSugs.filter((s) => s.pick);
  useEffect(() => {
    if (!q.trim() || customers) return;
    let off = false;
    fetch("/api/customers?owner=me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : []))
      .then((j: { id: string; name: string; nameAr: string | null }[]) => { if (!off) setCustomers((Array.isArray(j) ? j : []).map((c) => ({ id: c.id, name: (ar ? c.nameAr : null) || c.name }))); })
      .catch(() => { if (!off) setCustomers([]); });
    return () => { off = true; };
  }, [q, customers, ar]);
  // Step 2's even spread, recomputed when the picks change; a tapped day overrides it.
  const spread = (() => {
    const m: Record<string, string> = {};
    const load: Record<string, number> = Object.fromEntries(days.map((d) => [d, (plan?.items ?? []).filter((i) => i.kind !== "GOAL" && i.plannedDay === d).length]));
    for (const s of picked) {
      if (dayOf[s.id]) { m[s.id] = dayOf[s.id]; load[dayOf[s.id]] = (load[dayOf[s.id]] ?? 0) + 1; continue; }
      const d = [...days].sort((a, b) => (load[a] ?? 0) - (load[b] ?? 0) || a.localeCompare(b))[0];
      m[s.id] = d; load[d] = (load[d] ?? 0) + 1;
    }
    return m;
  })();
  const toggle = (id: string) => setSugs(sugs.map((s) => (s.id === id ? { ...s, pick: !s.pick } : s)));
  const cycleKind = (id: string) => setSugs(sugs.map((s) => (s.id === id ? { ...s, kind: CYCLE[(CYCLE.indexOf(s.kind) + 1) % CYCLE.length] } : s)));
  const addCustomer = (c: { id: string; name: string }) => {
    setQ("");
    // Picked by search: shown and counted even when it was a hidden suggestion (already planned this week on another day).
    if (sugs.some((s) => s.id === c.id)) { setSugs(sugs.map((s) => (s.id === c.id ? { ...s, pick: true, group: "added" } : s))); return; }
    setSugs([...sugs, { id: c.id, name: c.name, why: ar ? "أضفته أنت" : "Added by you", group: "added", kind: "VISITS", pick: true }]);
  };
  // Step 3: the week's targets against what is planned (already in the plan + these picks).
  const goals = (["VISITS", "CALLS", "QUOTES", "COLLECTION", "SAMPLES"] as AMetric[]).map((m) => {
    const gs = (plan?.items ?? []).filter((i) => i.kind === "GOAL" && i.metric === m);
    const g = gs.find((x) => x.source === "ADMIN") ?? gs[0];
    const already = (plan?.items ?? []).filter((i) => i.kind === "ACTION" && i.metric === m).length;
    return { m, target: g?.target ?? null, planned: already + picked.filter((s) => s.kind === m).length };
  }).filter((g) => g.target || g.planned);
  const short = goals.find((g) => g.target && g.planned < g.target);
  const extra = short ? shownSugs.filter((s) => !s.pick).slice(0, 2) : [];
  const save = async () => {
    setBusy(true); setErr("");
    const items = picked.map((s) => ({ kind: "ACTION", metric: s.kind, customerId: s.id, plannedDay: spread[s.id], date: spread[s.id] }));
    const r = await send("/api/sales/plan/items", "POST", { items });
    setBusy(false);
    if (!r.ok) { setErr(String((ar ? r.data.error : r.data.errorEn ?? r.data.error) ?? (ar ? "تعذّر الحفظ." : "Could not save."))); return; }
    const added = (r.data.added as string[] | undefined)?.length ?? 0;
    const skipped = Number(r.data.skipped ?? 0);
    onDone(ar ? `ثبّتنا خطتك: ${added}${skipped ? ` (و${skipped} كانت بخطتك من قبل)` : ""} ✓` : `Your plan is set: ${added} added${skipped ? `, ${skipped} already there` : ""} ✓`);
  };
  const titles: [string, string][] = [["مين تبي توصل له هالأسبوع؟", "Who do you want to reach this week?"], ["وزّعهم على الأيام", "Spread them over the days"], ["راجع وثبّت", "Review and confirm"]];
  const perDay = (d: string) => picked.filter((s) => spread[s.id] === d).length + (plan?.items ?? []).filter((i) => i.kind !== "GOAL" && i.plannedDay === d).length;
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={ar ? titles[step - 1][0] : titles[step - 1][1]} sub={ar ? `خطّط أسبوعك · ${step} من 3` : `Plan your week · ${step} of 3`} onClose={onClose} width={520} testId="plan-wiz"
      actions={<>
        {step < 3 ? <button type="button" className="btn p" disabled={!picked.length} onClick={() => setStep(step + 1)} data-testid="plan-wiz-next">{ar ? "التالي" : "Next"}</button>
          : <button type="button" className="btn p" disabled={busy || !picked.length} onClick={save} data-testid="plan-wiz-save">{busy ? "…" : ar ? "ثبّت خطتي" : "Confirm my plan"}</button>}
        {step > 1 ? <button type="button" className="btn" onClick={() => setStep(step - 1)} data-testid="plan-wiz-back">{ar ? "رجوع" : "Back"}</button> : <button type="button" className="btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button>}
      </>}>
      <div className="pl-sheet kp-wiz">
        <span className="kp-steps" aria-hidden>{[1, 2, 3].map((n) => <i key={n} className={n <= step ? "on" : undefined} />)}</span>
        {step === 1 ? (
          <>
            <small className="pl-hint">{ar ? "اقترحنا لك حسب عادة كل عميل. شيل أو زيد بنقرة." : "Suggested from each customer's habits. Tap to add or remove."}</small>
            {!shownSugs.length ? <p className="md-empty-line">{ar ? "ما عندنا اقتراحات هالأسبوع — أضف عملاء من البحث تحت." : "No suggestions this week — add customers below."}</p> : null}
            {GROUPS.map((g) => {
              const xs = shownSugs.filter((s) => s.group === g.g);
              if (!xs.length) return null;
              return (
                <div key={g.g} className="kp-wiz-g">
                  <b className="kp-wiz-gt">{ar ? g.ar : g.en}</b>
                  {xs.map((s) => (
                    <button key={s.id} type="button" role="checkbox" aria-checked={s.pick} className={`kp-pickrow${s.pick ? " on" : ""}`} onClick={() => toggle(s.id)} data-testid={`plan-wiz-pick-${s.id}`}>
                      <span className="kp-box" aria-hidden>{s.pick ? <Ico name="tick" small /> : null}</span>
                      <span><b>{s.name}</b><small>{s.why}</small></span>
                    </button>
                  ))}
                </div>
              );
            })}
            <span className="pl-search"><Ico name="plus" small /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={ar ? "عميل ثاني — ابحث بالاسم" : "Another customer — search"} data-testid="plan-wiz-q" /></span>
            {q.trim() ? <div className="pl-custs">{(customers ?? []).filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 5).map((c) => (
              <button key={c.id} type="button" className="pl-cust" onClick={() => addCustomer(c)} data-testid="plan-wiz-add"><span className="pl-radio" /><b>{c.name}</b></button>
            ))}</div> : null}
            <small className="kp-wiz-n" data-testid="plan-wiz-count">{ar ? `${countNoun(picked.length, "ar", CUSTOMER_FORMS)} ${picked.length === 1 ? "مختار" : "مختارين"}` : `${picked.length} picked`}</small>
          </>
        ) : step === 2 ? (
          <>
            <div className="kp-perday">{days.map((d) => <span key={d}><b className="num">{perDay(d)}</b><small>{dayName(d, ar)}</small></span>)}</div>
            {picked.map((s) => (
              <div key={s.id} className="kp-spread" data-testid={`plan-wiz-spread-${s.id}`}>
                <span className="kp-spread-h"><b>{s.name}</b>
                  <button type="button" className="kp-chipbtn" onClick={() => cycleKind(s.id)} data-testid={`plan-wiz-kind-${s.id}`}>{kindName(s.kind, ar)}</button></span>
                <span className="kp-chips">{days.map((d) => <button key={d} type="button" aria-pressed={spread[s.id] === d} onClick={() => setDayOf({ ...dayOf, [s.id]: d })} data-testid={`plan-wiz-day-${s.id}-${d}`}>{dayName(d, ar)} {dayNum(d)}</button>)}</span>
              </div>
            ))}
            <small className="pl-hint">{ar ? "وزّعناهم بالتساوي على أيامك. نقرة على اليوم تغيّره، ونقرة على النوع تبدّله." : "Spread evenly over your days. Tap a day to move one, the kind to change it."}</small>
          </>
        ) : (
          <>
            <b className="pl-q">{ar ? "خطتك مقابل أهداف الأسبوع" : "Your plan against the week's targets"}</b>
            {goals.length ? goals.map((g) => (
              <div key={g.m} className="kp-vs" data-testid={`plan-wiz-vs-${g.m}`}>
                <b>{ar ? GOAL_T[g.m][0] : GOAL_T[g.m][1]}</b>
                <span className="num">{g.target ? `${g.planned} ${ar ? "من" : "of"} ${g.target}` : `${g.planned}`} {g.target ? (g.planned >= g.target ? <span className="ok">✓</span> : <span className="wa">—</span>) : null}</span>
              </div>
            )) : <p className="md-empty-line">{ar ? "ما فيه أهداف لهالأسبوع." : "No targets this week."}</p>}
            {short && extra.length ? (
              <div className="kp-nudge" data-testid="plan-wiz-nudge">
                <b>{ar ? `${GOAL_T[short.m][0]} أقل من الهدف بـ${(short.target ?? 0) - short.planned}. تبي تضيف؟` : `${GOAL_T[short.m][1]} short by ${(short.target ?? 0) - short.planned}. Add?`}</b>
                <span className="kp-chips">{extra.map((s) => <button key={s.id} type="button" onClick={() => setSugs(sugs.map((x) => (x.id === s.id ? { ...x, pick: true, kind: short.m } : x)))}>+ {kindName(short.m, ar)} {ar ? "لـ" : "for "}{s.name}</button>)}</span>
              </div>
            ) : null}
            {goals.some((g) => g.target && g.planned < g.target) ? <small className="pl-hint" data-testid="plan-wiz-legend"><span className="wa">—</span> {ar ? "أقل من هدف المشرف" : "below the supervisor's target"} · <span className="ok">✓</span> {ar ? "وصل الهدف" : "target reached"}</small> : null}
            <b className="pl-q">{ar ? "الأيام" : "The days"}</b>
            {days.map((d) => <div key={d} className="kp-vs sm"><b>{dayName(d, ar)} {dayNum(d)}</b><span>{perDay(d)}</span></div>)}
            <small className="pl-hint">{ar ? "تقدر تعدّل خطتك أي وقت من تبويب «خطتي»." : "You can change your plan any time in «My plan»."}</small>
            {err ? <p className="pl-err" role="alert">{err}</p> : null}
          </>
        )}
      </div>
    </D21Dialog>
  );
}
