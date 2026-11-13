"use client";

import { percentOf, wholePercentLabel } from "@/lib/format/figures";
import { halalas } from "@/lib/format/money";
import { useState, useEffect } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../user-context";
import { ROLE_LABELS, ROLE_LABELS_AR } from "@/lib/auth-shared";
import { ACCRUAL_STATUS_SPECS, formatMoney, formatDay, num, api } from "../_components/ui";
import {
  useInitialMonth, PerfHeader, Bar, MonthChip, PerfNotice, PerfSandbox, PerfLoading, PerfNote, Metrics, AccrualDot,
} from "../_components/perf";
import { type MyPlanPayload } from "./my-plan";
import { Ico } from "@/components/shell/icons";
import "../_components/money.css";

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

type Payload = Partial<MyPlanPayload> & {
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

type DayTarget = { target: string | null; achieved: string; remaining: string | null; accrued: string | null; estimate: string | null; commissionVisible: boolean; daysLeft?: number };

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
  // The plain summary on top (council fix round 1, P0-12): the same figures as «يومي» — target, collected, remaining,
  // accrued and the ESTIMATE — for this month only.
  const [day, setDay] = useState<DayTarget | null>(null);
  useEffect(() => {
    let off = false;
    api<{ target: DayTarget }>("/api/sales/my-day")
      .then((r) => { if (!off && r.ok && r.data.target) setDay(r.data.target); });
    return () => { off = true; };
  }, []);

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
  const ccyText = (ccy = "SAR") => (ar ? (ccy === "SAR" ? "ريال" : ccy) : ccy);
  const money = (v: string, ccy = "SAR") => `${bare(v)} ${ccyText(ccy)}`;
  const pct = (v: string) => `${Number(v).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}%`;

  const meta = [
    <>{user?.name}{user?.role ? ` · ${(ar ? ROLE_LABELS_AR[user.role] : ROLE_LABELS[user.role]) ?? user.role}` : ""}</>,
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
    <PerfHeader ar={ar} title={ar ? "أهدافي وعمولاتي" : "My targets and commissions"} phoneTitle={ar ? "الهدف والعمولة" : "Target & commission"}
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

      {loading ? <PerfLoading ar={ar} /> : !data ? null : (<>
          {/* «الهدف والعمولة» (owner-approved Figma page 09): the month's target and commission in plain words. «خطة عمولتي»
              (MyPlan) is hidden by the owner's decision of 3 Nov 2026; the ledger stays below, folded, for whoever checks it. */}
          <TargetAndCommission ar={ar} data={data} day={day && month === initialMonth ? day : null} />
        <details data-testid="mc-details" className="mny-acct">
          <summary style={{ cursor: "pointer", fontWeight: 600, margin: "18px 0 14px", color: "var(--text-muted)" }}>{ar ? "التفاصيل المحاسبية (للمراجعة)" : "Ledger details (for checking)"}</summary>
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
                              <span title={planName}><bdi>{planName}</bdi></span>
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
        </details>
      </>)}
    </div>
  );
}

const ACCRUAL_WORD: Record<string, [string, string, string]> = {
  ACCRUED: ["مستحقة", "Accrued", "t-ok"], APPROVED: ["معتمدة", "Approved", "t-ok"], PAID: ["انصرفت", "Paid", "t-in"], REVERSED: ["معكوسة", "Reversed", "t-er"],
};

/**
 * «الهدف والعمولة» (owner-approved Figma page 09, 3 Nov 2026): the month's target (and its bonus), the commission —
 * owed, paid, left — how it was computed in one line of figures, and the commission of each collection. The figures
 * are the statement and the accruals of GET /api/commissions/me, unchanged; nothing is recomputed but the sums shown.
 */
