"use client";

import { formatMoney, formatDay } from "../_components/ui";

/**
 * «خطتي» on «عمولاتي» — commission plan builder. The caller's own plan (from /api/commissions/me,
 * which reads the session's id only), this month's progress on a COMPONENTS plan — achievement,
 * the next threshold, the estimated A / B / C — and the months already computed. Estimates are
 * computed live from collected and approved money; the statement above stays the ledger's figure.
 * No other employee's data is ever in the payload.
 */
type Dur = { value: number; unit: "DAYS" | "MONTHS" } | null;
export type MyPlanPayload = {
  plan: null | {
    code: string; name: string; nameAr: string | null; version: number; kind: "COMPONENTS" | "TIERED";
    baseRatePercent: string; assignedFrom: string;
    components: null | {
      orderSequence: { enabled: boolean; rows: { ratePercent: string }[]; existingClientRatePercent: string; inheritSettings: boolean };
      targetBonus: { enabled: boolean; brackets: { fromPercent: string; toPercent: string | null; kind: string; amount: string | null; overridable: boolean }[] };
      overTarget: { enabled: boolean; bands: { fromPercent: string; toPercent: string | null; ratePercent: string }[] };
    };
    explanations: { key: string; ar: string; en: string }[] | null;
  };
  builder: null | {
    target: string | null; qualifiedBase: string; collectedBase: string; achievementPercent: string | null; diffAmount: string | null; diffPercent: string | null;
    clientCommission: string; targetBonus: string; overTargetIncentive: string; totalVariable: string;
    decisionStatus: string; bracket: { kind: string } | null; next: { percent: string; amountToGo: string } | null;
    activationDate: string | null; rules: { window: Dur; lapse: Dur; eligibility: Dur };
    lines: { ref: string; customerName: string | null; collectedAt: string | null; base: string; status: string; sequence: number | null; ratePercent: string; amount: string }[];
  };
  history: { periodStart: string; targetAmount: string | null; qualifiedBase: string; achievementPercent: string | null; clientCommission: string; targetBonus: string; overTargetIncentive: string; totalVariable: string; decisionStatus: string; planVersion: { version: number; plan: { code: string } } }[];
  fixedPay: { basic: string; housing: string; transport: string; total: string } | null;
};

const STATUS: Record<string, [string, string]> = {
  NEW: ["عميل جديد", "new client"], EXISTING: ["عميل حالي", "existing client"], EXCLUDED: ["مستثنى", "excluded"],
  EXPIRED: ["انتهت الأهلية", "eligibility ended"], UNKNOWN: ["بلا عميل", "no customer"],
};

