"use client";
// Predictive analytics — Direction 2.1 (UI batch 2; GX D-P01, Figma 1220:95595 at 1440, EN
// 1228:106661, 1024 1222:97614, phone 1228:101431).
//
// Visual port only: the same request (GET /api/dashboard/predictions) and the same figures —
// overdue (< 0 days), due within 30 days, customers tracked. The frame places the page as a tab of
// «الأداء والعمولات» (trail «المالية / الأداء والعمولات / التحليلات التنبؤية»); the registry lists it
// there (finance.performance), so the tabs are that section's pages as the shell resolves them for
// this viewer — the same row the other pages of the hub draw (with fewer than two, the page keeps
// its own title and no tab row). A failed load now says so, with a retry, instead of crashing the
// screen.
import { useCallback, useEffect, useState } from "react";
import { Empty, Flag, OpsError, OpsLoading, OpsRoot, countNoun, opsDate, useL } from "@/components/ops/ui";
import "@/components/ops/stock.css";
import { useD21Phone, useSectionPages } from "@/components/shell/page-context";
import { useI18n } from "@/lib/i18n/context";
import { LinkTabs } from "../_components/tools-ui";

type Prediction = {
  customerId: string; customerName: string; totalOrders: number;
  avgIntervalDays: number; avgQuantityKg: number; lastOrderDate: string;
  nextPredictedDate: string; daysUntilNext: number; topBeans: string[];
  confidence: number;
};

const DAY_FORMS: [string, string, string, string, string, string] = ["1 يوم", "يومان", "أيام", "يومًا", "day", "days"];
const CUSTOMER_FORMS: [string, string, string, string, string, string] = ["عميل واحد", "عميلان", "عملاء", "عميلًا", "customer", "customers"];