function TargetAndCommission({ ar, data, day }: { ar: boolean; data: Payload; day: DayTarget | null }) {
  const sar = ar ? "⃁" : "SAR";
  const whole = (v: string | number | null | undefined) => (v === null || v === undefined ? "—" : Math.round(Number(v)).toLocaleString("en-US"));
  // P2 UXM-21: what was collected and what the commission is keep their halalas (the target, the percent and the
  // estimates stay whole — they are goals, not amounts collected).
  const money = (v: string | number | null | undefined) => halalas(v);
  const p = data.progress;
  const pct = p?.percent ? Math.max(0, Math.min(100, Number(p.percent))) : 0;
  const bonus = data.target && Number(data.target.bonusAmount) > 0 ? data.target.bonusAmount : null;
  const net = (a: Accrual) => Number(a.collectionEvent.amountGross) - Number(a.collectionEvent.amountTax) - Number(a.collectionEvent.amountNonQualifying);
  const live = data.accruals.filter((a) => a.status !== "REVERSED");
  const same = (k: "sharePercent" | "effectiveRatePercent") => live.length > 0 && live.every((a) => Number(a[k]) === Number(live[0][k]));
  const pctText = (v: string) => `${Number(v).toFixed(2).replace(/\.?0+$/, "")}%`;
  const day2 = (iso: string) => new Date(iso).toLocaleDateString(ar ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", { day: "numeric", month: "long", timeZone: "Asia/Riyadh" });
  return (
    <div className="mny" data-testid="mc-summary">
      <div className="mny-row">
        <section className="mny-card" aria-labelledby="mc-goal-h" data-testid="mc-goal">
          <div className="mny-h"><div><h2 id="mc-goal-h">{ar ? "هدف الشهر" : "This month's target"}</h2><small>{ar ? "يُقاس على اللي حصّلته بدون الضريبة" : "Measured on what you collected, before VAT"}</small></div></div>
          {p && p.target !== null ? (
            <>
              <div className="mny-stats">
                <span className="mny-stat"><small>{ar ? "الهدف" : "Target"}</small><b className="num" data-testid="mc-target">{whole(p.target)}</b><span>{sar}</span></span>
                <span className="mny-stat"><small>{ar ? "حصّلت" : "Collected"}</small><b className="num" style={{ color: "var(--status-success)" }} data-testid="mc-collected">{money(p.achieved)}</b><span>{sar} · {wholePercentLabel(percentOf(p.achieved, p.target) ?? p.percent, ar)}%</span></span>
                <span className="mny-stat"><small>{p.met ? (ar ? "فوق الهدف" : "Above") : (ar ? "باقي" : "Left")}</small><b className="num" style={{ color: p.met ? "var(--status-success)" : "var(--status-warning)" }} data-testid="mc-remaining">{p.met ? "✓" : money(p.remaining)}</b><span>{p.met ? "" : sar}{!p.met && day?.daysLeft !== undefined ? (ar ? ` · ${day.daysLeft} يوم` : ` · ${day.daysLeft} days`) : ""}</span></span>
              </div>
              <span className="mny-bar ok" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></span>
              {bonus ? <p className="mny-note pr"><Ico name="flag" small />{ar ? `لو وصلت الهدف لك مكافأة ${whole(bonus)} ${sar} — تسجّلها الإدارة بعد نهاية الشهر` : `Reach the target for a ${whole(bonus)} ${sar} bonus — recorded by management after the month`}</p> : null}
            </>
          ) : <p className="mny-note box">{ar ? "ما فيه هدف مسجّل لهالشهر." : "No target for this month."}</p>}
        </section>
        <section className="mny-card" aria-labelledby="mc-com-h">
          <div className="mny-h"><div><h2 id="mc-com-h">{ar ? "عمولتي هالشهر" : "My commission this month"}</h2><small>{ar ? "تنحسب بعد ما تعتمد المالية التحصيل" : "Counted once finance approves a collection"}</small></div></div>
          <div className="mny-tiles">
            <span className="mny-tile" data-testid="mc-accrued"><small>{ar ? "مستحقة لك" : "Owed to you"}</small><b className="num">{money(data.statement.accrued)}</b><small>{sar}</small></span>
            <span className="mny-tile"><small>{ar ? "انصرفت" : "Paid"}</small><b className="num">{money(data.statement.paid)}</b><small>{sar}</small></span>
            <span className="mny-tile ok" data-testid="outstanding-tile"><small>{ar ? "باقي لك" : "Left to you"}</small><b className="num">{money(data.statement.outstanding)}</b><small>{sar}</small></span>
          </div>
          {day?.estimate ? <p className="mny-note"><Ico name="trend" small />{ar ? `لو وصلت الهدف تصير عمولتك تقريبًا ${whole(day.estimate)} ${sar}` : `At the target, about ${whole(day.estimate)} ${sar}`}</p> : null}
          <p className="mny-note" data-testid="mc-when"><Ico name="clock" small />{ar ? "متى تنصرف؟ بعد ما تعتمدها المالية، وتتحول هنا إلى «انصرفت»." : "When is it paid? After finance approves it; it then shows here as «Paid»."}</p>
        </section>
      </div>
      {live.length ? (
        <section className="mny-card" aria-labelledby="mc-how-h">
          <div className="mny-h"><div><h2 id="mc-how-h">{ar ? "كيف انحسبت عمولتك؟" : "How was it computed?"}</h2><small>{ar ? "نفس الحساب لكل تحصيل" : "The same for each collection"}</small></div></div>
          {same("sharePercent") && same("effectiveRatePercent") ? (
            <div className="mny-eq">
              <span><small>{ar ? "حصّلت بدون الضريبة" : "Collected before VAT"}</small><b className="num">{money(live.reduce((s, a) => s + net(a), 0))}</b></span><i>×</i>
              <span><small>{ar ? "حصتك من الصفقات" : "Your share"}</small><b className="num">{pctText(live[0].sharePercent)}</b></span><i>×</i>
              <span><small>{ar ? "نسبتك" : "Your rate"}</small><b className="num">{pctText(live[0].effectiveRatePercent)}</b></span><i>=</i>
              <span className="ok"><small>{ar ? "عمولتك" : "Commission"}</small><b className="num">{money(live.reduce((s, a) => s + Number(a.amount), 0))} {sar}</b></span>
            </div>
          ) : <p className="mny-note">{ar ? "التحصيل بدون الضريبة × حصتك من الصفقة × نسبتك = العمولة. النسبة أو الحصة تختلف بين التحصيلات — شوف كل تحصيل تحت." : "Collected before VAT × your share × your rate = commission. They differ between collections — see each below."}</p>}
        </section>
      ) : null}
      <section className="mny-card flush" aria-labelledby="mc-rows-h" data-testid="mc-rows">
        <div className="mny-h"><div><h2 id="mc-rows-h">{ar ? "عمولة كل تحصيل" : "Commission per collection"}</h2><small>{ar ? "الأحدث أولًا" : "Newest first"}</small></div></div>
        {data.accruals.length ? (
          <table className="mny-table">
            <thead><tr><th>{ar ? "التاريخ" : "Date"}</th><th>{ar ? "العميل" : "Customer"}</th><th>{ar ? "المحصّل" : "Collected"}</th><th>{ar ? "العمولة" : "Commission"}</th><th>{ar ? "الحالة" : "Status"}</th></tr></thead>
            <tbody>
              {[...data.accruals].sort((x, y) => y.collectionEvent.collectedAt.localeCompare(x.collectionEvent.collectedAt)).map((a) => {
                const w = ACCRUAL_WORD[a.status] ?? [a.status, a.status, ""];
                return (
                  <tr key={a.id}>
                    <td>{day2(a.collectionEvent.collectedAt)}</td>
                    <td><bdi>{a.collectionEvent.customer?.name ?? (ar ? "بدون عميل" : "No customer")}</bdi></td>
                    <td className="n num">{money(net(a))} {sar}</td>
                    <td className="ok num">{money(a.amount)} {sar}</td>
                    <td><span className={`mny-pill ${w[2]}`}>{ar ? w[0] : w[1]}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="mny-note" style={{ padding: "0 20px 16px" }}>{ar ? "ما فيه عمولة على تحصيلات هالشهر للحين." : "No commission on this month's collections yet."}</p>}
        <p className="mny-note"><Ico name="note" small />{ar ? "التحصيل اللي «بانتظار المالية» ما له عمولة للحين — تنحسب أول ما يُعتمد. تتابعه من «التحصيل»." : "A collection awaiting finance has no commission yet — it counts once approved. Follow it on «Collections»."}</p>
      </section>
    </div>
  );
}
