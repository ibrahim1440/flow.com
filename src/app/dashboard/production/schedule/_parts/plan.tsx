"use client";
// RM7 «تخطيط الدفعات» (Figma 403:2650 at 1440, 405:2837 at 1024): the inputs (remaining → green at the
// coffee's expected loss → minus the running batch → green to plan), the roaster and operator, the target
// split against the proposed split with «البديل», the rules, and the proposed slots. «اعتماد الخطة»
// reserves slots only. The blocked state (ROASTERS.md §5.3, specified, not drawn) is this layout with the
// failing rule in red and the primary button disabled; the way forward is a quantity decision with a reason.
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Btn, Field, Notice, OpsBanner, OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { useI18n } from "@/lib/i18n/context";
import {
  BASE, call, dayLabel, errText, N, NoRoaster, NowText, riyadhKeyOf, ScheduleFrame, timeOf, useLang, type ApiError, type Can, type RoasterInfo,
} from "./shared";
import { Retry } from "../../../settings/production/_parts/shared";

type SplitOut = { count: number; text: string; groups: { kg: string; n: number }[]; batches: string[] };
type Rule = { key: "LIMITS" | "LAST_BATCH" | "ROASTER" | "OPERATOR" | "TIME" | "SPANS"; state: "ok" | "warn" | "fail"; detail: Record<string, unknown> };
type Draft = { index: number; startsAt: string; endsAt: string; kg: string; operatorId: string | null; operatorName: string | null; conflict: null | "MACHINE" | "OPERATOR" | "HOURS" | "MAINTENANCE" | "PAST" | "OPERATOR_NOT_ASSIGNED" };
export type Preview = {
  now: string;
  product: { id: string; name: { ar: string; en: string }; expectedLossPct: number };
  demand: { openKg: string; shelfKg: string; pipelineKg: string; orders: { orderNumber: number; customerName: string; needKg: string }[] } | null;
  quantities: { remainingKg: string; requiredGreenKg: string; inProgressKg: string; approvedKg: string; greenToPlanKg: string; expectedLossPct: number; running: { id: string; startsAt: string; startedAt: string | null; kg: string }[]; approvedSlots: number };
  override: string | null; greenKg: string; purpose: "DEMAND" | "STOCK";
  roasters: RoasterInfo[]; roaster: RoasterInfo; operators: { id: string; name: string }[]; operatorId: string | null;
  split: { ok: true; target: { count: number; fullBatches: number; remainderKg: string; lastBelowMin: boolean; targetKg: string }; proposed: SplitOut; alternative: SplitOut | null; redistributed: boolean; chosen: "PROPOSED" | "ALTERNATIVE" }
    | { ok: false; reason: "NOTHING_TO_PLAN" | "INVALID_LIMITS" | "NO_FEASIBLE_COUNT"; greenKg: string; minKg: string; maxKg: string };
  slots: Draft[]; expectedRoastedKg: string | null; rules: Rule[]; blocked: boolean; can: Can;
};
type Coffee = { productId: string; nameAr: string; nameEn: string; demandKg: string; orders: number[] };

const toLocal = (iso: string) => `${riyadhKeyOf(iso)}T${timeOf(iso)}`;
const fromLocal = (v: string) => `${v}:00+03:00`;

