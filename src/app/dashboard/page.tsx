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

const C_ORANGE   = "#E25D2F";
const C_BROWN    = "#9F5F46";
const C_GREEN    = "#22c55e";
const C_RED      = "#ef4444";
const C_CREAM    = "#F8E8DC";

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
    <div className="bg-white border border-border rounded-xl px-3 py-2 shadow-lg text-xs">
      <p className="font-bold text-charcoal mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }} className="font-medium">
          {p.name}: {p.value} كغ
        </p>
      ))}
    </div>
  );
}

// ─── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon, iconBg, label, value, unit, sub, trend, trendLabel, children,
}: {
  icon: React.ElementType; iconBg: string;
  label: string; value: string | number; unit?: string;
  sub?: string; trend?: number | null; trendLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl p-5 border border-border hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300 group flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div className={`w-10 h-10 ${iconBg} rounded-xl flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform shrink-0`}>
          <Icon size={18} className="text-white" />
        </div>
        {trend !== undefined && trend !== null && (
          <div className={`flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full ${
            trend > 0 ? "bg-green-100 text-green-700" : trend < 0 ? "bg-red-100 text-red-600" : "bg-gray-100 text-gray-500"
          }`}>
            {trend > 0 ? <ArrowUp size={11} /> : trend < 0 ? <ArrowDown size={11} /> : <Minus size={11} />}
            {Math.abs(trend)}%
          </div>
        )}
      </div>
      <div>
        <p className="text-3xl font-extrabold text-charcoal leading-none tabular-nums">
          {value}
          {unit && <span className="text-sm font-semibold text-brown/50 ltr:ml-1 rtl:mr-1">{unit}</span>}
        </p>
        <p className="text-xs font-bold text-brown/60 mt-1.5 uppercase tracking-wide">{label}</p>
        {sub && <p className="text-[11px] text-brown/40 mt-0.5">{sub}</p>}
        {trendLabel && trend !== null && trend !== undefined && (
          <p className={`text-[11px] mt-0.5 font-medium ${trend > 0 ? "text-green-600" : trend < 0 ? "text-red-500" : "text-brown/40"}`}>
            {trendLabel}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── Pipeline pill ────────────────────────────────────────────────────────────

function PipelinePill({ count, label, cls }: { count: number; label: string; cls: string }) {
  return (
    <div className={`flex-1 flex flex-col items-center gap-1 py-4 rounded-xl border ${cls}`}>
      <span className="text-2xl font-extrabold tabular-nums">{count}</span>
      <span className="text-xs font-semibold text-center leading-tight px-2">{label}</span>
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
    if (s === "In Production") return "bg-orange/10 text-orange";
    if (s === "Completed")     return "bg-green-100 text-green-700";
    return "bg-cream text-brown";
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
    !kpi?.avgLossPct ? "text-charcoal" :
    kpi.avgLossPct > 20 ? "text-red-600" :
    kpi.avgLossPct > 14 ? "text-amber-600" : "text-green-600";

  const qcColor =
    !kpi?.qcPassRate ? "text-charcoal" :
    kpi.qcPassRate >= 90 ? "text-green-600" :
    kpi.qcPassRate >= 70 ? "text-amber-600" : "text-red-500";

  const donutData = [
    { name: t("passLabel"), value: kpi?.qcPassCount ?? 0,                              color: C_GREEN },
    { name: t("failLabel"), value: (kpi?.qcTotalCount ?? 0) - (kpi?.qcPassCount ?? 0), color: C_RED  },
  ].filter((d) => d.value > 0);

  if (!loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <Package size={40} className="text-brown/30 mb-3" />
        <p className="text-lg font-bold text-charcoal">{t("noDashboardAccess")}</p>
        <p className="text-sm text-brown/60 mt-1">{t("useSidebar")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("execDashTitle")}</h1>
          <p className="text-brown text-sm font-medium">{t("execDashSubtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <p className="text-xs text-brown/50 hidden sm:block">
              {t("lastUpdated")}: {lastUpdated.toLocaleTimeString(lang === "ar" ? "ar-SA" : "en-US", { timeStyle: "short" })}
            </p>
          )}
          <button
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2 bg-white border-2 border-border rounded-xl text-sm font-bold text-brown hover:border-orange hover:text-orange transition-all disabled:opacity-50"
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
          icon={Factory} iconBg="bg-orange"
          label={t("productionThisMonth")}
          value={loading ? "—" : (kpi?.currentMonthKg.toFixed(1) ?? "0")}
          unit={t("kgUnit")}
          sub={loading ? "" : `${kpi?.batchCount ?? 0} ${t("batchesCount")}`}
          trend={kpi?.productionTrend}
          trendLabel={t("vsLastMonth")}
        />

        {/* Avg Roast Loss */}
        <KpiCard
          icon={TrendingDown} iconBg="bg-brown"
          label={t("avgRoastLoss")}
          value={loading ? "—" : (kpi?.avgLossPct != null ? kpi.avgLossPct.toFixed(1) : "—")}
          unit={kpi?.avgLossPct != null ? "%" : ""}
          sub={t("last30Days")}
        >
          {!loading && kpi?.avgLossPct != null && (
            <div className="mt-auto space-y-1">
              <div className="w-full bg-cream rounded-full h-1.5 overflow-hidden">
                <div
                  className="h-1.5 rounded-full transition-all duration-700"
                  style={{
                    width: `${Math.min(kpi.avgLossPct * 3.5, 100)}%`,
                    backgroundColor: kpi.avgLossPct > 20 ? C_RED : kpi.avgLossPct > 14 ? "#f59e0b" : C_GREEN,
                  }}
                />
              </div>
              <p className={`text-[11px] font-bold ${lossColor}`}>
                {kpi.avgLossPct <= 14 ? "ضمن الحد المقبول" : kpi.avgLossPct <= 20 ? "مرتفع قليلاً" : "مرتفع — مراجعة مطلوبة"}
              </p>
            </div>
          )}
        </KpiCard>

        {/* QC Pass Rate */}
        <KpiCard
          icon={CheckCircle2} iconBg="bg-green-600"
          label={t("qcPassRateLabel")}
          value={loading ? "—" : (kpi?.qcPassRate != null ? kpi.qcPassRate.toFixed(0) : "—")}
          unit={kpi?.qcPassRate != null ? "%" : ""}
          sub={loading ? "" : `${kpi?.qcPassCount ?? 0} / ${kpi?.qcTotalCount ?? 0} ${t("qcRecordsCount")}`}
        >
          {!loading && kpi?.qcPassRate != null && (
            <div className="mt-auto space-y-1">
              <div className="w-full bg-cream rounded-full h-1.5 overflow-hidden">
                <div
                  className="h-1.5 rounded-full transition-all duration-700"
                  style={{
                    width: `${kpi.qcPassRate}%`,
                    backgroundColor: kpi.qcPassRate >= 90 ? C_GREEN : kpi.qcPassRate >= 70 ? "#f59e0b" : C_RED,
                  }}
                />
              </div>
              <p className={`text-[11px] font-bold ${qcColor}`}>
                {kpi.qcPassRate >= 90 ? "ممتاز" : kpi.qcPassRate >= 70 ? "مقبول" : "يحتاج تحسين"}
              </p>
            </div>
          )}
        </KpiCard>

        {/* Inventory Weight */}
        <KpiCard
          icon={Layers} iconBg="bg-charcoal"
          label={t("inventoryWeightLabel")}
          value={loading ? "—" : ((kpi?.rawMaterialKg ?? 0) + (kpi?.finishedGoodsKg ?? 0)).toFixed(1)}
          unit={t("kgUnit")}
        >
          {!loading && kpi && (
            <div className="mt-auto space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-brown/60 font-medium">{t("rawLabel")}</span>
                <span className="font-bold text-charcoal font-mono">{kpi.rawMaterialKg.toFixed(1)} {t("kgUnit")}</span>
              </div>
              <div className="w-full bg-cream rounded-full h-1.5 overflow-hidden">
                {kpi.rawMaterialKg + kpi.finishedGoodsKg > 0 && (
                  <div
                    className="h-1.5 rounded-full bg-brown transition-all duration-700"
                    style={{ width: `${(kpi.rawMaterialKg / (kpi.rawMaterialKg + kpi.finishedGoodsKg)) * 100}%` }}
                  />
                )}
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-brown/60 font-medium">{t("finishedLabel")}</span>
                <span className="font-bold text-green-600 font-mono">{kpi.finishedGoodsKg.toFixed(1)} {t("kgUnit")}</span>
              </div>
            </div>
          )}
        </KpiCard>
      </div>

      {/* ── Charts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Bar chart — weekly production */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-border p-5">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="font-extrabold text-charcoal">{t("weeklyProdChart")}</h3>
              <p className="text-xs text-brown/50 mt-0.5">
                {t("greenInput")} vs {t("roastedInput")}
              </p>
            </div>
            <BarChart2 size={18} className="text-brown/30" />
          </div>

          {loading ? (
            <div className="h-52 bg-cream/60 rounded-xl animate-pulse" />
          ) : !hasChartData ? (
            <div className="h-52 flex flex-col items-center justify-center text-brown/40">
              <BarChart2 size={36} className="mb-2" />
              <p className="text-sm">{t("noChartData")}</p>
            </div>
          ) : mounted ? (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data!.weeklyProduction} barGap={2} barSize={12} margin={{ left: -10, right: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C_CREAM} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: C_BROWN }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: C_BROWN }} axisLine={false} tickLine={false} width={36} />
                  <Tooltip content={<BarTooltip />} cursor={{ fill: C_CREAM }} />
                  <Bar dataKey="greenKg"   name={t("greenInput")}   fill={C_BROWN}  radius={[4, 4, 0, 0]} opacity={0.55} />
                  <Bar dataKey="roastedKg" name={t("roastedInput")} fill={C_ORANGE} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-5 justify-center mt-2">
                <span className="flex items-center gap-1.5 text-xs text-brown/70">
                  <span className="w-3 h-3 rounded-sm inline-block opacity-55" style={{ backgroundColor: C_BROWN }} />
                  {t("greenInput")}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-brown/70">
                  <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: C_ORANGE }} />
                  {t("roastedInput")}
                </span>
              </div>
            </>
          ) : (
            <div className="h-52 bg-cream/30 rounded-xl" />
          )}
        </div>

        {/* Donut — QC breakdown */}
        <div className="bg-white rounded-2xl border border-border p-5 flex flex-col">
          <div className="flex items-center justify-between mb-5">
            <h3 className="font-extrabold text-charcoal">{t("qcBreakdownChart")}</h3>
            <CheckCircle2 size={18} className="text-brown/30" />
          </div>

          {loading ? (
            <div className="flex-1 min-h-[180px] bg-cream/60 rounded-xl animate-pulse" />
          ) : !hasQcData ? (
            <div className="flex-1 min-h-[180px] flex flex-col items-center justify-center text-brown/40">
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
                  <p className={`text-2xl font-extrabold ${qcColor}`}>
                    {kpi?.qcPassRate?.toFixed(0)}%
                  </p>
                  <p className="text-[10px] text-brown/50 font-semibold">{t("passLabel")}</p>
                </div>
              </div>
              <div className="flex justify-center gap-5 mt-3">
                {donutData.map((d) => (
                  <div key={d.name} className="flex items-center gap-1.5 text-xs text-brown/70">
                    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: d.color }} />
                    <span className="font-medium">{d.name}</span>
                    <span className="font-bold text-charcoal">{d.value}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex-1 min-h-[180px] bg-cream/30 rounded-xl" />
          )}
        </div>
      </div>

      {/* ── Pipeline strip ── */}
      {data?.pipeline && (
        <div className="bg-white rounded-2xl border border-border p-5">
          <h3 className="font-extrabold text-charcoal mb-4">{t("pipelineTitle")}</h3>
          <div className="flex gap-3">
            <PipelinePill count={data.pipeline.pending}         label={t("pendingProd")}   cls="bg-amber-50 text-amber-800 border-amber-200" />
            <PipelinePill count={data.pipeline.inProduction}    label={t("statusInProd")}  cls="bg-orange/8 text-orange border-orange/20" />
            <PipelinePill count={data.pipeline.readyToDispatch} label={t("readyDispatch")} cls="bg-green-50 text-green-800 border-green-200" />
          </div>
        </div>
      )}

      {/* ── Bottom: Active orders + alerts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Active Orders */}
        <div className="bg-white rounded-2xl border border-border p-5">
          <h3 className="font-extrabold text-charcoal mb-4">{t("activeOrdersTitle")}</h3>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <div key={i} className="h-14 bg-cream/60 animate-pulse rounded-xl" />)}
            </div>
          ) : !data?.recentActiveOrders.length ? (
            <div className="flex flex-col items-center py-8 text-center">
              <CheckCircle2 size={28} className="text-green-400 mb-2" />
              <p className="text-sm font-semibold text-brown/60">{t("noActiveOrders")}</p>
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
                  <div key={order.id} className="flex items-center justify-between p-3 bg-cream/50 rounded-xl border border-border">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-charcoal truncate">
                        #{order.orderNumber} — {disp(order.customer.name, order.customer.nameAr)}
                      </p>
                      <p className="text-xs text-brown/50 font-medium">
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
            <div className="bg-white rounded-2xl border border-border p-5">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle size={16} className="text-amber-500" />
                <h3 className="font-extrabold text-charcoal">{t("inventoryAlertsTitle")}</h3>
                <span className="ltr:ml-auto rtl:mr-auto text-xs font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                  {data!.inventoryAlerts.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {data!.inventoryAlerts.slice(0, 5).map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-sm px-3 py-2 bg-amber-50/50 rounded-xl">
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
            <div className="bg-white rounded-2xl border border-border p-5">
              <div className="flex items-center gap-2 mb-3">
                <Clock size={16} className="text-orange" />
                <h3 className="font-extrabold text-charcoal">{t("openQcBatches")}</h3>
                <span className="ltr:ml-auto rtl:mr-auto text-xs font-bold bg-orange/10 text-orange px-2 py-0.5 rounded-full">
                  {data!.qcBatchAlerts.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {data!.qcBatchAlerts.slice(0, 5).map((b) => (
                  <div key={b.id} className={`flex items-center justify-between text-sm px-3 py-2 rounded-xl border ${
                    b.isOverdue ? "bg-red-50 border-red-200" : b.isUrgent ? "bg-amber-50 border-amber-200" : "bg-cream/50 border-border"
                  }`}>
                    <div className="min-w-0">
                      <p className="font-bold text-charcoal font-mono">{b.batchNumber}</p>
                      <p className="text-xs text-brown/50">
                        {b.origin} · {b.testerCount} {b.testerCount !== 1 ? t("testers") : t("tester")}
                      </p>
                    </div>
                    <span className={`shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg ltr:ml-2 rtl:mr-2 ${
                      b.isOverdue ? "bg-red-100 text-red-700" : b.isUrgent ? "bg-amber-100 text-amber-700" : "bg-cream text-brown"
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
