"use client";

import { useState, useEffect } from "react";
import {
  useLang, Button, Field, TextInput, TextArea, Money, Modal, Alert, api, monthOptions, formatDay, formatMoney, num,
} from "../../sales/_components/ui";
import {
  useInitialMonth, PerfHeader, MonthChip, PerfNotice, PerfSandbox, PerfLoading, PerfNote, Metrics, AccrualDot,
} from "../../sales/_components/perf";
import { usePhone } from "@/components/shell/page-context";

/**
 * Commission review and approval — Direction 2.1, GX A-P06 «مراجعة العمولات» (`1228:103105`,
 * EN `1230:135223`, 1024 `1228:105114`, 390 `1232:39133`).
 *
 * ── Two figures, from two places, on purpose ──
 * The statement comes from the append-only ledger and is the authority on what is owed. The
 * accrual rows are the per-collection explanation. They must agree, so the difference is
 * computed and SHOWN rather than assumed: a reconciliation that is only checked when
 * somebody complains is not a control. A row that does not reconcile is marked, and it is
 * the one thing on this screen worth stopping for.
 *
 * ── Nothing here rewrites an approved figure ──
 * Approving sets a status. A correction appends an adjustment carrying a reason and an
 * actor. A payout appends a payout entry. The approved number stays exactly as approved.
 *
 * Visual port: the request, the three actions and what each sends, and the conditions that
 * offer them (`can.approve`, `can.recordPayout`, pending / outstanding) are unchanged.
 */

type EmployeeRow = {
  employeeId: string;
  name: string;
  accrued: string;
  /** The positive half of `accrued`. What the per-collection rows explain. */
  accrualEntries: string;
  /** Zero, or a negative figure: commission taken back after a refund or a reversal. */
  reversals: string;
  adjustments: string;
  paid: string;
  outstanding: string;
  accrualRowsTotal: string;
  /** The part of the rows above that was frozen at approval and has since been reversed. */
  frozenReversedTotal: string;
  expectedFromRows: string;
  reconciliationDifference: string;
  reconciled: boolean;
  pendingCount: number;
  approvedCount: number;
};

type Accrual = {
  id: string;
  employeeId: string;
  qualifyingBase: string;
  sharePercent: string;
  effectiveRatePercent: string;
  amount: string;
  currency: string;
  status: string;
  approvedAt: string | null;
  createdAt: string;
  employee: { id: string; name: string };
  collectionEvent: {
    id: string; externalRef: string; sourceSystem: string; collectedAt: string; status: string;
    amountGross: string; amountTax: string; amountNonQualifying: string;
    customer: { id: string; name: string } | null;
  };
  planVersion: {
    id: string; version: number; baseRatePercent: string; tierMode: string;
    plan: { code: string; name: string; nameAr: string | null };
  };
};

type PeriodResult = {
  employeeId: string; targetAmount: string | null; qualifiedBase: string; achievementPercent: string | null;
  diffAmount: string | null; diffPercent: string | null;
  clientCommission: string; targetBonus: string; overTargetIncentive: string; totalVariable: string;
  bracketIndex: number | null; bracketKind: string | null; decisionStatus: string; computedAt: string;
  breakdown: { bracket: { index: number; kind: string; fromPercent: string; toPercent: string | null; planAmount: string; overridable: boolean } | null; decision: { amount: string; reason: string; kind: string; applies: boolean } | null };
  employee: { id: string; name: string };
  planVersion: { version: number; plan: { code: string } };
};

type Review = {
  periodResults?: PeriodResult[];
  periodStart: string;
  periodEnd: string;
  employees: EmployeeRow[];
  accruals: Accrual[];
  totals: { accrued: string; adjustments: string; paid: string; outstanding: string };
  can: { approve: boolean; recordPayout: boolean; managePlans: boolean; decide?: boolean; run?: boolean };
  sandbox: boolean;
  notice: string | null;
};