export default function AnalyticsPage() {
  const { t, lang } = useI18n();
  const L = useL();
  const ar = lang === "ar";
  // The hub's pages for this viewer (registry `finance.performance`), resolved by the shell.
  const section = useSectionPages();
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [computedAt, setComputedAt] = useState<Date | null>(null);

  const [reloadToken, setReloadToken] = useState(0);
  const load = useCallback(() => { setLoading(true); setError(null); setReloadToken((n) => n + 1); }, []);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/predictions")
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok || !Array.isArray(body)) throw new Error((body && typeof body.error === "string" && body.error) || `HTTP ${r.status}`);
        if (cancelled) return;
        setPredictions(body as Prediction[]);
        setComputedAt(new Date());
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  useD21Phone({ title: t("predictiveAnalytics"), sub: L("الأداء والعمولات", "Performance & commissions") });

  const upcomingOrders = predictions.filter((p) => p.daysUntilNext <= 30);
  const overdueOrders = predictions.filter((p) => p.daysUntilNext < 0);

  const tabs = section?.pages ?? [];
  const inSection = tabs.length >= 2;
  const days = (n: number) => countNoun(n, lang, DAY_FORMS);
  const time = computedAt ? computedAt.toLocaleTimeString(ar ? "ar-SA-u-nu-latn" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Riyadh" }) : null;

  const remaining = (p: Prediction) => {
    const n = p.daysUntilNext;
    if (n < 0) return <Flag tone="danger">{L(`متأخر ${days(-n)}`, `${days(-n)} overdue`)}</Flag>;
    if (n === 0) return <Flag tone="warning">{L("اليوم", "Today")}</Flag>;
    if (n <= 7) return <Flag tone="warning">{L(`خلال ${days(n)}`, `in ${days(n)}`)}</Flag>;
    return <span style={{ color: "var(--text-secondary)" }}>{L(`خلال ${days(n)}`, `in ${days(n)}`)}</span>;
  };
  const kgU = ar ? "كغ" : "kg";
  const dayU = ar ? "يوم" : "d";

  return (
    <OpsRoot className="tl-root">
      <div className="hr-page">
        {/* The header without the shell's Segmented control: the hub's pages are the tab row below. */}
        <div className="hr-pagehead"><h1 className="hr-title">{inSection ? L("الأداء والعمولات", "Performance & commissions") : t("predictiveAnalytics")}</h1></div>
        <p className="tl-sub">
          {L("موعد الطلب التالي لكل عميل من فواصل طلباته السابقة", "Each customer's next order date, from the gaps between past orders")}
          {time ? <><span className="tl-sep">•</span>{L(`محسوب اليوم ${time}`, `Computed today ${time}`)}</> : null}
        </p>
        {inSection ? (
          <div className="tl-hide-phone"><LinkTabs
            label={L("صفحات الأداء والعمولات", "Performance & commissions pages")}
            items={tabs.map((tab) => ({ href: tab.href, label: tab.text, current: tab.current }))}
          /></div>
        ) : null}

        {loading ? <OpsLoading /> : error ? (
          <OpsError message={error} onRetry={load} />
        ) : (
          <>
            <div className="stk-metrics tl-hide-phone" style={{ ["--stk-cols" as string]: 3 }} data-testid="analytics-metrics">
              <div>
                <span className="stk-lbl">{L("متأخر عن موعده", "Overdue")}</span>
                <span className="stk-mid">{overdueOrders.length}</span>
                <span className="stk-d">{L("عملاء تجاوزوا الموعد المتوقع", "customers past the expected date")}</span>
              </div>
              <div>
                <span className="stk-lbl">{L("متوقع خلال 30 يومًا", "Due within 30 days")}</span>
                <span className="stk-mid">{upcomingOrders.length}</span>
                <span className="stk-d">{L(`يشمل ${overdueOrders.length} متأخرين`, `includes ${overdueOrders.length} overdue`)}</span>
              </div>
              <div>
                <span className="stk-lbl">{L("عملاء متابَعون", "Customers tracked")}</span>
                <span className="stk-mid">{predictions.length}</span>
                <span className="stk-d">{L("لكل منهم طلبان على الأقل", "each with at least two orders")}</span>
              </div>
            </div>
            <p className="tl-only-phone tl-foot" style={{ display: "flex", gap: 14, fontSize: 13 }}>
              <span>{L("متأخر", "Overdue")} <strong className="hr-num" style={{ color: "var(--text-primary)" }}>{overdueOrders.length}</strong></span>
              <span>{L("خلال 30 يومًا", "In 30 days")} <strong className="hr-num" style={{ color: "var(--text-primary)" }}>{upcomingOrders.length}</strong></span>
              <span>{L("متابَع", "Tracked")} <strong className="hr-num" style={{ color: "var(--text-primary)" }}>{predictions.length}</strong></span>
            </p>

            {predictions.length === 0 ? (
              <Empty title={t("noAnalyticsData")} body={L("يظهر العميل هنا بعد طلبه الثاني: التوقع يحتاج فاصلًا واحدًا على الأقل.", "A customer appears here after their second order: a forecast needs at least one gap.")} />
            ) : (
              <>
                <div className="ops-sechead tl-hide-phone">
                  <h2>{t("customers")}</h2>
                  <p className="hr-caption">{L("مرتّبون بالأقرب موعدًا · المتأخر أولًا", "Soonest first · overdue first")}</p>
                </div>
                <div className="hr-tablewrap">
                  <table className="hr-table is-mrow" aria-label={t("customers")} data-testid="analytics-table">
                    <thead>
                      <tr>
                        <th>{t("customer")}</th>
                        <th className="num">{L("الطلبات", "Orders")}</th>
                        <th>{L("متوسط الفاصل", "Avg gap")}</th>
                        <th>{L("متوسط الكمية", "Avg quantity")}</th>
                        <th>{L("آخر طلب", "Last order")}</th>
                        <th>{L("الطلب المتوقع", "Expected order")}</th>
                        <th>{L("المتبقي", "Remaining")}</th>
                        <th className="hr-hide-compact">{L("الأصناف الأبرز", "Top coffees")}</th>
                        <th>{L("مؤشر الثقة", "Confidence")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {predictions.map((p) => (
                        <tr key={p.customerId}>
                          <td className="m-title">
                            <span className="strong" style={{ fontWeight: 600 }}>{p.customerName}</span>
                            <span className="hr-msub">
                              {L("المتوقع", "Expected")} {opsDate(p.nextPredictedDate, lang)} · {L(`كل ${p.avgIntervalDays} يوم`, `every ${p.avgIntervalDays} d`)}
                            </span>
                          </td>
                          <td className="num"><span className="hr-num">{p.totalOrders}</span></td>
                          <td><span className="hr-num">{p.avgIntervalDays}</span> {dayU}</td>
                          <td><span className="hr-num">{p.avgQuantityKg}</span> {kgU}</td>
                          <td>{opsDate(p.lastOrderDate, lang)}</td>
                          <td style={{ fontWeight: 600 }}>{opsDate(p.nextPredictedDate, lang)}</td>
                          <td className="m-end is-stack">
                            {remaining(p)}
                            <span className="hr-mobile-only hr-caption hr-num">{p.confidence}%</span>
                          </td>
                          <td className="hr-hide-compact">
                            <span className="tl-chips">
                              {p.topBeans.slice(0, 2).map((bean) => <span key={bean} className="tl-chip">{bean}</span>)}
                              {p.topBeans.length > 2 ? <span className="tl-more">+{p.topBeans.length - 2}</span> : null}
                            </span>
                          </td>
                          <td>
                            <span className="tl-conf">
                              <span className="hr-num">{p.confidence}%</span>
                              <span className="tl-track" role="img" aria-label={`${p.confidence}%`}><span style={{ width: `${p.confidence}%` }} /></span>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="tl-foot">
                  {countNoun(predictions.length, lang, CUSTOMER_FORMS)} · {L("الكميات بالكيلوغرام مقرّبة لعدد صحيح", "quantities in kilograms, rounded to a whole number")}
                </p>
              </>
            )}

            <div className="tl-note tl-hide-phone">
              <strong>{L("كيف يُحسب التوقع.", "How the forecast works.")}</strong>{" "}
              {L(
                "الموعد المتوقع = تاريخ آخر طلب + متوسط الأيام بين طلبات العميل. مؤشر الثقة ليس ضمانًا: يعتمد على عدد الطلبات فقط — طلبان 30%، ثلاثة 45%، وتصل إلى 95% من سبعة طلبات — ولا تقيس انتظام الفواصل. العميل بطلب واحد لا يظهر لأن التوقع يحتاج فاصلًا واحدًا على الأقل.",
                "Expected date = last order date + the average days between the customer's orders. Confidence is not a guarantee: it depends on the number of orders only — two orders 30%, three 45%, up to 95% from seven — and does not measure how regular the gaps are. A customer with one order does not appear, because a forecast needs at least one gap.",
              )}
            </div>
            <div className="tl-note tone-warning tl-hide-phone">
              <strong>{L("حدود البيانات الحالية.", "Limits of the current data.")}</strong>{" "}
              {L(
                "يُحسب من أقدم 20 طلبًا لكل عميل ولحدّ 100 عميل، وتُحتسب الطلبات الملغاة والمرفوضة. قد يتأخر «آخر طلب» عن الواقع لعميل له أكثر من 20 طلبًا. تعديل ذلك قرار في الخادم، لا في الواجهة.",
                "Computed from each customer's oldest 20 orders, for up to 100 customers, and cancelled or rejected orders count. «Last order» can lag behind for a customer with more than 20 orders. Changing that is a server decision, not an interface one.",
              )}
            </div>
          </>
        )}
      </div>
    </OpsRoot>
  );
}