export function PlanView({ initialProduct }: { initialProduct: string | null }) {
  const { ar, L } = useLang();
  const { t } = useI18n();
  const router = useRouter();
  const [coffees, setCoffees] = useState<{ needed: Coffee[]; stock: Coffee[]; can: Can } | null>(null);
  const [roastersOk, setRoastersOk] = useState<boolean | null>(null);
  const [productId, setProductId] = useState<string | null>(initialProduct);
  const [roasterId, setRoasterId] = useState<string | null>(null);
  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [split, setSplit] = useState<"PROPOSED" | "ALTERNATIVE">("PROPOSED");
  const [decide, setDecide] = useState(false);
  const [override, setOverride] = useState("");
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<{ startsAt: string; operatorId: string }[] | null>(null);
  const [p, setP] = useState<Preview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    void call<{ needed: Coffee[]; stock: Coffee[]; can: Can }>("/api/production/schedule/coffees").then((r) => {
      if (!r.ok) { setError(r.data); return; }
      setCoffees(r.data);
      setProductId((cur) => cur ?? r.data.needed[0]?.productId ?? null);
    });
    void call<{ roasters: unknown[] }>("/api/production/schedule").then((r) => setRoastersOk(r.ok ? r.data.roasters.length > 0 : null));
  }, []);

  const body = useMemo(() => productId ? {
    productId, roasterId, operatorId, split,
    overrideGreenKg: decide && override.trim() ? override.trim() : null,
    slots: editing && edits ? edits : null,
  } : null, [productId, roasterId, operatorId, split, decide, override, editing, edits]);

  useEffect(() => {
    if (!body) return;
    const n = ++seq.current;
    const h = setTimeout(() => {
      void call<Preview>("/api/production/schedule/plans/preview", "POST", body).then((r) => {
        if (n !== seq.current) return;
        if (r.ok) { setP(r.data); setError(null); } else { setError(r.data); }
      });
    }, 200);
    return () => clearTimeout(h);
  }, [body]);

  const can = p?.can ?? coffees?.can;
  const rows = useMemo(() => p?.slots ?? [], [p]);
  const byDay = useMemo(() => {
    const out: { day: string; rows: Draft[] }[] = [];
    for (const r of rows) {
      const d = riyadhKeyOf(r.startsAt);
      const g = out.find((x) => x.day === d);
      if (g) g.rows.push(r); else out.push({ day: d, rows: [r] });
    }
    return out;
  }, [rows]);

  function startEditing() {
    if (!p) return;
    setEdits(p.slots.map((s) => ({ startsAt: s.startsAt, operatorId: s.operatorId ?? p.operatorId ?? "" })));
    setEditing(true);
  }
  function editRow(i: number, patch: Partial<{ startsAt: string; operatorId: string }>) {
    setEdits((cur) => (cur ? cur.map((e, j) => (j === i ? { ...e, ...patch } : e)) : cur));
  }

  async function approve() {
    if (!p || !body) return;
    setBusy(true); setMsg(null);
    const r = await call<{ planId: string; slots: number }>("/api/production/schedule/plans", "POST", { ...body, expectedGreenKg: p.quantities.greenToPlanKg, reason: reason.trim() || null });
    setBusy(false);
    if (!r.ok) { setMsg({ tone: "danger", text: errText(r.data, ar) }); setEdits(null); setEditing(false); setSplit((s) => s); return; }
    router.push(`${BASE}?approved=${r.data.slots}`);
  }

  const name = (c: Coffee) => (ar ? c.nameAr : c.nameEn);
  const kg = L("كغ", "kg");
  const q = p?.quantities;
  const ruleText = (r: Rule): [string, string] => {
    const d = r.detail as Record<string, string & number & boolean & null & { title: string; startsAt: string; outsidePlan: boolean }>;
    switch (r.key) {
      case "LIMITS":
        if (d.reason === "NOTHING_TO_PLAN") return [L("لا كمية للتخطيط", "Nothing to plan"), L("الاحتياج مغطّى بالدفعات المسجّلة والجارية والخانات المعتمدة.", "The requirement is covered by recorded and running batches and approved slots.")];
        if (d.reason) return [L("لا يوجد توزيع ضمن الحدود", "No compliant distribution"), ar ? `${d.green} كغ لا تُقسَّم إلى دفعات بين ${d.min} و${d.max} كغ` : `${d.green} kg cannot be split into batches between ${d.min} and ${d.max} kg`];
        return [L("كل دفعة بين الحد الأدنى والأقصى", "Every batch between min and max"), `${d.min} ≤ ${d.lo === d.hi ? d.lo : `${d.lo}–${d.hi}`} ≤ ${d.max}`];
      case "LAST_BATCH":
        if (!d.redistributed) return [L("لا دفعة أخيرة صغيرة", "No small last batch"), L("الباقي ضمن الحدود", "The remainder is within limits")];
        return [L("لا دفعة أخيرة صغيرة", "No small last batch"), (ar ? `${d.remainder} موزّعة على ${d.count} دفعة` : `${d.remainder} spread over ${d.count} batches`) + (d.alternative ? (ar ? ` · البديل ${d.alternativeCount} × ${d.alternativeKg}` : ` · alternative ${d.alternativeCount} × ${d.alternativeKg}`) : "")];
      case "ROASTER": {
        const m = r.detail.nextMaintenance as null | { title: string; startsAt: string; outsidePlan: boolean };
        if (r.state === "fail") return [L("المحمصة غير متاحة", "The roaster is not available"), String(r.detail.reason ?? "")];
        return [L("المحمصة متاحة في كل الخانات", "The roaster is available for every slot"), m ? (m.outsidePlan ? `${m.title} · ${L("خارج الخطة", "outside the plan")}` : m.title) : L("لا صيانة مخططة", "No planned maintenance")];
      }
      case "OPERATOR": {
        const rs = (r.detail.roasters as string[]) ?? [];
        if (!r.detail.assigned) return [L("لا مشغّل مسند", "No assigned operator"), (r.detail.eligible as number) === 0 ? L("اربط مشغّلًا مخوّلًا بهذه المحمصة من الإعدادات › المشغّلون.", "Link an authorized operator to this roaster in Settings › Operators.") : L("اختر مشغّلًا مسندًا إلى هذه المحمصة.", "Choose an operator assigned to this roaster.")];
        if (r.state === "fail") return [L("تعارض للمشغّل", "Operator conflict"), L("المشغّل في خانة أخرى في الوقت نفسه.", "The operator is on another slot at the same time.")];
        return [L("لا تعارض للمشغّل", "No operator conflict"), `${r.detail.operatorName ?? ""} ${ar ? `مسند إلى ${rs.join("، ")}${rs.length === 1 ? " فقط" : ""}` : `assigned to ${rs.join(", ")}${rs.length === 1 ? " only" : ""}`}`];
      }
      case "TIME":
        return r.state === "ok" ? [L("الخانات ضمن ساعات العمل", "Slots within working hours"), L("بلا تداخل مع المحمصة أو المشغّل أو الصيانة", "No overlap with the roaster, the operator or maintenance")]
          : [L("لا وقت كافٍ", "Not enough time"), ar ? `وُضعت ${r.detail.placed} من ${r.detail.needed} خانة خلال ${r.detail.horizonDays} يومًا، أو في خانة تعارض` : `${r.detail.placed} of ${r.detail.needed} slots placed within ${r.detail.horizonDays} days, or a slot conflicts`];
      case "SPANS":
        return [L("الخطة تمتد إلى الغد", "The plan runs into the next days"), ar ? `${r.detail.today} خانات اليوم و${r.detail.later} لاحقًا` : `${r.detail.today} slots today and ${r.detail.later} later`];
    }
  };
  const conflictText: Record<NonNullable<Draft["conflict"]>, [string, string]> = {
    MACHINE: ["تعارض محمصة", "Roaster conflict"], OPERATOR: ["تعارض مشغّل", "Operator conflict"], HOURS: ["خارج ساعات العمل", "Outside hours"],
    MAINTENANCE: ["داخل صيانة", "In maintenance"], PAST: ["وقت مضى", "In the past"], OPERATOR_NOT_ASSIGNED: ["مشغّل غير مسند", "Operator not assigned"],
  };

  const noCoffee = coffees && coffees.needed.length === 0 && coffees.stock.length === 0;
  return (
    <ScheduleFrame view="plan" when={p ? <NowText now={p.now} /> : null} testId="schedule-plan">
      {msg ? <div style={{ paddingTop: 16 }}><OpsBanner tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</OpsBanner></div> : null}
      {roastersOk === false ? <div className="rs-stack"><NoRoaster /></div> : noCoffee ? (
        <div className="rs-stack"><div className="ss-empty" data-testid="plan-nothing"><strong>{L("لا احتياج تحميص مفتوح", "No open roasting requirement")}</strong><p>{L("كل القهوة المطلوبة مغطّاة بالرف أو بالدفعات المسجّلة.", "Every coffee needed is covered by the shelf or by recorded batches.")}</p></div></div>
      ) : error && !p ? <div className="rs-stack"><Retry error={error} onRetry={() => setProductId((x) => x)} /></div> : !p ? <div className="rs-stack"><OpsLoading rows={8} /></div> : (
        <div className="rs-stack">
          <div className="rs-plan">
            <div className="rs-pane">
              <section aria-label={L("المدخلات", "Inputs")}>
                <div className="ss-bh"><h2>{L("المدخلات", "Inputs")}</h2>{p.demand?.orders.length ? <span><N>{p.demand.orders.slice(0, 3).map((o) => `#${o.orderNumber}`).join(" · ")}</N> · {ar ? p.product.name.ar : p.product.name.en}</span> : null}</div>
                <Field label={L("القهوة", "Coffee")}>
                  <Select className="hr-select" value={productId ?? ""} onChange={(e) => { setProductId(e.target.value); setEditing(false); setEdits(null); setSplit("PROPOSED"); }} data-testid="plan-coffee">
                    {coffees?.needed.length ? <optgroup label={L("مطلوبة للطلبات", "Needed for orders")}>{coffees.needed.map((c) => <option key={c.productId} value={c.productId} data-hint={`${c.demandKg} ${kg}`}>{name(c)}</option>)}</optgroup> : null}
                    {coffees?.stock.length ? <optgroup label={L("للمخزون", "For stock")}>{coffees.stock.map((c) => <option key={c.productId} value={c.productId}>{name(c)}</option>)}</optgroup> : null}
                  </Select>
                </Field>
                <dl className="rs-kv" data-testid="plan-inputs">
                  <dt>{L("المتبقي للتحميص", "Remaining to roast")}</dt>
                  <dd><N>{q!.remainingKg}</N> {kg}{p.demand && Number(q!.remainingKg) > 0 ? <> = <N>{p.demand.openKg}</N> {L("مطلوب", "ordered")}{Number(p.demand.shelfKg) > 0 ? <> − <N>{p.demand.shelfKg}</N> {L("على الرف", "on the shelf")}</> : null}{Number(p.demand.pipelineKg) > 0 ? <> − <N>{p.demand.pipelineKg}</N> {L("مسجّلة", "recorded")}</> : null}</> : null}</dd>
                  <dt>{L("الأخضر المطلوب", "Green required")}</dt>
                  <dd><N>{q!.requiredGreenKg}</N> {kg} = <N>{q!.remainingKg}</N> ÷ (1 − <N>{q!.expectedLossPct}%</N>)</dd>
                  <dt>{L("في دفعة جارية", "In a running batch")}</dt>
                  <dd data-testid="plan-running">{q!.running.length ? <>− <N>{q!.inProgressKg}</N> {kg} · {L("بدأت", "started")} <N>{timeOf(q!.running[0].startedAt ?? q!.running[0].startsAt)}</N> · {L("لم تُسجَّل بعد", "not recorded yet")}</> : "—"}</dd>
                  {Number(q!.approvedKg) > 0 ? <><dt>{L("خانات معتمدة", "Approved slots")}</dt><dd>− <N>{q!.approvedKg}</N> {kg} · <N>{q!.approvedSlots}</N> {L("خانة", "slots")}</dd></> : null}
                  <dt><b>{L("الأخضر للتخطيط", "Green to plan")}</b></dt>
                  <dd data-testid="plan-green"><b><N>{q!.greenToPlanKg}</N> {kg}</b>{p.override ? <> · {L("قرار التخطيط:", "Planning decision:")} <b><N>{p.override}</N> {kg}</b></> : null}</dd>
                </dl>
                {can?.manage ? (
                  decide ? (
                    <div className="rs-pickers" data-testid="plan-decision">
                      <Field label={L("كمية أخضر أخرى (قرار تخطيط) · كغ", "Another green quantity (planning decision) · kg")}><input className="hr-input ss-numin" dir="ltr" inputMode="decimal" value={override} onChange={(e) => setOverride(e.target.value)} data-testid="plan-override" /></Field>
                      <Field label={L("السبب *", "Reason *")} help={Number(override) > Number(q!.greenToPlanKg) ? L("ما فوق الاحتياج تحميص للمخزون.", "Above the requirement is roasting to stock.") : undefined}><input className="hr-input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid="plan-reason" /></Field>
                      <Btn size="sm" variant="ghost" onClick={() => { setDecide(false); setOverride(""); setReason(""); }}>{L("إلغاء القرار", "Drop the decision")}</Btn>
                    </div>
                  ) : <button type="button" className="ss-link" onClick={() => setDecide(true)} data-testid="plan-decide">{L("قرار تخطيط: كمية أخرى", "Planning decision: another quantity")}</button>
                ) : null}
                <div className="rs-pickers">
                  <Field label={L("المحمصة", "Roaster")}>
                    <Select className="hr-select" value={p.roaster.id} onChange={(e) => { setRoasterId(e.target.value); setOperatorId(null); setEditing(false); setEdits(null); }} data-testid="plan-roaster">
                      {p.roasters.map((r) => <option key={r.id} value={r.id}>{`${r.name} · ${L("الهدف", "target")} ${r.targetKg}`}</option>)}
                    </Select>
                  </Field>
                  <Field label={L("المشغّل", "Operator")}>
                    <Select className="hr-select" value={p.operatorId ?? ""} onChange={(e) => { setOperatorId(e.target.value); setEditing(false); setEdits(null); }} placeholder={L("لا مشغّل مسند", "No assigned operator")} data-testid="plan-operator">
                      {p.operators.length ? null : <option value="">{L("لا مشغّل مسند", "No assigned operator")}</option>}
                      {p.operators.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </Select>
                  </Field>
                </div>
              </section>

              <section aria-label={L("التقسيم", "Split")}>
                <div className="ss-bh"><h2>{L("التقسيم", "Split")}</h2></div>
                {p.split.ok ? (
                  <div className="rs-splits" data-testid="plan-splits">
                    {p.split.target.lastBelowMin ? (
                      <div className="rs-card" data-testid="split-target">
                        <span className="rs-ct">{L("تقسيم بالهدف", "Split at target")}</span>
                        <span className="rs-cn"><N>{p.split.target.count}</N><small>{L("دفعة", "batches")}</small></span>
                        <span className="rs-cs"><N>{`${p.split.target.fullBatches} × ${p.split.target.targetKg} + 1 × ${p.split.target.remainderKg}`}</N></span>
                        <span className="rs-cf is-bad">{L("الأخيرة أقل من الحد الأدنى", "The last is below the minimum")} <N>{p.roaster.minKg}</N> {kg}</span>
                      </div>
                    ) : null}
                    <button type="button" className={`rs-card${p.split.chosen === "PROPOSED" ? " is-on" : ""}`} aria-pressed={p.split.chosen === "PROPOSED"} onClick={() => { setSplit("PROPOSED"); setEditing(false); setEdits(null); }} data-testid="split-proposed">
                      <span className="rs-ct">{L("التقسيم المقترح", "Proposed split")}</span>
                      <span className="rs-cn"><N>{p.split.proposed.count}</N><small>{L("دفعة", "batches")}</small></span>
                      <span className="rs-cs"><N>{`${p.split.proposed.text} = ${p.greenKg}`}</N></span>
                      <span className="rs-cf">{L("كل الدفعات ضمن الحدود", "Every batch within limits")}</span>
                    </button>
                    {p.split.alternative ? (
                      <button type="button" className={`rs-card${p.split.chosen === "ALTERNATIVE" ? " is-on" : ""}`} aria-pressed={p.split.chosen === "ALTERNATIVE"} onClick={() => { setSplit("ALTERNATIVE"); setEditing(false); setEdits(null); }} data-testid="split-alternative">
                        <span className="rs-ct">{L("البديل", "Alternative")}</span>
                        <span className="rs-cn"><N>{p.split.alternative.count}</N><small>{L("دفعة", "batches")}</small></span>
                        <span className="rs-cs"><N>{`${p.split.alternative.text} = ${p.greenKg}`}</N></span>
                        <span className="rs-cf">{L("دفعة إضافية وأبعد عن الهدف", "One more batch, further from target")}</span>
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div className="rs-splits" data-testid="plan-splits">
                    <div className="rs-card" data-testid="split-blocked">
                      <span className="rs-ct">{L("التقسيم المقترح", "Proposed split")}</span>
                      <span className="rs-cn"><N>{p.split.reason === "NOTHING_TO_PLAN" ? 0 : "—"}</N><small>{L("دفعة", "batches")}</small></span>
                      <span className={`rs-cf${p.split.reason === "NOTHING_TO_PLAN" ? "" : " is-bad"}`}>{p.split.reason === "NOTHING_TO_PLAN"
                        ? L("لا كمية للتخطيط.", "Nothing to plan.")
                        : ar ? `${p.split.greenKg} كغ لا تُقسَّم بين ${p.split.minKg} و${p.split.maxKg} كغ. القرار: تعديل الكمية بسبب، أو محمصة أخرى، أو التأجيل.` : `${p.split.greenKg} kg cannot be split between ${p.split.minKg} and ${p.split.maxKg} kg. Decide: change the quantity with a reason, another roaster, or defer.`}</span>
                    </div>
                  </div>
                )}
              </section>

              <section aria-label={L("قواعد التحقق", "Rules")}>
                <div className="ss-bh"><h2>{L("قواعد التحقق", "Rules")}</h2></div>
                <ul className="rs-rules" data-testid="plan-rules">
                  {p.rules.map((r) => { const [a, b] = ruleText(r); return <li key={r.key} className={`is-${r.state}`} data-rule={r.key} data-state={r.state}><i /><strong>{a}</strong><span>{b}</span></li>; })}
                </ul>
              </section>
            </div>

            <div className="rs-pane">
              <section aria-label={L("الخانات المقترحة", "Proposed slots")}>
                <div className="ss-bh"><h2>{L("الخانات المقترحة", "Proposed slots")}</h2>{rows.length ? <span><N>{`${rows.length} × ${p.roaster.cycleMinutes}`}</N> {L("دقيقة", "min")}</span> : null}</div>
                {rows.length === 0 ? <p className="ss-muted" data-testid="plan-noslots">{L("لا خانات: عالج القاعدة الحمراء أولًا.", "No slots: resolve the red rule first.")}</p> : (
                  <div className="hr-tablewrap">
                    <table className="hr-table rs-table" data-testid="plan-slots">
                      <thead><tr><th>#</th><th>{L("البدء", "Start")}</th><th className="hr-hide-mobile">{L("المحمصة", "Roaster")}</th><th>{L("المشغّل", "Operator")}</th><th className="is-num">{L("أخضر مخطط · كغ", "Planned green · kg")}</th></tr></thead>
                      <tbody>
                        {byDay.map((g) => [
                          <tr key={`d${g.day}`} className="rs-dayrow"><td colSpan={5}>{dayLabel(`${g.day}T12:00:00+03:00`, ar)} · {ar ? `${g.rows.length} دفعات` : `${g.rows.length} batches`}</td></tr>,
                          ...g.rows.map((s) => (
                            <tr key={s.index} data-testid="plan-slot" data-conflict={s.conflict ?? ""}>
                              <td><N>{s.index}</N></td>
                              <td>{editing && edits ? <input className="hr-input rs-cell-in" type="datetime-local" dir="ltr" step={300} value={toLocal(edits[s.index - 1].startsAt)} onChange={(e) => e.target.value && editRow(s.index - 1, { startsAt: fromLocal(e.target.value) })} data-testid="edit-start" /> : <N>{timeOf(s.startsAt)}</N>}
                                {s.conflict ? <span className="hr-flag tone-danger" style={{ marginInlineStart: 6 }}><span>{ar ? conflictText[s.conflict][0] : conflictText[s.conflict][1]}</span></span> : null}</td>
                              <td className="hr-hide-mobile">{p.roaster.name}</td>
                              <td>{editing && edits ? (
                                <select className="hr-select rs-cell-in" value={edits[s.index - 1].operatorId} onChange={(e) => editRow(s.index - 1, { operatorId: e.target.value })} data-testid="edit-operator">
                                  {p.operators.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                                </select>
                              ) : s.operatorName ?? "—"}</td>
                              <td className="is-num"><N>{s.kg}</N></td>
                            </tr>
                          )),
                        ])}
                      </tbody>
                    </table>
                  </div>
                )}
                {rows.length ? <div className="rs-foot"><span>{ar ? `${rows.length} دفعة · المحمص المتوقع ${p.expectedRoastedKg} كغ` : `${rows.length} batches · expected roasted ${p.expectedRoastedKg} kg`}</span><strong><N>{p.greenKg}</N></strong></div> : null}
              </section>
            </div>
          </div>

          <Notice tone="info">{L("اعتماد الخطة يحجز خانات فقط. لا يُنشئ دفعات ولا يصرف بنًا أخضر، ولا يغيّر الطلبات. كل دفعة تُسجَّل بأوزانها الفعلية بعد التحميص، ويُعاد حساب المتبقي منها.", "Approving the plan reserves slots only. It creates no batches, uses no green coffee and changes no order. Each batch is recorded with its actual weights after the roast, and the remaining is recomputed from them.")}</Notice>
          <div className="rs-actbar">
            {can?.manage ? <Btn variant="primary" busy={busy} disabled={p.blocked || (decide && !!override.trim() && !reason.trim() && override.trim() !== q!.greenToPlanKg)} onClick={() => void approve()} data-testid="plan-approve">{t("schedApprovePlan")} · <N>{rows.length}</N> {L("خانة", "slots")}</Btn> : <span className="ss-muted" data-testid="plan-readonly">{L("للعرض فقط · يعتمد الخطة من يملك صلاحية إدارة جدول التحميص", "Read only · plans are approved by holders of the schedule permission")}</span>}
            {can?.manage && rows.length ? (editing ? <Btn onClick={() => { setEditing(false); setEdits(null); }} data-testid="plan-edit-reset">{L("الأوقات المقترحة", "Proposed times")}</Btn> : <Btn onClick={startEditing} data-testid="plan-edit">{L("تعديل الخانات", "Edit slots")}</Btn>) : null}
            <Btn variant="ghost" className="rs-end" onClick={() => router.push(BASE)}>{L("إلغاء", "Cancel")}</Btn>
          </div>
        </div>
      )}
    </ScheduleFrame>
  );
}
