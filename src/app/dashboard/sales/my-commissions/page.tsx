"use client";

import { useState, useEffect } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../user-context";
import { ACCRUAL_STATUS_SPECS, formatMoney, formatDay, num, api } from "../_components/ui";
import {
  useInitialMonth, PerfHeader, Bar, MonthChip, PerfNotice, PerfSandbox, PerfLoading, PerfNote, Metrics, AccrualDot,
} from "../_components/perf";

/**
 * My commissions — Direction 2.1, GX A-P05 «أهدافي وعمولاتي» (`1225:3172` / EN `1230:128990`,
 * 1024 `1228:3326`, 390 `1230:143595`).
 *
 * The one thing this screen must not do is show a final number nobody can check. Each
 * accrual carries the collection it came from, the base that collection left after tax and
 * non-qualifying amounts, the share that base was split by and the rate applied — in the
 * order the engine applies them, not a reordering that happens to reach the same total.
 *
 * The statement and the ledger are shown together on purpose: the statement is a summary
 * of the ledger, and a reader who doubts the summary can add the ledger up.
 *
 * Visual port: the same request (`/api/commissions/me`), the same figures as the server
 * sends them; the arithmetic restated on each card is the restatement the screen already made.
 */

type Accrual = {
  id: string;
  qualifyingBase: string;
  sharePercent: string;
  effectiveRatePercent: string;
  amount: string;
  currency: string;
  status: string;
  approvedAt: string | null;
  createdAt: string;
  collectionEvent: {
    externalRef: string;
    sourceSystem: string;
    collectedAt: string;
    amountGross: string;
    amountTax: string;
    amountNonQualifying: string;
    customer: { id: string; name: string } | null;
  };
  planVersion: {
    version: number;
    baseRatePercent: string;
    tierMode: string;
    plan: { code: string; name: string; nameAr: string | null };
  };
};

type Payload = {
  periodStart: string;
  periodEnd: string;
  statement: { accrued: string; adjustments: string; paid: string; outstanding: string };
  accruals: Accrual[];
  ledger: { id: string; type: string; amount: string; reason: string | null; createdAt: string }[];
  target: { targetAmount: string; bonusAmount: string; currency: string } | null;
  /** The month's target progress, as the targets screen measures it (null without a target). */
  progress: { target: string | null; achieved: string; percent: string | null; remaining: string | null; met: boolean | null } | null;
  collectionSources: string[];
  sandbox: boolean;
  notice: string | null;
};

const LEDGER_LABELS: Record<string, { en: string; ar: string }> = {
  ACCRUAL: { en: "Accrual", ar: "استحقاق" },
  ADJUSTMENT: { en: "Adjustment", ar: "تسوية" },
  REVERSAL: { en: "Reversal", ar: "عكس" },
  PAYOUT: { en: "Payout recorded", ar: "صرف مُسجَّل" },
};

/**
 * What each stored status means, and why nothing is counted twice.
 *
 * The design gives this its own card because the four states look like a progression and
 * are not one: approval does not change what is owed, and a payout is subtracted from the
 * accrued figure rather than added beside it. PREVIEW is listed and marked as never shown
 * to a rep, which is true of the stored value too — nothing writes it.
 */
const STATUS_NOTES: Record<string, { en: string; ar: string }> = {
  ACCRUED: {
    ar: "استُحقّت وقُيِّدت في السجل. تدخل في «مستحق».",
    en: "Earned and written to the ledger. It counts toward “accrued”.",
  },
  APPROVED: {
    ar: "اعتمدها المراجع. لا تغيّر «مستحق» — تغيّر الصلاحية للصرف فقط.",
    en: "A reviewer approved it. That changes eligibility to pay, not what is accrued.",
  },
  PAID: {
    ar: "صُرفت. تبقى ضمن «مستحق» ويُطرح مقابلها قيد صرف في «مدفوع».",
    en: "Paid. It stays inside “accrued”; the payout is subtracted as its own entry.",
  },
  REVERSED: {
    ar: "عُكست. يُقيَّد عكس بالسالب فينقص «مستحق» تلقائياً.",
    en: "Reversed. A negative entry reduces “accrued” by itself.",
  },
  PREVIEW: {
    ar: "قيمة معرّفة في المخطَّط ولا يكتبها هذا الإصدار إطلاقاً. لا تظهر للمندوب.",
    en: "Declared in the schema and never written by this release. A rep never sees it.",
  },
};

