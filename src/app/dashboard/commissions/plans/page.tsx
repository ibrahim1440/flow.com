"use client";

import { useState, useEffect } from "react";
import { Plus } from "lucide-react";
import {
  useLang, Button, Field, TextInput, Select, TextArea, Modal, Alert, api, num, formatDay, formatMoney,
} from "../../sales/_components/ui";
import { PerfHeader, PerfNotice, PerfLoading, PerfNote } from "../../sales/_components/perf";

/**
 * Commission plan administration — Direction 2.1, GX A-P07 «خطط العمولات» (`1228:113728`,
 * EN `1232:34685`, 1024 `1228:117242`, 390 `1232:39222`).
 *
 * ── Why there is no "edit this version" button ──
 * A plan version is immutable once anything has accrued against it. Editing a live rule in
 * place would restate commissions people have already been told they earned, and the first
 * anyone would know is a payslip disagreeing with last month's. A change is a NEW version
 * with its own effective date; the old one keeps governing the money earned under it.
 *
 * ── Tiers are percentage POINTS on a slice ──
 * "1% plus 0.5 points on 100k–120k" pays 1,150 on a base of 110,000 — an effective
 * 1.045455% — not 1.5%. The table says so in its last column, because the difference is
 * thousands of riyals on the same numbers and it is invisible in a table of percentages.
 *
 * Visual port: the plans, versions, tiers, assignments and the three dialogs (new plan,
 * new version, assign) send exactly what they sent before.
 */

type Tier = { id?: string; fromAmount: string; toAmount: string | null; ratePercent: string };

/**
 * One version of a plan, laid out the way the frame explains a tier: the bands as a table
 * whose last column states the rate that actually applies to that slice, and a worked example.
 */
