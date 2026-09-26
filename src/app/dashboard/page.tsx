"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Factory, TrendingDown, CheckCircle2, Package,
  RefreshCw, AlertTriangle, Clock, Layers,
  ArrowUp, ArrowDown, Minus, BarChart2,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import { useI18n } from "@/lib/i18n/context";

// ─── Types ────────────────────────────────────────────────────────────────────

type InventoryAlert = {
  id: string; beanType: string; beanTypeAr: string | null;
  country: string; countryAr: string | null; quantityKg: number;
};

type ActiveOrder = {
  id: string; orderNumber: number;
  customer: { name: string; nameAr: string | null };
  items: { productionStatus: string; deliveryStatus: string; quantityKg: number; beanTypeName: string }[];
};

type QcAlert = {
  id: string; batchNumber: string; origin: string;
  testerCount: number; deadline: string | null; isOverdue: boolean; isUrgent: boolean;
};

type WeekPoint = { label: string; roastedKg: number; greenKg: number };

type AnalyticsData = {
  kpi: {
    currentMonthKg: number; prevMonthKg: number; productionTrend: number | null; batchCount: number;
    avgLossPct: number | null;
    qcPassRate: number | null; qcPassCount: number; qcTotalCount: number;
    rawMaterialKg: number; finishedGoodsKg: number;
  };
  weeklyProduction: WeekPoint[];
  qcBreakdown: { decision: string; count: number }[];
  pipeline: { pending: number; inProduction: number; readyToDispatch: number };
  inventoryAlerts: InventoryAlert[];
  recentActiveOrders: ActiveOrder[];
  qcBatchAlerts: QcAlert[];
};

// ─── Brand colors (for Recharts — must use hex) ───────────────────────────────

// Chart colours. Recharts takes literals rather than CSS custom properties, so these
// mirror the design tokens by value and must be kept in step with them. The old names
// described a palette this console no longer uses — "orange" was a violet, "brown" a
// mid grey — so they are named for their role here instead.
const C_PRIMARY = "#4f46e5"; // --oo-action-primary  · the measured series
const C_MUTED   = "#d4d4d8"; // --oo-border-strong   · the comparison series
const C_GOOD    = "#16a34a"; // --oo-status-success
const C_WARN    = "#d97706"; // --oo-status-waiting
const C_BAD     = "#dc2626"; // --oo-status-blocked
const C_TRACK   = "#f4f4f5"; // --oo-bg-subtle       · meter track

// ─── Custom bar tooltip ───────────────────────────────────────────────────────

function BarTooltip({
  active, payload, label,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-oo-border-default rounded-oo-medium px-3 py-2 shadow-lg text-xs">
      <p className="font-bold text-oo-text-primary mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }} className="font-medium">
          {p.name}: {p.value} كغ
        </p>
      ))}
    </div>
  );
}

// ─── KPI card ─────────────────────────────────────────────────────────────────

/**
 * One measured figure.
 *
 * The label leads with a muted icon and the reading edge; the figure is the largest thing
 * in the card; the movement against last month, where the API supplies one, sits on the
 * far side so a row of cards can be scanned for change alone. `tone` colours the figure
 * itself, which is what carries the state — the previous card put a saturated square of
 * colour in the corner and left the number black, so the eye landed on decoration rather
 * than on the measurement.
 */
function KpiCard({
  icon: Icon, label, value, unit, sub, trend, trendLabel, tone = "text-oo-text-primary", children,
}: {
  icon: React.ElementType;
  label: string; value: string | number; unit?: string;
  sub?: string; trend?: number | null; trendLabel?: string;
  tone?: string;
  children?: React.ReactNode;
}) {
  const up = (trend ?? 0) > 0;
  const down = (trend ?? 0) < 0;
  return (
    <div className="bg-oo-bg-default rounded-oo-large p-4 border border-oo-border-default flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Icon size={15} className="text-oo-text-muted shrink-0" aria-hidden="true" />
        <span className="text-[11.5px] font-semibold text-oo-text-secondary">{label}</span>
        <span className="flex-1" />
        {trend !== undefined && trend !== null && (
          <span
            className={`flex items-center gap-0.5 text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums ${
              up ? "bg-oo-status-success-bg text-oo-status-success"
                 : down ? "bg-oo-status-blocked-bg text-oo-status-blocked"
                        : "bg-oo-bg-subtle text-oo-text-muted"
            }`}
          >
            {up ? <ArrowUp size={10} /> : down ? <ArrowDown size={10} /> : <Minus size={10} />}
            {Math.abs(trend)}%
          </span>
        )}
      </div>

      <p className={`flex items-baseline gap-1 leading-none ${tone}`}>
        <span className="text-[28px] font-bold tabular-nums">{value}</span>
        {unit && <span className="text-[12px] font-medium text-oo-text-muted">{unit}</span>}
      </p>

      {sub && <p className="text-[10.5px] text-oo-text-muted">{sub}</p>}
      {trendLabel && trend !== null && trend !== undefined && (
        <p className="text-[10.5px] text-oo-text-muted">{trendLabel}</p>
      )}
      {children}
    </div>
  );
}