export function MyPlan({ ar, data }: { ar: boolean; data: MyPlanPayload }) {
  const p = data.plan;
  const b = data.builder;
  if (!p) return null;
  const m = (v: string | null) => (v === null ? "—" : formatMoney(v));
  const pc = (v: string | null) => (v === null ? "—" : `${Number(v).toFixed(2)}%`);
  const ach = b?.achievementPercent ? Math.min(Number(b.achievementPercent), 200) : 0;
  const c = p.components;
  return (
    <section className="cb-sec" data-testid="my-plan" style={{ margin: "0 0 24px" }}>
      <div className="cb-sec-h">
        <h3>{ar ? "خطتي" : "My plan"}</h3>
        <span className="perf-code">{p.code} v{p.version}</span>
        <b style={{ fontWeight: 500 }}>{ar ? (p.nameAr ?? p.name) : p.name}</b>
        <span className="cb-hint">{ar ? "منذ" : "since"} {formatDay(p.assignedFrom)}</span>
      </div>
      {c ? (
        <div className="cb-sum" data-testid="my-plan-components">
          {c.orderSequence.enabled && <div><b>{ar ? "أ. عمولة العملاء الجدد" : "A. New-client commission"}</b>{" "}
            {c.orderSequence.rows.map((r, i) => <span key={i} className="cb-pill">{ar ? `الطلب ${i + 1}${i === c.orderSequence.rows.length - 1 ? "+" : ""}` : `order ${i + 1}${i === c.orderSequence.rows.length - 1 ? "+" : ""}`} <span className="n">{r.ratePercent}%</span></span>)}</div>}
          {c.targetBonus.enabled && <div><b>{ar ? "ب. مكافأة المستهدف" : "B. Target bonus"}</b>{" "}
            {c.targetBonus.brackets.filter((x) => x.kind !== "NONE").map((x, i) => <span key={i} className="cb-pill">{x.fromPercent}%{x.toPercent ? `–${x.toPercent}%` : "+"} → {x.kind === "FIXED" ? <span className="n">{formatMoney(x.amount ?? "0", 0)}</span> : (ar ? "تقديري" : "discretionary")}</span>)}</div>}
          {c.overTarget.enabled && <div><b>{ar ? "ج. الحافز الحدّي" : "C. Marginal incentive"}</b>{" "}
            {c.overTarget.bands.map((x, i) => <span key={i} className="cb-pill">{x.fromPercent}%{x.toPercent ? `–${x.toPercent}%` : "+"} → <span className="n">{x.ratePercent}%</span> {ar ? "على الزائد" : "on the excess"}</span>)}</div>}
        </div>
      ) : (
        <p className="cb-hint">{ar ? `نسبة أساس ${p.baseRatePercent}% على صافي المحصّل.` : `A base rate of ${p.baseRatePercent}% on net collected.`}</p>
      )}

      {b && (
        <>
          {!b.activationDate && <p className="notice wa" data-testid="my-not-activated">{ar ? "العمولات لم تُفعَّل بعد؛ لا تُحتسب عمولة حتى يُحدَّد تاريخ التفعيل." : "Commissions are not activated yet; nothing is computed until the activation date is set."}</p>}
          <div className="cb-kpis" data-testid="my-month">
            <div className="cb-kpi"><span>{ar ? "نسبة التحقيق" : "Achievement"}</span><b data-testid="my-achievement">{pc(b.achievementPercent)}</b>
              <div className="cb-meter" aria-hidden><i style={{ width: `${ach / 2}%` }} /></div></div>
            <div className="cb-kpi"><span>{ar ? "المبيعات المؤهلة / المستهدف" : "Qualified / target"}</span><b className="n">{m(b.qualifiedBase)}</b><span>{ar ? "من" : "of"} {m(b.target)}</span></div>
            <div className="cb-kpi"><span>{ar ? "العتبة التالية" : "Next threshold"}</span>
              <b data-testid="my-next">{b.next ? `${b.next.percent}%` : "—"}</b>
              <span>{b.next ? (ar ? `يبقى ${formatMoney(b.next.amountToGo)} ر.س` : `${formatMoney(b.next.amountToGo)} SAR to go`) : (ar ? "لا عتبة أعلى" : "none higher")}</span></div>
            <div className="cb-kpi"><span>{ar ? "أ. عمولة العملاء (تقديري)" : "A. Client commission (est.)"}</span><b className="n" data-testid="my-a">{m(b.clientCommission)}</b></div>
            <div className="cb-kpi"><span>{ar ? "ب. مكافأة المستهدف (تقديري)" : "B. Target bonus (est.)"}</span><b className="n" data-testid="my-b">{m(b.targetBonus)}</b>
              {b.decisionStatus === "PENDING" && <span>{ar ? "بانتظار قرار الإدارة" : "awaiting management's decision"}</span>}</div>
            <div className="cb-kpi"><span>{ar ? "ج. الحافز فوق المستهدف (تقديري)" : "C. Over-target (est.)"}</span><b className="n" data-testid="my-c">{m(b.overTargetIncentive)}</b></div>
            <div className="cb-kpi"><span>{ar ? "إجمالي المتغير (تقديري)" : "Total variable (est.)"}</span><b className="n" data-testid="my-total">{m(b.totalVariable)}</b></div>
            {data.fixedPay && <div className="cb-kpi"><span>{ar ? "الراتب الثابت + المتغير" : "Fixed + variable"}</span><b className="n">{formatMoney((Number(data.fixedPay.total) + Number(b.totalVariable)).toFixed(2))}</b></div>}
          </div>
          {b.diffAmount !== null && <p className="cb-hint">{ar ? "الفرق عن المستهدف" : "Difference from target"} <span className="n">{m(b.diffAmount)}</span> ({pc(b.diffPercent)})</p>}
          {b.lines.length > 0 && (
            <div className="perf-scroll">
              <table className="t dense" data-testid="my-lines">
                <thead><tr><th scope="col">{ar ? "العميل" : "Customer"}</th><th scope="col">{ar ? "الحالة" : "Status"}</th><th scope="col" className="num">{ar ? "رقم الطلب" : "Order #"}</th><th scope="col" className="num">{ar ? "الأساس" : "Base"}</th><th scope="col" className="num">{ar ? "النسبة" : "Rate"}</th><th scope="col" className="num">{ar ? "العمولة" : "Commission"}</th></tr></thead>
                <tbody>{b.lines.map((l) => (
                  <tr key={l.ref}><td><bdi>{l.customerName ?? "—"}</bdi></td><td>{(STATUS[l.status] ?? [l.status, l.status])[ar ? 0 : 1]}</td><td className="num n">{l.sequence ?? "—"}</td><td className="num n">{m(l.base)}</td><td className="num n">{l.ratePercent}%</td><td className="num n">{m(l.amount)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <p className="cb-hint">{ar ? "تقديري: يُحسب من المبالغ المحصّلة والمعتمدة فقط، ويصبح نهائياً بعد اعتماد الإدارة. تنقطع عمولة ترتيب الطلب بانقطاع العميل، والعميل العائد بعد الانقطاع يبدأ من الطلب الأول." : "An estimate: computed on collected and approved money only, final after management's approval. The order-sequence commission ends when a client lapses; a client coming back after a lapse starts again at order 1."}</p>
        </>
      )}

      {data.history.length > 0 && (
        <div className="perf-scroll">
          <table className="t dense" data-testid="my-history">
            <thead><tr><th scope="col">{ar ? "الشهر" : "Month"}</th><th scope="col">{ar ? "النسخة" : "Version"}</th><th scope="col" className="num">{ar ? "التحقيق" : "Achievement"}</th><th scope="col" className="num">{ar ? "أ" : "A"}</th><th scope="col" className="num">{ar ? "ب" : "B"}</th><th scope="col" className="num">{ar ? "ج" : "C"}</th><th scope="col" className="num">{ar ? "الإجمالي" : "Total"}</th></tr></thead>
            <tbody>{data.history.map((h) => (
              <tr key={h.periodStart}>
                <td className="n">{new Date(new Date(h.periodStart).getTime() + 3 * 3600_000).toISOString().slice(0, 7)}</td>
                <td><span dir="ltr">{h.planVersion.plan.code} v{h.planVersion.version}</span></td>
                <td className="num n">{pc(h.achievementPercent)}</td>
                <td className="num n">{m(h.clientCommission)}</td><td className="num n">{m(h.targetBonus)}</td><td className="num n">{m(h.overTargetIncentive)}</td>
                <td className="num n"><b>{m(h.totalVariable)}</b></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