export default function MyCommissionsPage() {
  const user = useUser();
  const { t } = useI18n();
  const lang = user?.preferredLanguage ?? "ar";
  const ar = lang === "ar";

  const initialMonth = useInitialMonth();
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Which accruals have their arithmetic open. Per-row rather than one global switch: a reader
  // checking one disputed figure should not have to unfold every other row to reach it.
  const [openCalc, setOpenCalc] = useState<Record<string, boolean>>({});

  /**
   * Loads the selected period. Inlined in the effect so the first `await` precedes every state
   * write; `cancelled` stops a slow response for an old month landing after a newer one.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api<Payload>(`/api/commissions/me?month=${month}`);
      if (cancelled) return;
      if (res.ok) {
        setData(res.data);
        setError("");
      } else {
        setError(res.data.error ?? (ar ? "تعذّر تحميل العمولات." : "Could not load commissions."));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [month, ar]);

  const label = (map: Record<string, { en: string; ar: string }>, k: string) =>
    ar ? (map[k]?.ar ?? k) : (map[k]?.en ?? k);

  /** A bare amount — no currency — for the places the design writes a running sum. */
  const bare = (v: string) => formatMoney(v);
  const ccyText = (ccy = "SAR") => (ar ? (ccy === "SAR" ? "ر.س" : ccy) : ccy);
  const money = (v: string, ccy = "SAR") => `${bare(v)} ${ccyText(ccy)}`;
  const pct = (v: string) => `${Number(v).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}%`;

  const meta = [
    <>{user?.name}{user?.role ? ` · ${user.role}` : ""}</>,
    ...(data?.target
      ? [
          <span key="t">
            {t("commissionTargetLbl")} <span className="n">{money(data.target.targetAmount, data.target.currency)}</span>
            {Number(data.target.bonusAmount) > 0 && (
              <> · {ar ? "مكافأة" : "bonus"} <span className="n">{money(data.target.bonusAmount, data.target.currency)}</span></>
            )}
          </span>,
        ]
      : []),
  ];

  const header = (
    <PerfHeader ar={ar} title={ar ? "أهدافي وعمولاتي" : "My targets and commissions"} phoneTitle={t("commissionsTitle")}
      meta={meta}
      actions={
        <MonthChip value={month} lang={lang} testId="mc-month"
          label={ar ? "الفترة — بتوقيت الرياض" : "Period — Riyadh time"}
          onChange={(v) => { setLoading(true); setError(""); setMonth(v); }} />
      } />
  );

  if (loading && !data) return <PerfLoading ar={ar} />;

  return (
    <div className="pg">
      {header}

      {/* The most important statement on the page. A commission figure that looks settled
          when no money has moved is the single most misleading thing this screen could do. */}
      {data?.sandbox && <PerfSandbox notice={data.notice} ar={ar} />}
      <PerfNotice kind="error" ar={ar} onDismiss={() => setError("")}>{error}</PerfNotice>

      {loading ? <PerfLoading ar={ar} /> : !data ? null : (
        <>
          {/* ── What the reader came for, and the statement that produced it ──────── */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: "20px 40px", flexWrap: "wrap", margin: "4px 0 22px" }}>
            <div>
              <div className="lbl">{ar ? "المتبقّي لك عن هذه الفترة" : "Outstanding to you for this period"}</div>
              <div style={{ marginTop: 10 }} data-testid="outstanding">
                <span className="big n" style={{ color: "var(--action-primary)" }}>{bare(data.statement.outstanding)}</span>
                <span className="unit">{ccyText()}</span>
              </div>
              <div className="sm" style={{ marginTop: 8, fontSize: 12.5, color: "var(--text-muted)" }}>
                {ar
                  ? `من إجمالي مستحق ${bare(data.statement.accrued)} · صُرف منها ${bare(data.statement.paid)}`
                  : `of ${bare(data.statement.accrued)} accrued · ${bare(data.statement.paid)} already paid`}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 8 }} data-testid="statement-badges">
                {["PAID", "ACCRUED"]
                  .filter((s) => data.accruals.some((a) => a.status === s))
                  .map((s) => <AccrualDot key={s} status={s} lang={lang} />)}
              </div>
            </div>
            <div style={{ marginInlineStart: "auto", minWidth: 0, flex: "1 1 520px", maxWidth: 760 }}>
              <Metrics items={[
                { label: t("commissionAccrued"), testId: "stat-accrued", value: <span className="n">{bare(data.statement.accrued)}</span>,
                  note: ar ? "قيود الاستحقاق والعكوس" : "accrual entries and reversals" },
                { label: t("commissionAdjustments"), testId: "stat-adjustments", value: <span className="n">{bare(data.statement.adjustments)}</span>,
                  note: ar ? "مجموع قيود التسوية" : "sum of adjustment entries" },
                { label: t("commissionPaid"), testId: "stat-paid", value: <span className="n">{bare(data.statement.paid)}</span>,
                  note: ar ? "مجموع قيود الصرف" : "sum of payout entries" },
                { label: t("commissionOutstanding"), testId: "stat-outstanding", value: <span className="n">{bare(data.statement.outstanding)}</span>,
                  note: ar ? "مستحق + تسويات − مدفوع" : "accrued + adjustments − paid", tone: "action" },
              ]} />
              <p className="sm" style={{ margin: "10px 0 0", fontSize: 12, color: "var(--text-muted)" }} data-testid="statement-formula">
                <bdi dir="ltr" className="n">
                  {bare(data.statement.accrued)} + {bare(data.statement.adjustments)} − {bare(data.statement.paid)} = {bare(data.statement.outstanding)}
                </bdi>
                {" — "}
                {ar
                  ? "الكشف يُحسب من قيود السجل، والمبلغ المصروف جزء من المستحق لا إضافة عليه."
                  : "The statement is computed from the ledger; a payout is part of what was accrued, not an addition to it."}
              </p>
            </div>
          </div>

          {/* ── «أهدافي»: the month's target, achieved against it and what remains ── */}
          {data.progress && data.progress.target !== null && (
            <div className="perf-target" data-testid="target-progress">
              <div className="lbl">{ar ? "هدف الشهر" : "This month's target"}</div>
              <Bar percent={Number(data.progress.percent ?? 0)} testId="target-progress-bar"
                label={`${ar ? "تحقّق" : "Achieved"} ${data.progress.percent ?? "0"}%`} />
              <div className="sm perf-target-cap">
                <span>
                  {ar ? "تحقّق " : ""}<span className="n">{(data.progress.percent ?? "0").replace(/\.0$/, "")}%</span>{ar ? "" : " achieved"}
                  {" · "}{ar ? "المحقَّق " : "collected "}<span className="n" data-testid="target-achieved">{bare(data.progress.achieved)}</span>
                  {" "}{ar ? "من" : "of"} <span className="n">{bare(data.progress.target)}</span>
                </span>
                <span data-testid="target-remaining">
                  {data.progress.met
                    ? (ar ? "فوق الهدف" : "above target")
                    : <>{ar ? "المتبقي " : "remaining "}<span className="n">{bare(data.progress.remaining ?? "0")}</span></>}
                </span>
              </div>
            </div>
          )}

          <div className="cols perf-cols" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 40 }}>
            {/* ── The accruals themselves ───────────────────────────────────────── */}
            <div>
              {data.accruals.length === 0 ? (
                <div style={{ padding: "36px 0", textAlign: "center" }} data-testid="accruals-empty">
                  <p style={{ fontWeight: 500, margin: 0 }}>{t("commissionEmpty")}</p>
                </div>
              ) : (
                <>
                  <div className="bh">
                    <h2 className="bt">
                      {ar ? `${num(data.accruals.length, "ar")} حركات استحقاق` : `${data.accruals.length} accruals`}
                    </h2>
                    <span className="sub">{ar ? "مجموعها يساوي «المستحق»" : "they add up to “accrued”"}</span>
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {data.accruals.map((a) => {
                      // Restated on the card so the reader can check the figure rather than trust it.
                      const net =
                        Number(a.collectionEvent.amountGross) -
                        Number(a.collectionEvent.amountTax) -
                        Number(a.collectionEvent.amountNonQualifying);
                      const split = Number(a.sharePercent) < 100;
                      const open = !!openCalc[a.id];
                      const planName = ar && a.planVersion.plan.nameAr ? a.planVersion.plan.nameAr : a.planVersion.plan.name;
                      return (
                        <div key={a.id} className="perf-card" data-testid={`accrual-${a.id}`}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                            <span className="mid n" style={{ fontSize: 20 }}>{bare(a.amount)}</span>
                            {a.currency !== "SAR" && <span className="unit">{a.currency}</span>}
                            <AccrualDot status={a.status} lang={lang} testId={`accrual-status-${a.id}`} />
                            <span style={{ flex: 1 }} />
                            <span className="sm" style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                              <bdi>{a.collectionEvent.customer?.name ?? (ar ? "بدون عميل" : "No customer")}</bdi>
                              {" · "}
                              <span dir="ltr" title={planName} style={{ unicodeBidi: "isolate" }}>{a.planVersion.plan.code} v{a.planVersion.version}</span>
                            </span>
                          </div>

                          {/* The arithmetic, in the reader's own terms. Collapsed by default so the
                              page leads with amounts and status, but one click away. */}
                          <div id={`calc-${a.id}`} hidden={!open} className="perf-calc">
                            <div>
                              <span>{ar ? "إجمالي − ضريبة − غير مؤهّل = الصافي" : "gross − tax − non-qualifying = net"}</span>
                              <span dir={ar ? "rtl" : "ltr"} style={{ unicodeBidi: "isolate" }}>
                                <span className="n">{bare(a.collectionEvent.amountGross)}</span> − <span className="n">{bare(a.collectionEvent.amountTax)}</span>
                                {" "}− <span className="n">{bare(a.collectionEvent.amountNonQualifying)}</span> = <span className="n">{bare(String(net))}</span>
                              </span>
                            </div>
                            {/* Only when the deal is shared: the share divides the BASE. */}
                            {split && (
                              <div>
                                <span>{ar ? "الصافي × حصة الملكية = الأساس المؤهّل" : "net × your share = qualifying base"}</span>
                                <span dir={ar ? "rtl" : "ltr"} style={{ unicodeBidi: "isolate" }}>
                                  <span className="n">{bare(String(net))}</span> × <span className="n">{pct(a.sharePercent)}</span> = <span className="n">{bare(a.qualifyingBase)}</span>
                                </span>
                              </div>
                            )}
                            <div>
                              <span>{ar ? "الأساس × النسبة الفعّالة = العمولة" : "base × effective rate = commission"}</span>
                              <span dir={ar ? "rtl" : "ltr"} style={{ unicodeBidi: "isolate" }}>
                                <span className="n">{bare(a.qualifyingBase)}</span> × <span className="n">{pct(a.effectiveRatePercent)}</span> = <span className="n">{bare(a.amount)}</span>
                              </span>
                            </div>
                            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                              {ar
                                ? "حصة الملكية تقسم الأساس المؤهّل قبل حساب النسبة، لا العمولة بعده. النسبة الفعّالة يشتقّها النظام من الشرائح ولا تُدخل يدويًا."
                                : "The ownership share divides the qualifying base before the rate is applied, not the finished commission after it. The effective rate is derived from the tiers, never typed in."}
                            </p>
                          </div>

                          <div className="sm" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                            {ar ? "مرجع التحصيل" : "Collection reference"} <span className="id">{a.collectionEvent.externalRef}</span>
                            {" · "}<span className="n">{formatDay(a.collectionEvent.collectedAt, lang)}</span>{" · "}
                            <button
                              type="button"
                              className="perf-link"
                              onClick={() => setOpenCalc((s) => ({ ...s, [a.id]: !s[a.id] }))}
                              aria-expanded={open}
                              aria-controls={`calc-${a.id}`}
                              data-testid={`toggle-calc-${a.id}`}
                            >
                              {open
                                ? (ar ? "إخفاء الحساب" : "Hide the calculation")
                                : (ar ? "عرض الحساب والتحقّق منه" : "Show the calculation and check it")}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            {/* ── The ledger the statement is computed from ─────────────────────── */}
            <div>
              <div className="bh">
                <h2 className="bt">{ar ? "سجلّ القيود" : "The ledger"}</h2>
                <span className="sub">{ar ? "مصدر أرقام الكشف" : "where the statement's figures come from"}</span>
              </div>
              {data.ledger.length === 0 ? (
                <p className="sm" style={{ color: "var(--text-muted)", fontSize: 13.5 }}>{ar ? "لا قيود في هذه الفترة." : "No entries in this period."}</p>
              ) : (
                <div className="perf-scroll">
                  <table className="t dense" data-testid="ledger-table">
                    <thead><tr>
                      <th scope="col">{ar ? "التاريخ" : "Date"}</th>
                      <th scope="col">{ar ? "نوع القيد" : "Entry"}</th>
                      <th scope="col">{ar ? "البيان" : "Description"}</th>
                      <th scope="col" className="num">{ar ? "المبلغ" : "Amount"}</th>
                    </tr></thead>
                    <tbody>
                      {data.ledger.map((l) => {
                        // A payout is STORED positive and SUBTRACTED by the statement
                        // (outstanding = accrued + adjustments − paid), so the ledger shows it as
                        // the subtraction it is. A reversal is already stored negative.
                        const raw = Number(l.amount);
                        const reduces = l.type === "PAYOUT" || raw < 0;
                        return (
                          <tr key={l.id}>
                            <td className="n">{formatDay(l.createdAt, lang)}</td>
                            <td>{label(LEDGER_LABELS, l.type)}</td>
                            <td className="sm wrap">{l.reason ?? "—"}</td>
                            <td className="num" style={reduces ? { color: "var(--status-danger)" } : undefined}>
                              {reduces ? "−" : "+"}<span className="n">{bare(String(Math.abs(raw)))}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      {/* The line that ties the ledger to the statement above it. */}
                      <tr data-testid="ledger-total">
                        <td colSpan={3}>
                          {ar ? "المحصّلة" : "Net"} · {ar ? "سجل إضافي فقط، لا يُعدَّل" : "append-only, never edited"}
                        </td>
                        <td className="num" style={{ color: "var(--text-primary)", fontWeight: 500 }}>= <span className="n">{bare(data.statement.outstanding)}</span></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {/* What each status means, and why nothing is counted twice. */}
              <details style={{ marginTop: 18 }} data-testid="status-legend">
                <summary className="perf-link" style={{ fontSize: 13, cursor: "pointer" }}>
                  {ar ? "معنى كل حالة — ولماذا لا يُجمع شيء مرتين" : "What each status means — and why nothing is counted twice"}
                </summary>
                <dl className="props" style={{ gridTemplateColumns: "96px minmax(0,1fr)", marginTop: 10, fontSize: 13 }}>
                  {["ACCRUED", "APPROVED", "PAID", "REVERSED", "PREVIEW"]
                    .filter((s) => s in ACCRUAL_STATUS_SPECS)
                    .map((status) => (
                      <div key={status} style={{ display: "contents" }}>
                        <dt><AccrualDot status={status} lang={lang} /></dt>
                        <dd style={{ color: "var(--text-secondary)" }}>{label(STATUS_NOTES, status)}</dd>
                      </div>
                    ))}
                </dl>
              </details>
            </div>
          </div>

          <div style={{ marginTop: 24 }}>
            <PerfNote>
              <span>
                {ar
                  ? "«مستحق» يُحسب من قيود السجل. الاعتماد لا يغيّره، والصرف المسجَّل يُطرح منه ولا يُضاف إليه. الصرف تسجيل ولا يحرّك مالًا."
                  : "“Accrued” is computed from the ledger. Approval does not change it, and a recorded payout is subtracted from it, never added. A payout is a record; it moves no money."}
              </span>
            </PerfNote>
          </div>
        </>
      )}
    </div>
  );
}
