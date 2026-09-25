"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronUp, Percent } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../user-context";
import {
  AccrualStatusBadge, ACCRUAL_STATUS_SPECS, ProvisionalBanner, PageHeader, SandboxBanner,
  Alert, Card, EmptyState, Spinner, SectionTitle, StatStrip, Stat, DataTable, Tr, Td,
  FilterSelect, ROW_ACTION, formatMoney, formatDay, num, toArabicDigits, api, monthOptions,
} from "../_components/ui";

/**
 * My commissions — SC-01 in the Sales Screens design.
 *
 * The one thing this screen must not do is show a final number nobody can check. Each
 * accrual carries the collection it came from, the base that collection left after tax and
 * non-qualifying amounts, the share that base was split by and the rate applied — in the
 * order the engine applies them, not a reordering that happens to reach the same total.
 *
 * The statement strip and the ledger are shown together on purpose: the strip is a summary
 * of the ledger, and a reader who doubts the summary can add the ledger up.
 *
 * PROVISIONAL INTERFACE — see the banner.
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

/** A month input value (2026-09) for the current Riyadh month. */
function currentMonthValue(): string {
  const riyadh = new Date(Date.now() + 3 * 3600_000);
  return `${riyadh.getUTCFullYear()}-${String(riyadh.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function MyCommissionsPage() {
  const user = useUser();
  const { t } = useI18n();
  const lang = user?.preferredLanguage ?? "ar";
  const ar = lang === "ar";

  const [month, setMonth] = useState(currentMonthValue());
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Which accruals have their arithmetic open. Per-row rather than one global switch: a reader
  // checking one disputed figure should not have to unfold every other row to reach it.
  const [openCalc, setOpenCalc] = useState<Record<string, boolean>>({});

  /**
   * Loads the selected period.
   *
   * Inlined rather than a named `load` called from here, because the two lint rules that
   * govern this shape cannot both be satisfied while it is separate: declared after the
   * effect it is a use-before-declaration, and declared before it the rule resolves the
   * call and sees a state write reachable from the effect body. Inlining puts the first
   * `await` ahead of every state write, which is the property the rule is asking for.
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
  const bare = (v: string) => (ar ? toArabicDigits(formatMoney(v)) : formatMoney(v));
  const money = (v: string, ccy = "SAR") =>
    `${bare(v)} ${ar ? (ccy === "SAR" ? "ر.س" : ccy) : ccy}`;
  const pct = (v: string) => {
    const trimmed = Number(v).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    return ar ? `${toArabicDigits(trimmed)}٪` : `${trimmed}%`;
  };
  const months = monthOptions(month, lang);

  return (
    <div className="space-y-[18px]">
      <ProvisionalBanner />

      <PageHeader
        title={t("commissionsTitle")}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{user?.name}</span>
            {user?.role && (
              <>
                <span aria-hidden className="text-oo-border-strong">·</span>
                <span>{user.role}</span>
              </>
            )}
          </span>
        }
        actions={
          <label className="flex flex-col gap-1">
            <span className="text-[12px] leading-[18px] text-oo-text-secondary">
              {ar ? "فترة الاحتساب — شهر ميلادي بتوقيت الرياض" : "Period — a calendar month, Riyadh time"}
            </span>
            <FilterSelect
              value={month}
              onChange={(v) => { setLoading(true); setError(""); setMonth(v); }}
              label={t("commissionPeriod")}
              width="w-[200px]"
              testId="mc-month"
            >
              {months.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </FilterSelect>
          </label>
        }
      />

      {/* The most important statement on the page. A commission figure that looks settled
          when no money has moved is the single most misleading thing this screen could do. */}
      {data?.sandbox && <SandboxBanner notice={data.notice} />}

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}

      {loading ? (
        <Spinner />
      ) : !data ? null : (
        <>
          {/* ── What the reader came for ──────────────────────────────────────────── */}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2" data-testid="statement-badges">
                {["PAID", "ACCRUED"]
                  .filter((s) => data.accruals.some((a) => a.status === s))
                  .map((s) => (
                    <AccrualStatusBadge key={s} status={s} />
                  ))}
              </div>
              <div className="text-end">
                <p className="text-[12px] leading-[18px] text-oo-text-secondary">
                  {ar ? "المتبقّي لك عن هذه الفترة" : "Outstanding to you for this period"}
                </p>
                <p
                  className="text-[32px] font-bold leading-[44px] text-oo-action-primary tabular-nums"
                  data-testid="outstanding"
                >
                  {money(data.statement.outstanding)}
                </p>
                <p className="text-[12px] leading-[18px] text-oo-text-muted">
                  {ar
                    ? `من إجمالي مستحق ${money(data.statement.accrued)} · صُرف منها ${bare(data.statement.paid)}`
                    : `of ${money(data.statement.accrued)} accrued · ${bare(data.statement.paid)} already paid`}
                </p>
              </div>
            </div>
          </Card>

          {/* ── The statement, and the sum that produced it ───────────────────────── */}
          <div>
            <SectionTitle>{ar ? "كشف الفترة" : "This period's statement"}</SectionTitle>
            <StatStrip>
              <Stat
                label={t("commissionAccrued")}
                value={money(data.statement.accrued)}
                note={ar ? "قيود الاستحقاق + العكوس" : "accrual entries plus reversals"}
                testId="stat-accrued"
              />
              <Stat
                label={t("commissionAdjustments")}
                value={money(data.statement.adjustments)}
                note={ar ? "مجموع قيود التسوية" : "sum of adjustment entries"}
                testId="stat-adjustments"
              />
              <Stat
                label={t("commissionPaid")}
                value={money(data.statement.paid)}
                note={ar ? "مجموع قيود الصرف" : "sum of payout entries"}
                testId="stat-paid"
              />
              <Stat
                label={t("commissionOutstanding")}
                value={money(data.statement.outstanding)}
                note={ar ? "مستحق + تسويات − مدفوع" : "accrued + adjustments − paid"}
                tone="action"
                testId="stat-outstanding"
              />
            </StatStrip>
            <p className="mt-2 text-[12px] leading-[18px] text-oo-text-muted" data-testid="statement-formula">
              <span dir="ltr" className="tabular-nums">
                {bare(data.statement.accrued)} + {bare(data.statement.adjustments)} −{" "}
                {bare(data.statement.paid)} = {bare(data.statement.outstanding)}
              </span>
              {" — "}
              {ar
                ? "الكشف يُحسب من قيود السجل لا من البطاقات، والمبلغ المصروف جزء من المستحق لا إضافة عليه."
                : "The statement is computed from the ledger, not from the cards; a payout is part of what was accrued, not an addition to it."}
            </p>
          </div>

          {data.target && (
            <p className="text-[12px] leading-[18px] text-oo-text-muted">
              {t("commissionTargetLbl")}:{" "}
              <span className="tabular-nums">{money(data.target.targetAmount, data.target.currency)}</span>
              {Number(data.target.bonusAmount) > 0 && (
                <>
                  {" · "}
                  {ar ? "مكافأة التحقيق" : "Achievement bonus"}:{" "}
                  <span className="tabular-nums">{money(data.target.bonusAmount, data.target.currency)}</span>
                </>
              )}
            </p>
          )}

          {/* ── What each status means ────────────────────────────────────────────── */}
          <Card>
            <SectionTitle>
              {ar ? "معنى كل حالة — ولماذا لا يُجمع شيء مرتين" : "What each status means — and why nothing is counted twice"}
            </SectionTitle>
            <ul className="space-y-2" data-testid="status-legend">
              {/* In the order a reader meets them, ending with the one nothing writes —
                  not in whatever order the badge map happens to declare. */}
              {["ACCRUED", "APPROVED", "PAID", "REVERSED", "PREVIEW"]
                .filter((s) => s in ACCRUAL_STATUS_SPECS)
                .map((status) => (
                  <li key={status} className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[12px] leading-[18px] text-oo-text-secondary">
                      {label(STATUS_NOTES, status)}
                    </span>
                    <AccrualStatusBadge status={status} />
                  </li>
                ))}
            </ul>
          </Card>

          {/* ── The accruals themselves ───────────────────────────────────────────── */}
          {data.accruals.length === 0 ? (
            <Card>
              <EmptyState>
                <Percent size={28} className="mx-auto mb-2 opacity-40" aria-hidden />
                {t("commissionEmpty")}
              </EmptyState>
            </Card>
          ) : (
            <div>
              <SectionTitle>
                {ar
                  ? `${num(data.accruals.length, "ar")} حركات استحقاق — مجموعها يساوي «مستحق» أعلاه`
                  : `${data.accruals.length} accruals — they add up to “accrued” above`}
              </SectionTitle>
              <div className="space-y-3">
                {data.accruals.map((a) => {
                  // Restated on the row so the reader can check the figure rather than trust it.
                  const net =
                    Number(a.collectionEvent.amountGross) -
                    Number(a.collectionEvent.amountTax) -
                    Number(a.collectionEvent.amountNonQualifying);
                  const split = Number(a.sharePercent) < 100;
                  const open = !!openCalc[a.id];
                  return (
                    <div
                      key={a.id}
                      data-testid={`accrual-${a.id}`}
                      className="rounded-2xl border border-oo-border-default bg-oo-bg-default p-5"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="text-[14px] leading-[22px] tabular-nums text-oo-text-primary">
                          {money(a.amount, a.currency)}
                          <span className="block text-[12px] leading-[18px] text-oo-text-muted">
                            {ar ? "تدخل في «مستحق»" : "counts toward “accrued”"}
                          </span>
                        </div>
                        <div className="min-w-0 text-end">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <AccrualStatusBadge status={a.status} testId={`accrual-status-${a.id}`} />
                            <p className="text-[14px] font-medium leading-[22px] text-oo-text-primary">
                              {a.collectionEvent.customer?.name ?? (ar ? "بدون عميل" : "No customer")}
                            </p>
                          </div>
                          <p className="text-[12px] leading-[18px] text-oo-text-muted">
                            {ar && a.planVersion.plan.nameAr ? a.planVersion.plan.nameAr : a.planVersion.plan.name}
                            {" · "}
                            {ar ? `نسخة ${num(a.planVersion.version, "ar")}` : `v${a.planVersion.version}`}
                          </p>
                        </div>
                      </div>

                      {/* The arithmetic, in the reader's own terms.
                          Collapsed by default so the page leads with amounts, period and
                          status rather than four rows of intermediate figures per accrual —
                          but one click away, never behind a different screen, because a
                          commission figure nobody can check is not an explanation. */}
                      <button
                        type="button"
                        onClick={() => setOpenCalc((s) => ({ ...s, [a.id]: !s[a.id] }))}
                        aria-expanded={open}
                        aria-controls={`calc-${a.id}`}
                        data-testid={`toggle-calc-${a.id}`}
                        className={`${ROW_ACTION} mt-3 gap-1.5 text-oo-action-primary hover:border-oo-action-primary`}
                      >
                        {open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                        {open
                          ? (ar ? "إخفاء الحساب" : "Hide the calculation")
                          : (ar ? "عرض الحساب والتحقّق منه" : "Show the calculation and check it")}
                      </button>

                      <div id={`calc-${a.id}`} hidden={!open} className="mt-3 space-y-2">
                        {/* Step one: what the collection left behind. */}
                        <CalcRow
                          cells={[
                            [ar ? "إجمالي المقبوض" : "Collected", money(a.collectionEvent.amountGross), ""],
                            [ar ? "ضريبة" : "tax", money(a.collectionEvent.amountTax), "−"],
                            [ar ? "غير مؤهّل" : "non-qualifying", money(a.collectionEvent.amountNonQualifying), "−"],
                            [ar ? "صافي التحصيل" : "net collection", money(String(net)), "="],
                          ]}
                        />
                        {/* Step two, only when the deal is shared: the share divides the BASE. */}
                        {split && (
                          <CalcRow
                            cells={[
                              [ar ? "صافي التحصيل" : "net collection", money(String(net)), ""],
                              [ar ? "حصة الملكية" : "your share", pct(a.sharePercent), "×"],
                              [ar ? "الأساس المؤهّل" : "qualifying base", money(a.qualifyingBase), "="],
                            ]}
                          />
                        )}
                        {/* Step three: the rate on that base. */}
                        <CalcRow
                          cells={[
                            [ar ? "الأساس المؤهّل" : "qualifying base", money(a.qualifyingBase), ""],
                            [ar ? "النسبة الفعّالة" : "effective rate", pct(a.effectiveRatePercent), "×"],
                            [ar ? "العمولة" : "commission", money(a.amount, a.currency), "="],
                          ]}
                        />
                        <p className="text-[12px] leading-[18px] text-oo-text-muted">
                          {ar
                            ? "حصة الملكية تقسم الأساس المؤهّل قبل حساب النسبة، لا العمولة بعده. النسبة الفعّالة نتيجة يشتقّها النظام من الشرائح ولا تُدخل يدوياً."
                            : "The ownership share divides the qualifying base before the rate is applied, not the finished commission after it. The effective rate is derived from the tiers, never typed in."}
                        </p>
                      </div>

                      <p className="mt-3 text-[12px] leading-[18px] text-oo-text-muted">
                        {ar ? "مرجع التحصيل" : "Collection reference"}: {a.collectionEvent.externalRef}
                        {" · "}
                        {formatDay(a.collectionEvent.collectedAt, lang)}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── The ledger the statement is computed from ─────────────────────────── */}
          {data.ledger.length > 0 && (
            <div>
              <SectionTitle>
                {ar ? "سجلّ القيود — مصدر أرقام الكشف" : "The ledger — where the statement's figures come from"}
              </SectionTitle>
              <DataTable
                testId="ledger-table"
                minWidth={720}
                cols={[
                  { label: ar ? "التاريخ" : "Date", w: "w-[140px]" },
                  { label: ar ? "نوع القيد" : "Entry", w: "w-[150px]" },
                  { label: ar ? "البيان" : "Description", w: "min-w-[240px]" },
                  { label: ar ? "المبلغ" : "Amount", w: "w-[160px]", align: "end" },
                ]}
              >
                {data.ledger.map((l) => (
                  <Tr key={l.id}>
                    <Td>{formatDay(l.createdAt, lang)}</Td>
                    <Td>{label(LEDGER_LABELS, l.type)}</Td>
                    <Td className="text-oo-text-secondary">{l.reason ?? "—"}</Td>
                    <Td align="end">
                      {/* A payout is STORED positive and SUBTRACTED by the statement
                          (outstanding = accrued + adjustments − paid), so the ledger shows it
                          as the subtraction it is. A reversal is already stored negative and
                          needs no help. Getting this wrong makes the column fail to add up to
                          the figure directly above it, which is the one thing this table is
                          here to let a reader check. */}
                      {(() => {
                        const raw = Number(l.amount);
                        const reduces = l.type === "PAYOUT" || raw < 0;
                        return (
                          <span
                            className={`tabular-nums ${reduces ? "text-oo-status-rejected" : "text-oo-text-primary"}`}
                          >
                            {reduces ? "−" : "+"} {bare(String(Math.abs(raw)))}
                          </span>
                        );
                      })()}
                    </Td>
                  </Tr>
                ))}
                {/* The line that ties the ledger to the strip above it. */}
                <Tr testId="ledger-total">
                  <Td className="text-oo-text-muted">—</Td>
                  <Td className="font-medium">{ar ? "المحصّلة" : "Net"}</Td>
                  <Td className="text-oo-text-secondary">
                    {ar
                      ? `المتبقّي = ${bare(data.statement.accrued)} مستحق + ${bare(data.statement.adjustments)} تسويات − ${bare(data.statement.paid)} مدفوع`
                      : `outstanding = ${bare(data.statement.accrued)} accrued + ${bare(data.statement.adjustments)} adjustments − ${bare(data.statement.paid)} paid`}
                  </Td>
                  <Td align="end">
                    <span className="tabular-nums font-medium">= {bare(data.statement.outstanding)}</span>
                  </Td>
                </Tr>
              </DataTable>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One line of the arithmetic: a row of labelled figures joined by operators.
 *
 * The operator belongs to the cell that FOLLOWS it, so the row reads the same way in both
 * directions without a second layout.
 */
function CalcRow({ cells }: { cells: [string, string, string][] }) {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-[10px] bg-oo-bg-subtle px-3 py-[9px]">
      {cells.map(([label_, value, op], i) => (
        <div key={i} className="flex items-end gap-2">
          {op && <span className="pb-px text-[14px] leading-[22px] text-oo-text-muted">{op}</span>}
          <span className="block text-end">
            <span className="block text-[12px] leading-[18px] text-oo-text-muted">{label_}</span>
            <span className="block text-[14px] leading-[22px] tabular-nums text-oo-text-primary">{value}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