/** A thin band under a figure. Never the only carrier of its state — the text says it too. */
function Meter({ pct, colorVar }: { pct: number; colorVar: string }) {
  return (
    <div className="w-full bg-oo-bg-subtle rounded-full h-1.5 overflow-hidden">
      <div
        className="h-1.5 rounded-full transition-all duration-500"
        style={{ width: `${Math.max(0, Math.min(pct, 100))}%`, backgroundColor: colorVar }}
      />
    </div>
  );
}

// ─── Pipeline pill ────────────────────────────────────────────────────────────

function PipelinePill({ count, label, cls }: { count: number; label: string; cls: string }) {
  return (
    <div className={`flex-1 flex flex-col items-center gap-1 py-4 rounded-oo-medium border ${cls}`}>
      <span className="text-[26px] font-bold tabular-nums leading-none">{count}</span>
      <span className="text-[11.5px] font-semibold text-center leading-tight px-2">{label}</span>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { t, lang } = useI18n();

  const [data,        setData]        = useState<AnalyticsData | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [mounted,     setMounted]     = useState(false); // defer Recharts until client

  useEffect(() => { setMounted(true); }, []);

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const res = await fetch("/api/analytics");
      if (res.ok) {
        setData(await res.json());
        setLastUpdated(new Date());
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function disp(en: string | null | undefined, ar: string | null | undefined) {
    return lang === "ar" && ar ? ar : (en ?? "—");
  }

  function statusColor(s: string) {
    if (s === "Pending")       return "bg-amber-100 text-amber-700";
    if (s === "In Production") return "bg-oo-action-primary/10 text-oo-action-primary";
    if (s === "Completed")     return "bg-green-100 text-green-700";
    return "bg-oo-bg-subtle text-oo-text-secondary";
  }

  function statusLabel(s: string) {
    if (s === "Pending")       return t("pending");
    if (s === "In Production") return t("statusInProd");
    return t("statusCompleted");
  }

  const kpi          = data?.kpi;
  const hasChartData = (data?.weeklyProduction?.length ?? 0) > 0;
  const hasQcData    = (kpi?.qcTotalCount ?? 0) > 0;

  const lossColor =
    !kpi?.avgLossPct ? "text-oo-text-primary" :
    kpi.avgLossPct > 20 ? "text-red-600" :
    kpi.avgLossPct > 14 ? "text-amber-600" : "text-green-600";

  const qcColor =
    !kpi?.qcPassRate ? "text-oo-text-primary" :
    kpi.qcPassRate >= 90 ? "text-green-600" :
    kpi.qcPassRate >= 70 ? "text-amber-600" : "text-red-500";

  const donutData = [
    { name: t("passLabel"), value: kpi?.qcPassCount ?? 0,                              color: C_GOOD },
    { name: t("failLabel"), value: (kpi?.qcTotalCount ?? 0) - (kpi?.qcPassCount ?? 0), color: C_BAD  },
  ].filter((d) => d.value > 0);

  if (!loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <Package size={40} className="text-oo-text-muted mb-3" />
        <p className="text-lg font-bold text-oo-text-primary">{t("noDashboardAccess")}</p>
        <p className="text-sm text-oo-text-secondary mt-1">{t("useSidebar")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-oo-text-primary">{t("execDashTitle")}</h1>
          <p className="text-oo-text-secondary text-sm font-medium">{t("execDashSubtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <p className="text-xs text-oo-text-muted hidden sm:block">
              {t("lastUpdated")}: {lastUpdated.toLocaleTimeString(lang === "ar" ? "ar-SA" : "en-US", { timeStyle: "short" })}
            </p>
          )}
          <button
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2 bg-white border-2 border-oo-border-default rounded-oo-medium text-sm font-bold text-oo-text-secondary hover:border-oo-action-primary hover:text-oo-action-primary transition-all disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            {t("refreshData")}
          </button>
        </div>
      </div>

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">

        {/* Production This Month */}
        <KpiCard
          icon={Factory}
          label={t("productionThisMonth")}
          tone="text-oo-action-primary"
          value={loading ? "—" : (kpi?.currentMonthKg.toFixed(1) ?? "0")}
          unit={t("kgUnit")}
          sub={loading ? "" : `${kpi?.batchCount ?? 0} ${t("batchesCount")}`}
          trend={kpi?.productionTrend}
          trendLabel={t("vsLastMonth")}
        />

        {/* Avg Roast Loss */}
        <KpiCard
          icon={TrendingDown}
          label={t("avgRoastLoss")}
          tone="text-oo-status-waiting"
          value={loading ? "—" : (kpi?.avgLossPct != null ? kpi.avgLossPct.toFixed(1) : "—")}
          unit={kpi?.avgLossPct != null ? "%" : ""}
          sub={t("last30Days")}
        >
          {!loading && kpi?.avgLossPct != null && (
            <div className="mt-auto space-y-1.5">
              <Meter
                pct={kpi.avgLossPct * 3.5}
                colorVar={kpi.avgLossPct > 20 ? C_BAD : kpi.avgLossPct > 14 ? C_WARN : C_GOOD}
              />
              <p className={`text-[10.5px] font-semibold ${lossColor}`}>
                {kpi.avgLossPct <= 14 ? "ضمن الحد المقبول" : kpi.avgLossPct <= 20 ? "مرتفع قليلاً" : "مرتفع — مراجعة مطلوبة"}
              </p>
            </div>
          )}
        </KpiCard>

        {/* QC Pass Rate */}
        <KpiCard
          icon={CheckCircle2}
          label={t("qcPassRateLabel")}
          tone="text-oo-status-success"
          value={loading ? "—" : (kpi?.qcPassRate != null ? kpi.qcPassRate.toFixed(0) : "—")}
          unit={kpi?.qcPassRate != null ? "%" : ""}
          sub={loading ? "" : `${kpi?.qcPassCount ?? 0} / ${kpi?.qcTotalCount ?? 0} ${t("qcRecordsCount")}`}
        >
          {!loading && kpi?.qcPassRate != null && (
            <div className="mt-auto space-y-1.5">
              <Meter
                pct={kpi.qcPassRate}
                colorVar={kpi.qcPassRate >= 90 ? C_GOOD : kpi.qcPassRate >= 70 ? C_WARN : C_BAD}
              />
              <p className={`text-[10.5px] font-semibold ${qcColor}`}>
                {kpi.qcPassRate >= 90 ? "ممتاز" : kpi.qcPassRate >= 70 ? "مقبول" : "يحتاج تحسين"}
              </p>
            </div>
          )}
        </KpiCard>

        {/* Inventory Weight */}
        <KpiCard
          icon={Layers}
          label={t("inventoryWeightLabel")}
          value={loading ? "—" : ((kpi?.rawMaterialKg ?? 0) + (kpi?.finishedGoodsKg ?? 0)).toFixed(1)}
          unit={t("kgUnit")}
        >
          {!loading && kpi && (
            <div className="mt-auto space-y-2">
              <div className="flex justify-between text-[11px]">
                <span className="text-oo-text-secondary">{t("rawLabel")}</span>
                <span className="font-semibold text-oo-text-primary tabular-nums">{kpi.rawMaterialKg.toFixed(1)} {t("kgUnit")}</span>
              </div>
              <Meter
                pct={kpi.rawMaterialKg + kpi.finishedGoodsKg > 0
                  ? (kpi.rawMaterialKg / (kpi.rawMaterialKg + kpi.finishedGoodsKg)) * 100
                  : 0}
                colorVar={C_MUTED}
              />
              <div className="flex justify-between text-[11px]">
                <span className="text-oo-text-secondary">{t("finishedLabel")}</span>
                <span className="font-semibold text-oo-status-success tabular-nums">{kpi.finishedGoodsKg.toFixed(1)} {t("kgUnit")}</span>
              </div>
            </div>
          )}
        </KpiCard>
      </div>

      {/* ── Charts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Bar chart — weekly production */}
        <div className="lg:col-span-2 bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="font-bold text-oo-text-primary">{t("weeklyProdChart")}</h3>
              <p className="text-xs text-oo-text-muted mt-0.5">
                {t("greenInput")} vs {t("roastedInput")}
              </p>
            </div>
            <BarChart2 size={18} className="text-oo-text-muted" />
          </div>

          {loading ? (
            <div className="h-52 bg-oo-bg-subtle/60 rounded-oo-medium animate-pulse" />
          ) : !hasChartData ? (
            <div className="h-52 flex flex-col items-center justify-center text-oo-text-muted">
              <BarChart2 size={36} className="mb-2" />
              <p className="text-sm">{t("noChartData")}</p>
            </div>
          ) : mounted ? (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data!.weeklyProduction} barGap={2} barSize={12} margin={{ left: -10, right: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C_TRACK} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: C_MUTED }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: C_MUTED }} axisLine={false} tickLine={false} width={36} />
                  <Tooltip content={<BarTooltip />} cursor={{ fill: C_TRACK }} />
                  <Bar dataKey="greenKg"   name={t("greenInput")}   fill={C_MUTED}  radius={[4, 4, 0, 0]} opacity={0.55} />
                  <Bar dataKey="roastedKg" name={t("roastedInput")} fill={C_PRIMARY} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-5 justify-center mt-2">
                <span className="flex items-center gap-1.5 text-xs text-oo-text-secondary/70">
                  <span className="w-3 h-3 rounded-sm inline-block opacity-55" style={{ backgroundColor: C_MUTED }} />
                  {t("greenInput")}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-oo-text-secondary/70">
                  <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: C_PRIMARY }} />
                  {t("roastedInput")}
                </span>
              </div>
            </>
          ) : (
            <div className="h-52 bg-oo-bg-subtle/30 rounded-oo-medium" />
          )}
        </div>

        {/* Donut — QC breakdown */}
        <div className="bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5 flex flex-col">
          <div className="flex items-center justify-between mb-5">
            <h3 className="font-bold text-oo-text-primary">{t("qcBreakdownChart")}</h3>
            <CheckCircle2 size={18} className="text-oo-text-muted" />
          </div>

          {loading ? (
            <div className="flex-1 min-h-[180px] bg-oo-bg-subtle/60 rounded-oo-medium animate-pulse" />
          ) : !hasQcData ? (
            <div className="flex-1 min-h-[180px] flex flex-col items-center justify-center text-oo-text-muted">
              <CheckCircle2 size={36} className="mb-2" />
              <p className="text-sm text-center">{t("noChartData")}</p>
            </div>
          ) : mounted ? (
            <>
              <div className="relative">
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={donutData}
                      cx="50%" cy="50%"
                      innerRadius={50} outerRadius={76}
                      paddingAngle={donutData.length > 1 ? 3 : 0}
                      dataKey="value"
                      strokeWidth={0}
                    >
                      {donutData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(val, name) => [`${val} ${t("qcRecordsCount")}`, name]}
                      contentStyle={{ borderRadius: "12px", border: "1px solid #e5e7eb", fontSize: 12 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                {/* Center label overlay */}
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <p className={`text-2xl font-bold ${qcColor}`}>
                    {kpi?.qcPassRate?.toFixed(0)}%
                  </p>
                  <p className="text-[10px] text-oo-text-muted font-semibold">{t("passLabel")}</p>
                </div>
              </div>
              <div className="flex justify-center gap-5 mt-3">
                {donutData.map((d) => (
                  <div key={d.name} className="flex items-center gap-1.5 text-xs text-oo-text-secondary/70">
                    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: d.color }} />
                    <span className="font-medium">{d.name}</span>
                    <span className="font-bold text-oo-text-primary">{d.value}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex-1 min-h-[180px] bg-oo-bg-subtle/30 rounded-oo-medium" />
          )}
        </div>
      </div>

      {/* ── Pipeline strip ── */}
      {data?.pipeline && (
        <div className="bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5">
          <h3 className="font-bold text-oo-text-primary mb-4">{t("pipelineTitle")}</h3>
          <div className="flex gap-3">
            <PipelinePill count={data.pipeline.pending}         label={t("pendingProd")}   cls="bg-amber-50 text-amber-800 border-amber-200" />
            <PipelinePill count={data.pipeline.inProduction}    label={t("statusInProd")}  cls="bg-oo-action-primary/8 text-oo-action-primary border-oo-action-primary/20" />
            <PipelinePill count={data.pipeline.readyToDispatch} label={t("readyDispatch")} cls="bg-green-50 text-green-800 border-green-200" />
          </div>
        </div>
      )}

      {/* ── Bottom: Active orders + alerts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Active Orders */}
        <div className="bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5">
          <h3 className="font-bold text-oo-text-primary mb-4">{t("activeOrdersTitle")}</h3>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <div key={i} className="h-14 bg-oo-bg-subtle/60 animate-pulse rounded-oo-medium" />)}
            </div>
          ) : !data?.recentActiveOrders.length ? (
            <div className="flex flex-col items-center py-8 text-center">
              <CheckCircle2 size={28} className="text-green-400 mb-2" />
              <p className="text-sm font-semibold text-oo-text-secondary">{t("noActiveOrders")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {data.recentActiveOrders.map((order) => {
                const totalKg  = order.items.reduce((s, i) => s + i.quantityKg, 0);
                const counts   = order.items.reduce<Record<string, number>>((acc, i) => {
                  acc[i.productionStatus] = (acc[i.productionStatus] ?? 0) + 1; return acc;
                }, {});
                const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Pending";
                return (
                  <div key={order.id} className="flex items-center justify-between p-3 bg-oo-bg-subtle/50 rounded-oo-medium border border-oo-border-default">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-oo-text-primary truncate">
                        #{order.orderNumber} — {disp(order.customer.name, order.customer.nameAr)}
                      </p>
                      <p className="text-xs text-oo-text-muted font-medium">
                        {totalKg} {t("kgUnit")} · {order.items.length} {t("itemsTotal")}
                      </p>
                    </div>
                    <span className={`shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg ltr:ml-2 rtl:mr-2 ${statusColor(dominant)}`}>
                      {statusLabel(dominant)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right column: low stock + QC alerts */}
        <div className="space-y-4">

          {/* Low stock alerts */}
          {(data?.inventoryAlerts?.length ?? 0) > 0 && (
            <div className="bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle size={16} className="text-amber-500" />
                <h3 className="font-bold text-oo-text-primary">{t("inventoryAlertsTitle")}</h3>
                <span className="ltr:ml-auto rtl:mr-auto text-xs font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                  {data!.inventoryAlerts.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {data!.inventoryAlerts.slice(0, 5).map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-sm px-3 py-2 bg-amber-50/50 rounded-oo-medium">
                    <span className="font-medium truncate">{disp(a.beanType, a.beanTypeAr)}</span>
                    <span className={`font-bold font-mono shrink-0 ltr:ml-2 rtl:mr-2 ${a.quantityKg < 20 ? "text-red-600" : "text-amber-600"}`}>
                      {a.quantityKg.toFixed(1)} {t("kgUnit")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* QC batch alerts */}
          {(data?.qcBatchAlerts?.length ?? 0) > 0 && (
            <div className="bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5">
              <div className="flex items-center gap-2 mb-3">
                <Clock size={16} className="text-oo-action-primary" />
                <h3 className="font-bold text-oo-text-primary">{t("openQcBatches")}</h3>
                <span className="ltr:ml-auto rtl:mr-auto text-xs font-bold bg-oo-action-primary/10 text-oo-action-primary px-2 py-0.5 rounded-full">
                  {data!.qcBatchAlerts.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {data!.qcBatchAlerts.slice(0, 5).map((b) => (
                  <div key={b.id} className={`flex items-center justify-between text-sm px-3 py-2 rounded-oo-medium border ${
                    b.isOverdue ? "bg-red-50 border-red-200" : b.isUrgent ? "bg-amber-50 border-amber-200" : "bg-oo-bg-subtle/50 border-oo-border-default"
                  }`}>
                    <div className="min-w-0">
                      <p className="font-bold text-oo-text-primary font-mono">{b.batchNumber}</p>
                      <p className="text-xs text-oo-text-muted">
                        {b.origin} · {b.testerCount} {b.testerCount !== 1 ? t("testers") : t("tester")}
                      </p>
                    </div>
                    <span className={`shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg ltr:ml-2 rtl:mr-2 ${
                      b.isOverdue ? "bg-red-100 text-red-700" : b.isUrgent ? "bg-amber-100 text-amber-700" : "bg-oo-bg-subtle text-oo-text-secondary"
                    }`}>
                      {b.isOverdue ? t("overdue") : b.isUrgent ? t("dueSoon") : t("pending")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