export default function CommissionReviewPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();

  const initialMonth = useInitialMonth();
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<Review | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dialog, setDialog] = useState<{ kind: "adjust" | "payout"; row: EmployeeRow } | null>(null);
  const [decide, setDecide] = useState<PeriodResult | null>(null);

  /**
   * Reload counter. The fetch lives in the effect; mutations refresh by bumping this, so the
   * behaviour is unchanged and the fetch has one owner. `cancelled` stops a slow response
   * landing after a newer one.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api<Review>(`/api/commissions/review?month=${month}`);
      if (cancelled) return;
      if (res.ok) {
        setData(res.data);
        setError("");
      } else {
        setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [month, ar, reloadToken]);


  async function approve(row: EmployeeRow) {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await api<{ approved: number; message?: string }>("/api/commissions/review/actions", {
      method: "POST",
      body: { action: "approve", employeeId: row.employeeId, month },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.data.error ?? "");
      return;
    }
    setSuccess(
      res.data.approved > 0
        ? ar ? `اعتُمدت ${res.data.approved} استحقاقات لـ ${row.name}.` : `Approved ${res.data.approved} accruals for ${row.name}.`
        : (res.data.message ?? ""),
    );
    reload();
  }

  /** The monthly run of the component plans («احتساب الشهر»). */
  async function runMonth() {
    if (busy) return;
    setBusy(true); setError("");
    const res = await api<{ employees: number; results: { delta?: string }[] }>("/api/commissions/runs", { method: "POST", body: { month } });
    setBusy(false);
    if (!res.ok) { setError(res.data.error ?? ""); return; }
    const moved = res.data.results.filter((r) => r.delta && r.delta !== "0.00").length;
    setSuccess(ar ? `احتُسب الشهر لـ ${res.data.employees} موظف؛ ${moved} بفرق مُرحَّل إلى السجل.` : `Month run for ${res.data.employees} employees; ${moved} with a difference posted to the ledger.`);
    reload();
  }

  if (loading) return <PerfLoading ar={ar} />;
  if (!data) return <div className="pg"><PerfNotice kind="error" ar={ar}>{error}</PerfNotice></div>;

  const unreconciled = data.employees.filter((e) => !e.reconciled);
  const monthLabel = monthOptions(month, lang).find((o) => o.value === month)?.label ?? month;
  const m = (v: string) => <span className="n">{formatMoney(v)}</span>;

  const planOf = (e: EmployeeRow) => {
    // The plan is not on the employee row; it is on that employee's accruals, which is where
    // the reviewer would look for it anyway.
    const pv = data.accruals.find((a) => a.employeeId === e.employeeId)?.planVersion;
    return pv ? <span dir="ltr" style={{ unicodeBidi: "isolate" }}>{pv.plan.code} v{pv.version}</span> : "—";
  };
  const counts = (e: EmployeeRow) =>
    [
      e.pendingCount > 0 ? `${num(e.pendingCount, lang)} ${ar ? "بانتظار الاعتماد" : "awaiting approval"}` : null,
      e.approvedCount > 0 ? `${num(e.approvedCount, lang)} ${ar ? "معتمدة" : "approved"}` : null,
    ].filter(Boolean).join(" · ") || (ar ? "لا حركات" : "no accruals");

  /** The row's actions, in the order the frame gives them: the one to take first, then the
   *  others in place — a disabled «صرف» while approval is pending shows the sequence. */
  const rowActions = (e: EmployeeRow) => {
    const canPay = data.can.recordPayout && Number(e.outstanding) > 0 && e.pendingCount === 0;
    return (
      <span className="perf-rowbtns">
        {data.can.approve && e.pendingCount > 0 ? (
          <button type="button" className="btn p sm" disabled={busy} onClick={() => approve(e)} data-testid={`approve-${e.employeeId}`}>
            {ar ? "اعتماد المستحق" : "Approve accrued"}
          </button>
        ) : canPay ? (
          <button type="button" className="btn sm" disabled={busy} onClick={() => setDialog({ kind: "payout", row: e })} data-testid={`payout-${e.employeeId}`}>
            {ar ? "صرف المعتمد" : "Pay approved"}
          </button>
        ) : null}
        {data.can.approve && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => setDialog({ kind: "adjust", row: e })} data-testid={`adjust-${e.employeeId}`}>
            {ar ? "تسوية" : "Adjust"}
          </button>
        )}
        {e.pendingCount > 0 && (
          <button type="button" className="btn sm" disabled title={ar ? "الصرف بعد الاعتماد" : "Payout comes after approval"}>
            {ar ? "صرف" : "Payout"}
          </button>
        )}
      </span>
    );
  };

  const outstandingCell = (e: EmployeeRow) => (
    <>
      <b className="n" style={{ fontWeight: 600 }}>{formatMoney(e.outstanding)}</b>
      {/* Only the exception is worth a flag: a "matches" on every row is noise. */}
      {!e.reconciled && (
        <span className="flag" data-testid={`reconciled-${e.employeeId}`} style={{ marginInlineStart: 8 }}>
          {ar ? "فرق " : "off by "}<span className="n">{e.reconciliationDifference}</span>
        </span>
      )}
    </>
  );
  const accruedCell = (e: EmployeeRow) => (
    <>
      {m(e.accrued)}
      {/* A reversal is shown rather than buried inside the net figure. */}
      {Number(e.reversals) !== 0 && (
        <span data-testid={`reversals-${e.employeeId}`} className="perf-sub" style={{ color: "var(--status-danger)" }}>
          {ar ? "بعد عكس " : "after reversals of "}<span className="n">{formatMoney(e.reversals)}</span>
        </span>
      )}
    </>
  );
  const nameBtn = (e: EmployeeRow) => (
    <button type="button" className="perf-who" aria-expanded={expanded === e.employeeId}
      onClick={() => setExpanded(expanded === e.employeeId ? null : e.employeeId)} data-testid={`expand-${e.employeeId}`}>
      <bdi>{e.name}</bdi>
    </button>
  );

  // «2.00%» as the frame writes it; a stored rate with more places is shown in full, never rounded.
  const pctText = (v: string) => {
    const n = Number(v);
    return `${Number(n.toFixed(2)) === Number(n.toFixed(6)) ? n.toFixed(2) : String(Number(n.toFixed(6)))}%`;
  };
  const shareText = (v: string) => `${Number(Number(v).toFixed(6))}%`;
  const detailRows = expanded ? data.accruals.filter((a) => a.employeeId === expanded) : [];

  return (
    <div className="pg">
      <PerfHeader ar={ar} title={ar ? "الأداء والعمولات" : "Performance and commissions"}
        phoneTitle={ar ? "مراجعة العمولات" : "Commission review"}
        meta={[monthLabel, ar ? "الاعتماد يشمل كل المستحق · الصرف للمعتمد فقط" : "approval covers all accrued · payout covers approved only"]}
        actions={<>
          {data.can.run && (
            <button type="button" className="btn" disabled={busy} onClick={runMonth} data-testid="run-month">{ar ? "احتساب الشهر" : "Run the month"}</button>
          )}
          <MonthChip value={month} onChange={setMonth} lang={lang} testId="cr-month" />
        </>} />

      <PerfSandbox notice={data.notice} ar={ar} />
      <PerfNotice kind="error" ar={ar} onDismiss={() => setError("")}>{error}</PerfNotice>
      <PerfNotice kind="success" ar={ar} onDismiss={() => setSuccess("")}>{success}</PerfNotice>

      {unreconciled.length > 0 && (
        <p className="notice er" role="alert" style={{ marginBottom: 16 }}>
          {ar
            ? `${unreconciled.length} سجل لا يتطابق فيه دفتر القيود مع صفوف الاستحقاق. لا تعتمد قبل فهم السبب.`
            : `${unreconciled.length} rows where the ledger and the accrual rows disagree. Do not approve before understanding why.`}
        </p>
      )}

      {(data.periodResults?.length ?? 0) > 0 && (
        <section className="cb-sec" data-testid="period-results" style={{ marginBottom: 24 }}>
          <div className="cb-sec-h">
            <h3>{ar ? "نتائج خطط المكوّنات" : "Component plans — the month"}</h3>
            <span className="cb-hint">{ar ? "أ عمولة العملاء · ب مكافأة المستهدف · ج الحافز فوق المستهدف — على المحصّل والمعتمد فقط" : "A client commission · B target bonus · C over-target — on collected and approved money only"}</span>
          </div>
          <div className="perf-scroll">
            <table className="t dense">
              <thead><tr>
                <th scope="col">{ar ? "الموظّف" : "Employee"}</th>
                <th scope="col">{ar ? "الخطة" : "Plan"}</th>
                <th scope="col" className="num">{ar ? "المستهدف" : "Target"}</th>
                <th scope="col" className="num">{ar ? "المؤهّل" : "Qualified"}</th>
                <th scope="col" className="num">{ar ? "التحقيق" : "Achievement"}</th>
                <th scope="col" className="num">{ar ? "الفرق" : "Difference"}</th>
                <th scope="col" className="num">{ar ? "أ" : "A"}</th>
                <th scope="col" className="num">{ar ? "ب" : "B"}</th>
                <th scope="col" className="num">{ar ? "ج" : "C"}</th>
                <th scope="col" className="num">{ar ? "الإجمالي" : "Total"}</th>
                <th scope="col"><span className="sr-only">{ar ? "قرار الإدارة" : "Decision"}</span></th>
              </tr></thead>
              <tbody>
                {data.periodResults!.map((r) => {
                  const br = r.breakdown?.bracket;
                  const decidable = br && (br.kind === "DISCRETIONARY" || br.overridable);
                  return (
                    <tr key={r.employeeId} data-testid={`result-${r.employeeId}`}>
                      <td><bdi>{r.employee.name}</bdi></td>
                      <td><span dir="ltr" style={{ unicodeBidi: "isolate" }}>{r.planVersion.plan.code} v{r.planVersion.version}</span></td>
                      <td className="num">{r.targetAmount ? m(r.targetAmount) : "—"}</td>
                      <td className="num">{m(r.qualifiedBase)}</td>
                      <td className="num"><span className="n">{r.achievementPercent ? `${Number(r.achievementPercent).toFixed(2)}%` : "—"}</span></td>
                      <td className="num">{r.diffAmount ? m(r.diffAmount) : "—"}</td>
                      <td className="num">{m(r.clientCommission)}</td>
                      <td className="num">
                        {m(r.targetBonus)}
                        {r.decisionStatus === "PENDING" && <span className="flag wa" style={{ marginInlineStart: 6 }} data-testid={`pending-${r.employeeId}`}>{ar ? "بانتظار قرار" : "decision pending"}</span>}
                        {r.decisionStatus === "DECIDED" && <span className="perf-sub">{ar ? "بقرار الإدارة" : "by management decision"}</span>}
                      </td>
                      <td className="num">{m(r.overTargetIncentive)}</td>
                      <td className="num"><b>{m(r.totalVariable)}</b></td>
                      <td style={{ textAlign: "end" }}>
                        {data.can.decide && decidable && (
                          <button type="button" className={`btn sm ${r.decisionStatus === "PENDING" ? "p" : ""}`} onClick={() => setDecide(r)} data-testid={`decide-${r.employeeId}`}>
                            {br!.kind === "DISCRETIONARY" ? (ar ? "قرار المكافأة التقديرية" : "Discretionary decision") : (ar ? "مبلغ بديل" : "Override")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="cb-hint">{ar ? "من 80% إلى أقل من 100% تقرر الإدارة مبلغاً تقديرياً أو صفراً مع السبب قبل الاعتماد؛ وعند 150% فأكثر تُصرف 1,000 ما لم تقرر الإدارة مبلغاً بديلاً. القرار بصلاحية الاعتماد، ولا يقرر أحد عمولته بنفسه." : "From 80% to below 100% management decides a discretionary amount or zero, with a reason, before approval; at 150% and above 1,000 is paid unless management decides an override. The decision takes the approve privilege, and nobody decides their own pay."}</p>
        </section>
      )}

      <div style={{ margin: "4px 0 28px" }}>
        <Metrics items={[
          { label: ar ? "المستحق" : "Accrued", value: m(data.totals.accrued) },
          { label: ar ? "التسويات" : "Adjustments", value: m(data.totals.adjustments) },
          { label: ar ? "المدفوع" : "Paid", value: m(data.totals.paid) },
          { label: ar ? "المتبقّي" : "Outstanding", value: m(data.totals.outstanding) },
        ]} />
      </div>

      {data.employees.length === 0 ? (
        <div style={{ padding: "40px 0", textAlign: "center" }} data-testid="review-empty">
          <p style={{ fontWeight: 500, margin: 0 }}>{ar ? "لا توجد استحقاقات في هذا الشهر." : "No accruals in this period."}</p>
        </div>
      ) : phone ? (
        <div data-testid="review-table">
          {data.employees.map((e) => (
            <div key={e.employeeId} className="mrow" data-testid={`review-row-${e.employeeId}`}>
              <div style={{ minWidth: 0 }}>{nameBtn(e)}</div>
              <span>{outstandingCell(e)}</span>
              <div className="r2"><span style={{ flex: 1 }}>{counts(e)}</span>{planOf(e)}</div>
              <div className="r2">
                <span style={{ flex: 1 }}>{ar ? "مستحق" : "Accrued"} {accruedCell(e)} · {ar ? "مدفوع" : "Paid"} {m(e.paid)}</span>
              </div>
              <div className="r2" style={{ marginTop: 6 }}>{rowActions(e)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="perf-scroll">
          <table className="t" data-testid="review-table">
            <thead><tr>
              <th scope="col">{ar ? "الموظّف" : "Employee"}</th>
              <th scope="col" className="hide-c">{ar ? "الخطة" : "Plan"}</th>
              <th scope="col" className="num">{ar ? "مستحق" : "Accrued"}</th>
              <th scope="col" className="num hide-c">{ar ? "تسويات" : "Adjustments"}</th>
              <th scope="col" className="num">{ar ? "مدفوع" : "Paid"}</th>
              <th scope="col" className="num">{ar ? "المتبقّي" : "Outstanding"}</th>
              <th scope="col"><span className="sr-only">{ar ? "الإجراءات" : "Actions"}</span></th>
            </tr></thead>
            <tbody>
              {data.employees.map((e) => (
                <tr key={e.employeeId} className={expanded === e.employeeId ? "on" : undefined} data-testid={`review-row-${e.employeeId}`}>
                  <td style={{ paddingBlock: 4 }}>
                    {nameBtn(e)}
                    <span className="perf-sub">{counts(e)}</span>
                  </td>
                  <td className="hide-c">{planOf(e)}</td>
                  <td className="num">{accruedCell(e)}</td>
                  <td className="num hide-c">{m(e.adjustments)}</td>
                  <td className="num">{m(e.paid)}</td>
                  <td className="num">{outstandingCell(e)}</td>
                  <td style={{ textAlign: "end" }}>{rowActions(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 24 }}>
          <div className="bh">
            <h2 className="bt">
              {ar ? "الاستحقاقات التفصيلية" : "The accruals behind the figure"} — <bdi>{data.employees.find((e) => e.employeeId === expanded)?.name}</bdi>
            </h2>
          </div>
          <div className="perf-scroll">
            <table className="t dense" data-testid="accrual-detail">
              <thead><tr>
                <th scope="col">{ar ? "التحصيل" : "Collection"}</th>
                <th scope="col">{ar ? "العميل" : "Customer"}</th>
                <th scope="col" className="num">{ar ? "الأساس المؤهّل" : "Qualifying base"}</th>
                <th scope="col" className="num">{ar ? "الحصة" : "Share"}</th>
                <th scope="col" className="num">{ar ? "النسبة" : "Rate"}</th>
                <th scope="col" className="num">{ar ? "المبلغ" : "Amount"}</th>
                <th scope="col">{ar ? "الحالة" : "Status"}</th>
              </tr></thead>
              <tbody>
                {detailRows.map((a) => (
                  <tr key={a.id} data-testid={`accrual-${a.id}`}>
                    <td>
                      <span className="id">{a.collectionEvent.externalRef}</span>{" "}
                      <span className="sm">{formatDay(a.collectionEvent.collectedAt, lang)}</span>
                      {a.collectionEvent.sourceSystem === "SANDBOX" && (
                        <span className="flag wa" style={{ marginInlineStart: 6 }}>{ar ? "تجريبي" : "sandbox"}</span>
                      )}
                    </td>
                    <td><bdi>{a.collectionEvent.customer?.name ?? "—"}</bdi></td>
                    <td className="num">{m(a.qualifyingBase)}</td>
                    <td className="num"><span className="n">{shareText(a.sharePercent)}</span></td>
                    <td className="num"><span className="n">{pctText(a.effectiveRatePercent)}</span></td>
                    <td className="num">{m(a.amount)}{a.currency !== "SAR" && <span className="unit">{a.currency}</span>}</td>
                    <td><AccrualDot status={a.status} lang={lang} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sm" style={{ marginTop: 10, fontSize: 12.5, color: "var(--text-muted)" }}>
            {ar
              ? "كل صف يحمل مساهمة حدث التحصيل الخاص به — لا المجموع الجاري — فمجموع الصفوف يساوي مستحق الفترة. والنسبة الفعّالة تشرح اختلاف المبلغ عن الأساس × النسبة الأساس بعد تجاوز شريحة."
              : "Each row carries its own collection event's contribution, not the running total, so the rows sum to the period's accrued figure. The effective rate explains why the amount is not simply base × base rate once a tier has been crossed."}
          </p>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <PerfNote>
          <span>
            {ar
              ? "الاعتماد يشمل كل ما هو «مستحق» للموظف في الفترة — لا اعتماد جزئي لحركة واحدة. الصرف يشمل «المعتمَد» فقط، وهو تسجيل بأن الصرف تم ولا يحرّك مالًا. «تسوية» تكتب قيدًا موجبًا أو سالبًا بسبب إلزامي ولا تعدّل حركة قائمة. «المتبقّي» = مستحق + تسويات − مدفوع، من قيود السجل."
              : "Approval covers everything accrued for the employee in the period — there is no partial approval of one row. A payout covers approved rows only; it records that a payment was made and moves no money. “Adjust” writes a positive or negative entry with a mandatory reason and never edits an existing row. Outstanding = accrued + adjustments − paid, from the ledger."}
          </span>
        </PerfNote>
      </div>

      {decide && (
        <DecisionDialog ar={ar} result={decide} month={month} onClose={() => setDecide(null)}
          onDone={(msg) => { setDecide(null); setSuccess(msg); reload(); }} />
      )}

      {dialog && (
        <ActionDialog
          ar={ar}
          kind={dialog.kind}
          row={dialog.row}
          month={month}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            setDialog(null);
            setSuccess(msg);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ActionDialog({
  ar, kind, row, month, onClose, onDone,
}: {
  ar: boolean;
  kind: "adjust" | "payout";
  row: EmployeeRow;
  month: string;
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const [amount, setAmount] = useState(kind === "payout" ? row.outstanding : "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const isAdjust = kind === "adjust";

  return (
    <Modal
      title={
        isAdjust
          ? ar ? `تسوية على ${row.name}` : `Adjust ${row.name}`
          : ar ? `تسجيل صرف لـ ${row.name}` : `Record a payout to ${row.name}`
      }
      onClose={onClose}
      testId={`${kind}-dialog`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || !amount || (isAdjust && reason.trim().length < 3)}
            testId={`confirm-${kind}`}
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api("/api/commissions/review/actions", {
                method: "POST",
                body: { action: kind, employeeId: row.employeeId, month, amount, reason },
              });
              setBusy(false);
              if (res.ok) {
                onDone(isAdjust ? (ar ? "سُجّلت التسوية." : "Adjustment recorded.") : ar ? "سُجّل الصرف." : "Payout recorded.");
              } else {
                setErr(res.data.error ?? "");
              }
            }}
          >
            {isAdjust ? (ar ? "تسجيل التسوية" : "Record adjustment") : ar ? "تسجيل الصرف" : "Record payout"}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}

      <dl className="bg-oo-bg-subtle rounded-xl p-3 text-sm space-y-1">
        <div className="flex justify-between gap-3">
          <dt className="text-xs font-bold text-oo-text-secondary">{ar ? "المتبقي" : "Outstanding"}</dt>
          <dd><Money value={row.outstanding} /></dd>
        </div>
      </dl>

      <Field
        id="act-amount"
        label={ar ? "المبلغ (SAR)" : "Amount (SAR)"}
        required
        hint={
          isAdjust
            ? ar ? "موجب يزيد المستحق، سالب ينقصه." : "Positive increases what is owed; negative reduces it."
            : ar ? "لا يمكن صرف أكثر من المتبقي." : "A payout cannot exceed what is outstanding."
        }
      >
        <TextInput id="act-amount" value={amount} onChange={setAmount} inputMode="decimal" />
      </Field>

      <Field
        id="act-reason"
        label={ar ? "السبب" : "Reason"}
        required={isAdjust}
        hint={
          isAdjust
            ? ar
              ? "مطلوب. التسوية إضافة إلى الدفتر تحمل من قام بها ولماذا — لا تعديل على رقم معتمد."
              : "Required. An adjustment appends an entry carrying who made it and why — it never edits an approved figure."
            : undefined
        }
      >
        <TextArea id="act-reason" value={reason} onChange={setReason} rows={3} />
      </Field>

      {!isAdjust && (
        <p className="text-[11px] text-oo-text-muted font-medium">
          {ar
            ? "هذا تسجيل بأن الصرف تم. لا يحرّك مالاً — لا يوجد تكامل مدفوعات في هذا النظام."
            : "This records that a payout was made. It does not move money — there is no payment integration in this system."}
        </p>
      )}
    </Modal>
  );
}

/** The management decision on a COMPONENTS month: an amount (or zero) with a reason. */
function DecisionDialog({ ar, result, month, onClose, onDone }: { ar: boolean; result: PeriodResult; month: string; onClose: () => void; onDone: (m: string) => void }) {
  const br = result.breakdown.bracket!;
  const [amount, setAmount] = useState(br.kind === "DISCRETIONARY" ? "" : br.planAmount);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <Modal title={ar ? `قرار الإدارة — ${result.employee.name}` : `Management decision — ${result.employee.name}`} onClose={onClose} testId="decision-dialog"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
        <Button testId="confirm-decision" disabled={busy || amount === "" || reason.trim().length < 3} onClick={async () => {
          setBusy(true); setErr("");
          const res = await api("/api/commissions/review/actions", { method: "POST", body: { action: "decide", employeeId: result.employeeId, month, amount, reason } });
          setBusy(false);
          if (res.ok) onDone(ar ? "سُجّل قرار الإدارة واحتُسب الشهر." : "The decision was recorded and the month recomputed.");
          else setErr(res.data.error ?? "");
        }}>{ar ? "تسجيل القرار" : "Record the decision"}</Button>
      </>}>
      {err && <Alert kind="error">{err}</Alert>}
      <p className="text-sm text-oo-text-secondary">
        {ar
          ? `التحقيق ${result.achievementPercent ? Number(result.achievementPercent).toFixed(2) : "—"}% — شريحة ${br.fromPercent}%${br.toPercent ? ` إلى أقل من ${br.toPercent}%` : " فأكثر"}: ${br.kind === "DISCRETIONARY" ? "مكافأة تقديرية بقرار الإدارة أو لا مكافأة." : `${formatMoney(br.planAmount)} ر.س أو مبلغ بديل بقرار الإدارة.`}`
          : `Achievement ${result.achievementPercent ? Number(result.achievementPercent).toFixed(2) : "—"}% — bracket ${br.fromPercent}%${br.toPercent ? ` to below ${br.toPercent}%` : " and above"}: ${br.kind === "DISCRETIONARY" ? "a discretionary bonus or none." : `${formatMoney(br.planAmount)} SAR or an override.`}`}
      </p>
      {result.breakdown.decision && (
        <p className="text-xs text-oo-text-muted">{ar ? "القرار الحالي:" : "Current decision:"} {formatMoney(result.breakdown.decision.amount)} — {result.breakdown.decision.reason}</p>
      )}
      <Field id="dec-amount" label={ar ? "المبلغ (ر.س) — صفر = لا مكافأة" : "Amount (SAR) — zero = no bonus"} required>
        <TextInput id="dec-amount" value={amount} onChange={setAmount} inputMode="decimal" />
      </Field>
      <Field id="dec-reason" label={ar ? "السبب" : "Reason"} required hint={ar ? "مطلوب، ويُحفظ مع القرار ومن اتخذه." : "Required; kept with the decision and who took it."}>
        <TextArea id="dec-reason" value={reason} onChange={setReason} rows={3} />
      </Field>
    </Modal>
  );
}
