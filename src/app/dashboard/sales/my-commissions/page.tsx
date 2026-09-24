"use client";

import { useState, useEffect } from "react";
import { AlertTriangle, Percent, FlaskConical, ChevronDown, ChevronUp } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../../user-context";
import { formatDate } from "@/lib/utils";
import { AccrualStatusBadge } from "../_components/ui";

/**
 * My commissions.
 *
 * PROVISIONAL INTERFACE — see the banner. The Figma design is not authorised in this
 * session, so this is assembled from existing ERP components and the documented flow.
 *
 * The one thing this screen must not do is show a final number nobody can check. Each row
 * carries the base it was computed from, the rate applied and where the money came from, so
 * the reader can follow the arithmetic rather than trust it.
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

/** A month input value (2026-09) for the current Riyadh month. */
function currentMonthValue(): string {
  const riyadh = new Date(Date.now() + 3 * 3600_000);
  return `${riyadh.getUTCFullYear()}-${String(riyadh.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function MyCommissionsPage() {
  const user = useUser();
  const { t } = useI18n();
  const lang = user?.preferredLanguage ?? "ar";

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
   * effect it is read before it exists, and declared before it the effect is seen to call
   * setState synchronously. Inlining answers both — the first thing that happens is the
   * fetch, and nothing outside needs to call it, since this was its only caller.
   *
   * The spinner is raised by the month picker rather than in here, so no state is written
   * before the first `await`. `loading` starts true, which covers the first paint.
   *
   * `cancelled` is not ceremony. Switching months quickly leaves two requests in flight and
   * the slower one can land last, putting September's figures under an October heading.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/commissions/me?month=${encodeURIComponent(month)}`);
      if (cancelled) return;
      if (res.ok) {
        setData(await res.json());
      } else {
        setData(null);
        setError(lang === "ar" ? "تعذّر تحميل العمولات." : "Could not load commissions.");
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [month, lang]);

  const label = (map: Record<string, { en: string; ar: string }>, k: string) =>
    lang === "ar" ? (map[k]?.ar ?? k) : (map[k]?.en ?? k);
  const money = (v: string, ccy = "SAR") =>
    `${Number(v).toLocaleString(lang === "ar" ? "ar-SA" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;
  const pct = (v: string) => `${Number(v).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`;

  return (
    <div className="space-y-6">
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 flex items-start gap-2">
        <AlertTriangle size={15} className="text-amber-700 flex-shrink-0 mt-0.5" />
        <p className="text-xs font-bold text-amber-900">{t("provisionalUiBanner")}</p>
      </div>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal flex items-center gap-2">
            <Percent size={22} className="text-orange" /> {t("commissionsTitle")}
          </h1>
          <p className="text-brown text-sm font-medium">{user?.name}</p>
        </div>
        <label className="flex flex-col">
          <span className="text-[11px] font-bold text-brown">{t("commissionPeriod")}</span>
          <input
            type="month"
            value={month}
            onChange={(e) => { setLoading(true); setError(""); setMonth(e.target.value); }}
            className="px-3 py-2 rounded-xl border-2 border-border text-sm"
          />
        </label>
      </div>

      {/* The most important statement on the page. A commission figure that looks settled
          when no money has moved is the single most misleading thing this screen could do. */}
      {data?.sandbox && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4" role="alert" data-testid="sandbox-banner">
          <p className="text-xs font-bold text-amber-900 uppercase tracking-wide mb-1.5 flex items-center gap-2">
            <FlaskConical size={15} /> {t("sandboxBanner")}
          </p>
          <p className="text-xs text-amber-900 leading-relaxed">{t("sandboxBannerBody")}</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm font-bold" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-10 h-10 border-4 border-orange border-t-transparent rounded-full animate-spin" />
        </div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-0 border-t border-border">
            {[
              [t("commissionAccrued"), data.statement.accrued, "text-charcoal"],
              [t("commissionAdjustments"), data.statement.adjustments, "text-charcoal"],
              [t("commissionPaid"), data.statement.paid, "text-brown"],
              [t("commissionOutstanding"), data.statement.outstanding, "text-orange"],
            ].map(([lbl, val, tone]) => (
              <div key={String(lbl)} className="p-4 border-b border-border">
                <span className={`block font-mono text-xl font-semibold tabular-nums ${tone}`}>
                  {money(String(val))}
                </span>
                <span className="block text-xs text-brown/60 mt-1">{lbl}</span>
              </div>
            ))}
          </div>

          {data.target && (
            <p className="text-xs text-brown/70">
              {t("commissionTargetLbl")}: <b className="tabular-nums">{money(data.target.targetAmount, data.target.currency)}</b>
              {Number(data.target.bonusAmount) > 0 && (
                <> · {lang === "ar" ? "مكافأة التحقيق" : "Achievement bonus"}: <b className="tabular-nums">{money(data.target.bonusAmount, data.target.currency)}</b></>
              )}
            </p>
          )}

          {data.accruals.length === 0 ? (
            <div className="text-center py-14 bg-white rounded-2xl border border-border text-brown/40">
              <Percent size={36} className="mx-auto mb-3 opacity-50" />
              <p className="font-semibold">{t("commissionEmpty")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.accruals.map((a) => {
                // Restated on the row so the reader can check the figure rather than trust it.
                const net = Number(a.collectionEvent.amountGross)
                  - Number(a.collectionEvent.amountTax)
                  - Number(a.collectionEvent.amountNonQualifying);
                return (
                  <div key={a.id} data-testid={`accrual-${a.id}`} className="bg-white rounded-2xl border border-border p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-bold text-charcoal">
                            {a.collectionEvent.customer?.name ?? (lang === "ar" ? "بدون عميل" : "No customer")}
                          </p>
                          <AccrualStatusBadge status={a.status} testId={`accrual-status-${a.id}`} />
                          {a.collectionEvent.sourceSystem === "SANDBOX" && (
                            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800">
                              {lang === "ar" ? "تجريبي" : "Sandbox"}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-brown/60 mt-1">
                          {t("commissionPlanLbl")}: {lang === "ar" && a.planVersion.plan.nameAr ? a.planVersion.plan.nameAr : a.planVersion.plan.name}
                          {" "}(v{a.planVersion.version}) · {t("commissionFrom")} {formatDate(a.collectionEvent.collectedAt)}
                        </p>
                      </div>
                      <span className="font-mono text-lg font-semibold tabular-nums text-charcoal">
                        {money(a.amount, a.currency)}
                      </span>
                    </div>

                    {/* The arithmetic, in the reader's own terms.
                        Collapsed by default so the page leads with amounts, period and status
                        rather than four rows of intermediate figures per accrual — but one
                        click away, never behind a different screen, because a commission
                        figure nobody can check is not an explanation. */}
                    <button
                      type="button"
                      onClick={() => setOpenCalc((s) => ({ ...s, [a.id]: !s[a.id] }))}
                      aria-expanded={!!openCalc[a.id]}
                      aria-controls={`calc-${a.id}`}
                      data-testid={`toggle-calc-${a.id}`}
                      className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-orange hover:underline"
                    >
                      {openCalc[a.id] ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                      {openCalc[a.id]
                        ? (lang === "ar" ? "إخفاء الحساب" : "Hide the calculation")
                        : (lang === "ar" ? "اعرض الحساب وتحقّق منه" : "Show the calculation")}
                    </button>
                    <div
                      id={`calc-${a.id}`}
                      hidden={!openCalc[a.id]}
                      className="mt-3 pt-3 border-t border-border grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2"
                    >
                      <div>
                        <span className="block text-[11px] text-brown/60">{lang === "ar" ? "المُحصَّل" : "Collected"}</span>
                        <span className="block text-xs font-bold tabular-nums">{money(a.collectionEvent.amountGross)}</span>
                      </div>
                      <div>
                        <span className="block text-[11px] text-brown/60">{lang === "ar" ? "منه ضريبة" : "of which tax"}</span>
                        <span className="block text-xs font-bold tabular-nums text-brown">−{money(a.collectionEvent.amountTax)}</span>
                      </div>
                      <div>
                        <span className="block text-[11px] text-brown/60">{t("commissionQualifying")}</span>
                        <span className="block text-xs font-bold tabular-nums text-emerald-800">
                          {money(String(net))}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[11px] text-brown/60">{t("commissionRate")}</span>
                        <span className="block text-xs font-bold tabular-nums">{pct(a.effectiveRatePercent)}</span>
                      </div>
                    </div>
                    {Number(a.sharePercent) < 100 && (
                      <p className="text-[11px] text-brown/60 mt-2" hidden={!openCalc[a.id]}>
                        {lang === "ar" ? "نسبة ملكيتك من هذه الصفقة" : "Your share of this deal"}:{" "}
                        <b className="tabular-nums">{Number(a.sharePercent).toFixed(2)}%</b>
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {data.ledger.length > 0 && (
            <div className="bg-white rounded-2xl border border-border p-4">
              <p className="text-[11px] font-bold text-brown/60 uppercase mb-2">
                {lang === "ar" ? "سجل الحركات" : "Ledger"}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {data.ledger.map((l) => (
                      <tr key={l.id} className="border-b border-border last:border-0">
                        <td className="py-2 pe-3 text-xs text-brown">{formatDate(l.createdAt)}</td>
                        <td className="py-2 pe-3 text-xs font-semibold">{label(LEDGER_LABELS, l.type)}</td>
                        <td className="py-2 pe-3 text-xs text-brown/70">{l.reason ?? "—"}</td>
                        <td className={`py-2 text-xs font-bold tabular-nums text-end ${Number(l.amount) < 0 ? "text-red-700" : "text-charcoal"}`}>
                          {money(l.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