function PlanVersion({
  ar, lang, plan, version: v,
}: {
  ar: boolean;
  lang: "ar" | "en";
  plan: Plan;
  version: Version;
}) {
  const frozen = v._count.accruals > 0;
  // Two places as the frame writes a rate («2.50%»), more only when the stored rate has them —
  // a rate is never shown rounded.
  const rate = (x: string | number) => {
    const n = Number(x);
    return `${Number(n.toFixed(2)) === Number(n.toFixed(6)) ? n.toFixed(2) : String(Number(n.toFixed(6)))}%`;
  };
  const exact = (x: string | number) => `${Number(x).toFixed(6)}%`;
  const amount = (x: string | number) => formatMoney(String(x), 0);
  const money = (x: string | number) => formatMoney(String(x));
  const base = Number(v.baseRatePercent);

  /**
   * An illustration, computed the way `commissionOnCumulativeBase` computes the real thing:
   * the base rate on everything, then each band's POINTS on the slice of base inside it.
   * Taken from the plan's own bands so it can never describe a tier the plan does not have.
   */
  const example = (() => {
    const second = v.tiers[1];
    if (!second) return null;
    const from = Number(second.fromAmount);
    const to = second.toAmount === null ? from * 2 : Number(second.toAmount);
    const at = Math.round((from + (to - from) / 2) / 1000) * 1000;
    if (!(at > from)) return null;
    let total = (at * base) / 100;
    const parts = [`${amount(at)} × ${exact(base)} = ${amount(((at * base) / 100).toFixed(2))}`];
    for (const t of v.tiers) {
      const bFrom = Number(t.fromAmount);
      if (at <= bFrom) continue;
      const bTo = t.toAmount === null ? at : Math.min(at, Number(t.toAmount));
      const slice = bTo - bFrom;
      if (slice <= 0 || Number(t.ratePercent) === 0) continue;
      const add = (slice * Number(t.ratePercent)) / 100;
      total += add;
      parts.push(`${amount(slice)} × ${exact(t.ratePercent)} = ${amount(add.toFixed(2))}`);
    }
    const effective = ((total / at) * 100).toFixed(6);
    return { at, parts, total, effective };
  })();

  const ended = !!v.effectiveTo;
  return (
    <div className="perf-card" data-testid={`version-${plan.code}-${v.version}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontWeight: 600 }}>
          {ar ? (plan.nameAr ?? plan.name) : plan.name} · {ar ? `النسخة ${num(v.version, "ar")}` : `version ${v.version}`}
        </b>
        <span className={`st ${ended ? "" : "ok"}`} style={{ fontSize: 12.5 }}>
          {ended ? (ar ? "منتهية" : "ended") : (ar ? "سارية" : "in force")}
        </span>
        <span style={{ flex: 1 }} />
        {frozen ? (
          <span className="st in" style={{ fontSize: 12.5 }}>{ar ? "مجمَّدة — لها استحقاقات" : "frozen — it has accruals"}</span>
        ) : (
          <span className="st" style={{ fontSize: 12.5 }}>
            {num(v._count.assignments, lang)} {ar ? "إسناد" : v._count.assignments === 1 ? "assignment" : "assignments"}
          </span>
        )}
      </div>
      <div className="sm" style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
        {ar ? "الأساس: صافي المحصّل بعد الضريبة وغير المؤهّل" : "Basis: net collected after tax and non-qualifying"}
        {" · "}{ar ? "النسبة الأساس" : "base rate"} <span className="n">{rate(base)}</span>
        {" · "}
        {v.tierMode === "INCREMENTAL"
          ? (ar ? "الشرائح تراكمية" : "tiers are incremental")
          : (ar ? "بلا شرائح — نسبة ثابتة" : "no tiers — a flat rate")}
        {" · "}{ar ? "سريان من" : "from"} <span className="n">{formatDay(v.effectiveFrom, lang)}</span>
        {" "}{ar ? "حتى" : "until"} {v.effectiveTo ? <span className="n">{formatDay(v.effectiveTo, lang)}</span> : (ar ? "مفتوح" : "open")}
      </div>

      {v.tiers.length > 0 && (
        <div className="perf-scroll">
          <table className="t dense">
            <thead><tr>
              <th scope="col" className="num">{ar ? "من" : "From"}</th>
              <th scope="col" className="num">{ar ? "إلى" : "To"}</th>
              <th scope="col" className="num">{ar ? "نقاط تُضاف" : "Points added"}</th>
              <th scope="col">{ar ? "الأثر" : "Effect"}</th>
            </tr></thead>
            <tbody>
              {v.tiers.map((t, i) => (
                <tr key={i}>
                  <td className="num">{money(t.fromAmount)}</td>
                  <td className="num">{t.toAmount === null ? (ar ? "ما فوق" : "and above") : money(t.toAmount)}</td>
                  <td className="num">{Number(t.ratePercent) === 0 ? "—" : <span className="n">+{Number(t.ratePercent).toFixed(2)}</span>}</td>
                  {/* The column that stops "1% + 0.5 points" being read as 1.5% on everything. */}
                  <td className="sm">
                    <span className="n">{rate(base + Number(t.ratePercent))}</span>{" "}
                    {i === 0 ? (ar ? "على هذا الجزء" : "on this slice") : (ar ? "على هذا الجزء فقط" : "on this slice only")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {example && (
        <p className="sm" style={{ margin: 0, fontSize: 12.5, color: "var(--text-secondary)" }} data-testid={`tier-example-${plan.code}-${v.version}`}>
          {ar ? "مثال: أساس" : "Example: a base of"} <span className="n">{amount(example.at)}</span> → {example.parts.join(" · ")} ·{" "}
          {ar ? "المجموع" : "total"} <span className="n">{amount(example.total.toFixed(2))}</span> {ar ? "ر.س، بنسبة فعّالة" : "SAR, an effective"}{" "}
          <span className="n">{exact(example.effective)}</span> — {ar ? "لا" : "not"} <span className="n">{exact(base + Number(v.tiers[1].ratePercent))}</span>.
        </p>
      )}
    </div>
  );
}

type Version = {
  id: string;
  version: number;
  basis: string;
  tierMode: string;
  baseRatePercent: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  tiers: Tier[];
  _count: { accruals: number; assignments: number };
};

type Plan = {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  isActive: boolean;
  versions: Version[];
  _count: { assignments: number };
};

type Assignment = {
  id: string;
  employeeId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  live: boolean;
  employee: { id: string; name: string; role: string; active: boolean };
  plan: { id: string; code: string; name: string };
  planVersion: { id: string; version: number; baseRatePercent: string; tierMode: string; currency: string };
};

export default function CommissionPlansPage() {
  const lang = useLang();
  const ar = lang === "ar";

  const [plans, setPlans] = useState<Plan[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [employees, setEmployees] = useState<{ id: string; name: string; role: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dialog, setDialog] = useState<
    { kind: "plan" } | { kind: "version"; plan: Plan } | { kind: "assign" } | null
  >(null);

  /**
   * Reload counter. The fetch lives in the effect; mutations refresh by bumping this instead of
   * holding a callable loader, so the refresh behaviour is unchanged.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, a] = await Promise.all([
        api<{ plans: Plan[] }>("/api/commissions/plans"),
        api<{ assignments: Assignment[]; employees: { id: string; name: string; role: string }[] }>(
          "/api/commissions/assignments",
        ),
      ]);
      if (cancelled) return;
      if (p.ok) setPlans(p.data.plans);
      else setError(p.data.error ?? (ar ? "تعذّر تحميل الخطط." : "Could not load the plans."));
      if (a.ok) {
        setAssignments(a.data.assignments);
        setEmployees(a.data.employees);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [ar, reloadToken]);

  if (loading) return <PerfLoading ar={ar} />;

  const live = assignments.filter((a) => a.live).length;
  const done = (msg: string) => { setDialog(null); setSuccess(msg); reload(); };

  const actions = (
    <>
      <button type="button" className="btn" onClick={() => setDialog({ kind: "assign" })} data-testid="new-assignment">
        {ar ? "إسناد موظّف إلى خطة" : "Assign someone to a plan"}
      </button>
      <button type="button" className="btn p" onClick={() => setDialog({ kind: "plan" })} data-testid="new-plan">
        <svg className="ico s" viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
        {ar ? "خطة جديدة" : "New plan"}
      </button>
    </>
  );

  return (
    <div className="pg">
      <PerfHeader ar={ar} title={ar ? "الأداء والعمولات" : "Performance and commissions"}
        phoneTitle={ar ? "خطط العمولات" : "Commission plans"}
        meta={[
          ar ? "النسخة تُجمَّد عند أول استحقاق" : "A version freezes at its first accrual",
          <>{num(plans.length, lang)} {ar ? "خطة" : plans.length === 1 ? "plan" : "plans"} · {num(live, lang)} {ar ? "إسناد ساري" : "live assignments"}</>,
        ]}
        actions={actions} />

      <PerfNotice kind="error" ar={ar} onDismiss={() => setError("")}>{error}</PerfNotice>
      <PerfNotice kind="success" ar={ar} onDismiss={() => setSuccess("")}>{success}</PerfNotice>

      {plans.length === 0 ? (
        <div style={{ padding: "40px 0", textAlign: "center" }} data-testid="plans-empty">
          <p style={{ fontWeight: 500, margin: 0 }}>{ar ? "لا توجد خطط عمولات بعد." : "No commission plans yet."}</p>
        </div>
      ) : (
        <div className="cols perf-cols" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 40 }}>
          {plans.map((plan) => (
            <div key={plan.id} style={{ display: "grid", gap: 10, alignContent: "start", minWidth: 0 }} data-testid={`plan-${plan.code}`}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="perf-code">{plan.code}</span>
                <b style={{ fontWeight: 600, fontSize: 15 }}>{ar ? (plan.nameAr ?? plan.name) : plan.name}</b>
                {plan.description && <span className="sm" style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{plan.description}</span>}
                {!plan.isActive && <span className="perf-code">{ar ? "غير نشطة" : "inactive"}</span>}
                <span style={{ flex: 1 }} />
                <button type="button" className="btn g sm" onClick={() => setDialog({ kind: "version", plan })} data-testid={`new-version-${plan.code}`}>
                  <svg className="ico s" viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
                  {ar ? "إصدار جديد" : "New version"}
                </button>
              </div>
              {plan.versions.map((v) => (
                <PlanVersion key={v.id} ar={ar} lang={lang} plan={plan} version={v} />
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="hr" style={{ margin: "28px 0" }} />

      {/* ── Assignments ───────────────────────────────────────────── */}
      <div className="bh">
        <h2 className="bt">{ar ? "إسناد الموظّفين" : "Assignments"}</h2>
        <span className="sub">{ar ? "لكل موظّف نسخة وفترة سريان" : "each person has a version and a period"}</span>
      </div>
      {assignments.length === 0 ? (
        <p className="sm" style={{ color: "var(--text-muted)", fontSize: 13.5 }}>{ar ? "لم يُعيَّن أحد بعد." : "Nobody is assigned yet."}</p>
      ) : (
        <div className="perf-scroll">
          <table className="t" data-testid="assignments-table">
            <thead><tr>
              <th scope="col">{ar ? "الموظّف" : "Employee"}</th>
              <th scope="col">{ar ? "النسخة" : "Version"}</th>
              <th scope="col">{ar ? "سريان من" : "From"}</th>
              <th scope="col">{ar ? "سريان حتى" : "Until"}</th>
              <th scope="col"><span className="sr-only">{ar ? "الإجراء" : "Action"}</span></th>
            </tr></thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id} data-testid={`assignment-${a.employeeId}`}>
                  <td>
                    <span className="who"><bdi>{a.employee.name}</bdi></span>
                    {!a.employee.active && <span className="perf-code" style={{ marginInlineStart: 8 }}>{ar ? "غير نشط" : "inactive"}</span>}
                  </td>
                  <td><span dir="ltr" style={{ unicodeBidi: "isolate" }}>{a.plan.code} v{a.planVersion.version}</span></td>
                  <td className="n">{formatDay(a.effectiveFrom, lang)}</td>
                  <td>{a.effectiveTo ? <span className="n">{formatDay(a.effectiveTo, lang)}</span> : (ar ? "مفتوح" : "open")}</td>
                  <td style={{ textAlign: "end" }}>
                    {a.live ? (
                      <EndAssignmentButton
                        ar={ar}
                        assignmentId={a.id}
                        onDone={(msg) => { setSuccess(msg); reload(); }}
                        onError={setError}
                      />
                    ) : (
                      <button type="button" className="btn sm" disabled>{ar ? "منتهٍ" : "ended"}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={5}>
                {ar
                  ? "الإسنادات لا تتداخل · تُنهى ولا تُحذف · لا يُسند أحد نفسه إلى خطة، مهما كانت صلاحياته"
                  : "Assignments do not overlap · they are ended, never deleted · nobody can put themselves on a plan, whatever their privileges"}
              </td></tr>
            </tfoot>
          </table>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <PerfNote>
          <span>
            {ar
              ? "الشرائح بأثر رجعي مرفوضة في هذا الإصدار — تُعطي مبالغ مختلفة جذريًا على الأرقام نفسها. العملة الريال السعودي حصرًا: لا سياسة صرف عملات."
              : "Retroactive tiers are refused in this release — they give radically different amounts on the same figures. Saudi riyals only: there is no exchange-rate policy."}
          </span>
        </PerfNote>
      </div>

      {dialog?.kind === "plan" && <PlanDialog ar={ar} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "version" && <PlanDialog ar={ar} plan={dialog.plan} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "assign" && (
        <AssignDialog ar={ar} plans={plans} employees={employees} onClose={() => setDialog(null)} onDone={done} />
      )}
    </div>
  );
}

function EndAssignmentButton({
  ar, assignmentId, onDone, onError,
}: {
  ar: boolean; assignmentId: string; onDone: (m: string) => void; onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        data-testid={`end-${assignmentId}`}
        className="btn sm"
        type="button"
      >
        {ar ? "إنهاء الإسناد" : "End the assignment"}
      </button>
    );
  }
  return (
    <Modal
      title={ar ? "إنهاء التعيين" : "End the assignment"}
      onClose={() => setOpen(false)}
      testId="end-assignment-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={() => setOpen(false)}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy}
            testId="confirm-end"
            onClick={async () => {
              setBusy(true);
              const res = await api("/api/commissions/assignments", {
                method: "PATCH",
                body: { assignmentId, effectiveTo: date },
              });
              setBusy(false);
              setOpen(false);
              if (res.ok) onDone(ar ? "أُنهي التعيين." : "Assignment ended.");
              else onError(res.data.error ?? "");
            }}
          >
            {ar ? "إنهاء" : "End it"}
          </Button>
        </>
      }
    >
      <Field
        id="end-date"
        label={ar ? "ينتهي في" : "Ends on"}
        hint={
          ar
            ? "ينتهي ولا يُحذف: استُحقّت عمولات تحته، وحذف السطر يترك كشف راتب لا يستطيع أحد تفسيره."
            : "Ended, not deleted: money accrued under it, and removing the row leaves a payslip nobody can explain."
        }
      >
        <TextInput id="end-date" type="date" value={date} onChange={setDate} />
      </Field>
    </Modal>
  );
}

function PlanDialog({
  ar, plan, onClose, onDone,
}: {
  ar: boolean; plan?: Plan; onClose: () => void; onDone: (m: string) => void;
}) {
  const isNewVersion = !!plan;
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [description, setDescription] = useState("");
  const [baseRatePercent, setBaseRatePercent] = useState("1");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState("");
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  return (
    <Modal
      wide
      title={
        isNewVersion
          ? ar ? `إصدار جديد من ${plan!.code}` : `New version of ${plan!.code}`
          : ar ? "خطة عمولة جديدة" : "New commission plan"
      }
      onClose={onClose}
      testId="plan-dialog"
      footer={
        <>
          <Button
            variant="ghost"
            testId="add-tier"
            onClick={() => setTiers([...tiers, { fromAmount: "0", toAmount: null, ratePercent: "0" }])}
          >
            <Plus size={14} aria-hidden /> {ar ? "شريحة" : "Tier"}
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || (!isNewVersion && (code.trim().length < 2 || name.trim().length < 2))}
            testId="save-plan"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const version = {
                baseRatePercent,
                tierMode: "INCREMENTAL",
                currency: "SAR",
                effectiveFrom,
                effectiveTo: effectiveTo || null,
                tiers: tiers.map((t) => ({
                  fromAmount: t.fromAmount,
                  toAmount: t.toAmount === null || t.toAmount === "" ? null : t.toAmount,
                  ratePercent: t.ratePercent,
                })),
              };
              const res = isNewVersion
                ? await api(`/api/commissions/plans/${plan!.id}/versions`, { method: "POST", body: version })
                : await api("/api/commissions/plans", {
                    method: "POST",
                    body: { code, name, nameAr, description, version },
                  });
              setBusy(false);
              if (res.ok) onDone(isNewVersion ? (ar ? "أُضيف الإصدار." : "Version added.") : ar ? "أُنشئت الخطة." : "Plan created.");
              else setErr(res.data.error ?? "");
            }}
          >
            {ar ? "حفظ" : "Save"}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}

      {!isNewVersion && (
        <>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field id="pl-code" label={ar ? "الرمز" : "Code"} required hint="STANDARD, SENIOR…">
              <TextInput id="pl-code" value={code} onChange={setCode} />
            </Field>
            <Field id="pl-name" label={ar ? "الاسم" : "Name"} required>
              <TextInput id="pl-name" value={name} onChange={setName} />
            </Field>
          </div>
          <Field id="pl-namear" label={ar ? "الاسم بالعربية" : "Arabic name"}>
            <TextInput id="pl-namear" value={nameAr} onChange={setNameAr} />
          </Field>
          <Field id="pl-desc" label={ar ? "الوصف" : "Description"}>
            <TextArea id="pl-desc" value={description} onChange={setDescription} rows={2} />
          </Field>
        </>
      )}

      <div className="grid sm:grid-cols-3 gap-3">
        <Field
          id="pl-rate"
          label={ar ? "النسبة الأساسية %" : "Base rate %"}
          required
          hint={ar ? "تُطبَّق على كامل الأساس." : "Applied to the whole base."}
        >
          <TextInput id="pl-rate" value={baseRatePercent} onChange={setBaseRatePercent} inputMode="decimal" />
        </Field>
        <Field id="pl-from" label={ar ? "سارية من" : "Effective from"} required>
          <TextInput id="pl-from" type="date" value={effectiveFrom} onChange={setEffectiveFrom} />
        </Field>
        <Field id="pl-to" label={ar ? "حتى" : "Until"} hint={ar ? "اتركه فارغاً للمفتوح." : "Leave empty for open-ended."}>
          <TextInput id="pl-to" type="date" value={effectiveTo} onChange={setEffectiveTo} />
        </Field>
      </div>

      <div>
        <p className="text-xs font-bold text-oo-text-secondary mb-2">{ar ? "الشرائح" : "Tiers"}</p>
        {tiers.length === 0 ? (
          <p className="text-xs text-oo-text-muted font-semibold">
            {ar ? "بلا شرائح: النسبة الأساسية على كل شيء." : "No tiers: the base rate on everything."}
          </p>
        ) : (
          <div className="space-y-2">
            {tiers.map((t, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end" data-testid={`tier-${i}`}>
                <Field id={`tier-from-${i}`} label={ar ? "من" : "From"}>
                  <TextInput
                    id={`tier-from-${i}`}
                    value={t.fromAmount}
                    inputMode="decimal"
                    onChange={(v) => setTiers(tiers.map((x, j) => (j === i ? { ...x, fromAmount: v } : x)))}
                  />
                </Field>
                <Field id={`tier-to-${i}`} label={ar ? "إلى (فارغ = فأكثر)" : "To (empty = and above)"}>
                  <TextInput
                    id={`tier-to-${i}`}
                    value={t.toAmount ?? ""}
                    inputMode="decimal"
                    onChange={(v) => setTiers(tiers.map((x, j) => (j === i ? { ...x, toAmount: v || null } : x)))}
                  />
                </Field>
                <Field id={`tier-rate-${i}`} label={ar ? "+ نقاط" : "+ points"}>
                  <TextInput
                    id={`tier-rate-${i}`}
                    value={t.ratePercent}
                    inputMode="decimal"
                    onChange={(v) => setTiers(tiers.map((x, j) => (j === i ? { ...x, ratePercent: v } : x)))}
                  />
                </Field>
                <Button variant="ghost" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>×</Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-oo-text-muted mt-2 font-medium">
          {ar
            ? "الشريحة تضيف نقاطاً مئوية على الجزء الواقع داخل نطاقها فقط. مثال: 1% + 0.5 نقطة على 100,000–120,000 تدفع 1,150 على أساس 110,000 — أي 1.045455% فعلياً، لا 1.5%."
            : "A tier adds percentage POINTS to the slice of base inside its band only. 1% plus 0.5 points on 100,000–120,000 pays 1,150 on a base of 110,000 — an effective 1.045455%, not 1.5%."}
        </p>
      </div>

      {isNewVersion && (
        <p className="text-[11px] text-oo-text-muted font-medium">
          {ar
            ? "الإصدار السابق يُغلق عند تاريخ بداية هذا الإصدار، فلا توجد لحظة بإصدارين ساريين. وما استُحق تحت القديم يبقى محسوباً به."
            : "The previous version is closed at this one's start date, so there is never a moment with two live versions. What was earned under the old one stays computed by it."}
        </p>
      )}
    </Modal>
  );
}

function AssignDialog({
  ar, plans, employees, onClose, onDone,
}: {
  ar: boolean;
  plans: Plan[];
  employees: { id: string; name: string; role: string }[];
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [planVersionId, setPlanVersionId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const options = plans.flatMap((p) =>
    p.versions.map((v) => ({
      id: v.id,
      label: `${p.code} v${v.version} — ${v.baseRatePercent}%${v.tiers.length ? ` +${v.tiers.length} ${ar ? "شرائح" : "tiers"}` : ""}`,
    })),
  );

  return (
    <Modal
      title={ar ? "تعيين موظف على خطة" : "Assign someone to a plan"}
      onClose={onClose}
      testId="assign-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || !employeeId || !planVersionId}
            testId="save-assignment"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api("/api/commissions/assignments", {
                method: "POST",
                body: { employeeId, planVersionId, effectiveFrom, effectiveTo: effectiveTo || null },
              });
              setBusy(false);
              if (res.ok) onDone(ar ? "تم التعيين." : "Assigned.");
              else setErr(res.data.error ?? "");
            }}
          >
            {ar ? "تعيين" : "Assign"}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}
      <Field id="as-emp" label={ar ? "الموظف" : "Employee"} required>
        <Select id="as-emp" value={employeeId} onChange={setEmployeeId}>
          <option value="">—</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </Select>
      </Field>
      <Field id="as-ver" label={ar ? "الخطة والإصدار" : "Plan and version"} required>
        <Select id="as-ver" value={planVersionId} onChange={setPlanVersionId}>
          <option value="">—</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="as-from" label={ar ? "من" : "From"} required>
          <TextInput id="as-from" type="date" value={effectiveFrom} onChange={setEffectiveFrom} />
        </Field>
        <Field id="as-to" label={ar ? "حتى" : "Until"} hint={ar ? "فارغ = مفتوح" : "empty = open"}>
          <TextInput id="as-to" type="date" value={effectiveTo} onChange={setEffectiveTo} />
        </Field>
      </div>
      <p className="text-[11px] text-oo-text-muted font-medium">
        {ar
          ? "التعيينات لا تتداخل: خطتان ساريتان لشخص واحد ليس لهما جواب محدّد."
          : "Assignments may not overlap: two live plans for one person have no defined answer."}
      </p>
    </Modal>
  );
}
