"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Coffee,
  TrendingDown,
  ShoppingCart,
  Users,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Factory,
  Truck,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { Package } from "lucide-react";

type Timeframe = "today" | "week" | "month" | "all";

type InventoryAlert = {
  id: string;
  beanType: string;
  beanTypeAr: string | null;
  country: string;
  countryAr: string | null;
  quantityKg: number;
};

type ActiveOrder = {
  id: string;
  orderNumber: number;
  customer: { name: string; nameAr: string | null };
  items: {
    productionStatus: string;
    deliveryStatus: string;
    quantityKg: number;
    beanTypeName: string;
  }[];
  createdAt: string;
};

type QcBatchAlert = {
  id: string;
  batchNumber: string;
  origin: string;
  testerCount: number;
  deadline: string | null;
  isOverdue: boolean;
  isUrgent: boolean;
};

type DashboardData = {
  totalRoastedKg: number;
  totalGreenKg: number;
  shrinkagePct: number | null;
  ordersPipeline: {
    pending: number;
    inProduction: number;
    readyToDispatch: number;
  };
  activeCustomers: number;
  inventoryAlerts: InventoryAlert[];
  recentActiveOrders: ActiveOrder[];
  qcBatchAlerts: QcBatchAlert[];
};

const TIMEFRAMES: { key: Timeframe; labelKey: "today" | "thisWeek" | "thisMonth" | "allTime" }[] = [
  { key: "today",  labelKey: "today" },
  { key: "week",   labelKey: "thisWeek" },
  { key: "month",  labelKey: "thisMonth" },
  { key: "all",    labelKey: "allTime" },
];

function statusColor(status: string) {
  switch (status) {
    case "Pending":       return "bg-amber-100 text-amber-700";
    case "In Production": return "bg-orange/10 text-orange";
    case "Completed":     return "bg-green-100 text-green-700";
    default:              return "bg-cream text-brown";
  }
}

export default function DashboardPage() {
  const { t, lang } = useI18n();
  const [timeframe, setTimeframe] = useState<Timeframe>("today");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback((tf: Timeframe) => {
    setLoading(true);
    fetch(`/api/dashboard/stats?timeframe=${tf}`)
      .then((r) => { if (r.ok) return r.json(); })
      .then((d) => { if (d) setData(d); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(timeframe); }, [timeframe, fetchData]);

  if (!loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <Package size={40} className="text-brown/30 mb-3" />
        <p className="text-lg font-bold text-charcoal">{t("noDashboardAccess")}</p>
        <p className="text-sm text-brown/60 mt-1">{t("useSidebar")}</p>
      </div>
    );
  }

  const d = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("dashboard")}</h1>
          <p className="text-brown text-sm font-medium">{t("overview")}</p>
        </div>

        {/* Timeframe tabs */}
        <div className="flex items-center gap-1 bg-cream rounded-xl p-1 border border-border w-fit">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              onClick={() => setTimeframe(tf.key)}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all duration-150 ${
                timeframe === tf.key
                  ? "bg-orange text-white shadow-sm"
                  : "text-brown hover:text-charcoal hover:bg-white/60"
              }`}
            >
              {t(tf.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Total Roasted */}
        <div className="bg-white rounded-2xl p-5 border border-border hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300 group">
          <div className="flex items-start justify-between mb-3">
            <div className="w-10 h-10 bg-brown rounded-xl flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform">
              <Coffee size={18} className="text-white" />
            </div>
          </div>
          {loading ? (
            <div className="h-8 w-24 bg-cream animate-pulse rounded-lg" />
          ) : (
            <p className="text-3xl font-extrabold text-charcoal">
              {d ? d.totalRoastedKg.toFixed(1) : "—"}
              <span className="text-sm font-semibold text-brown/50 ltr:ml-1 rtl:mr-1">{t("kgUnit")}</span>
            </p>
          )}
          <p className="text-xs text-brown/60 font-semibold mt-1">{t("totalRoastedCoffee")}</p>
        </div>

        {/* Card 2: Shrinkage */}
        <div className="bg-white rounded-2xl p-5 border border-border hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300 group">
          <div className="flex items-start justify-between mb-3">
            <div className="w-10 h-10 bg-amber-500 rounded-xl flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform">
              <TrendingDown size={18} className="text-white" />
            </div>
          </div>
          {loading ? (
            <div className="h-8 w-24 bg-cream animate-pulse rounded-lg" />
          ) : (
            <p className="text-3xl font-extrabold text-charcoal">
              {d?.shrinkagePct != null ? `${d.shrinkagePct}` : "—"}
              {d?.shrinkagePct != null && (
                <span className="text-sm font-semibold text-brown/50 ltr:ml-0.5 rtl:mr-0.5">%</span>
              )}
            </p>
          )}
          <p className="text-xs text-brown/60 font-semibold mt-1">{t("shrinkagePct")}</p>
        </div>

        {/* Card 3: Orders Pipeline (live snapshot) */}
        <div className="bg-white rounded-2xl p-5 border border-border hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300">
          <div className="flex items-start justify-between mb-3">
            <div className="w-10 h-10 bg-slate rounded-xl flex items-center justify-center shadow-sm">
              <ShoppingCart size={18} className="text-white" />
            </div>
          </div>
          {loading ? (
            <div className="h-8 w-full bg-cream animate-pulse rounded-lg" />
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="text-center">
                <p className="text-2xl font-extrabold text-amber-600">{d?.ordersPipeline.pending ?? 0}</p>
                <p className="text-[10px] font-bold text-brown/50 uppercase tracking-wide">{t("pending")}</p>
              </div>
              <div className="w-px h-8 bg-border" />
              <div className="text-center">
                <p className="text-2xl font-extrabold text-orange">{d?.ordersPipeline.inProduction ?? 0}</p>
                <p className="text-[10px] font-bold text-brown/50 uppercase tracking-wide">{t("statusInProd")}</p>
              </div>
              <div className="w-px h-8 bg-border" />
              <div className="text-center">
                <p className="text-2xl font-extrabold text-green-600">{d?.ordersPipeline.readyToDispatch ?? 0}</p>
                <p className="text-[10px] font-bold text-brown/50 uppercase tracking-wide">{t("readyToDispatch")}</p>
              </div>
            </div>
          )}
          <p className="text-xs text-brown/60 font-semibold mt-2">{t("ordersPipelineLabel")}</p>
        </div>

        {/* Card 4: Active Customers */}
        <div className="bg-white rounded-2xl p-5 border border-border hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300 group">
          <div className="flex items-start justify-between mb-3">
            <div className="w-10 h-10 bg-purple-600 rounded-xl flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform">
              <Users size={18} className="text-white" />
            </div>
          </div>
          {loading ? (
            <div className="h-8 w-24 bg-cream animate-pulse rounded-lg" />
          ) : (
            <p className="text-3xl font-extrabold text-charcoal">{d?.activeCustomers ?? 0}</p>
          )}
          <p className="text-xs text-brown/60 font-semibold mt-1">{t("activeCustomers")}</p>
        </div>
      </div>

      {/* Bottom Panels */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Panel A: Inventory Alerts */}
        <div className="bg-white rounded-2xl border border-border p-5">
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle size={18} className="text-red-500" />
            <h3 className="font-extrabold text-charcoal">{t("inventoryAlertsTitle")}</h3>
            {!loading && d && d.inventoryAlerts.length > 0 && (
              <span className="ltr:ml-auto rtl:mr-auto text-xs font-bold bg-red-100 text-red-600 px-2 py-0.5 rounded-full">
                {d.inventoryAlerts.length}
              </span>
            )}
          </div>

          {loading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-12 bg-cream animate-pulse rounded-xl" />
              ))}
            </div>
          ) : !d || d.inventoryAlerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <CheckCircle2 size={28} className="text-green-400 mb-2" />
              <p className="text-sm font-semibold text-brown/60">{t("noInventoryAlerts")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {d.inventoryAlerts.map((bean) => (
                <div
                  key={bean.id}
                  className="flex items-center justify-between p-3 bg-red-50 rounded-xl border border-red-100"
                >
                  <div>
                    <p className="text-sm font-bold text-charcoal">
                      {lang === "ar" && bean.beanTypeAr ? bean.beanTypeAr : bean.beanType}
                    </p>
                    <p className="text-xs text-brown/50 font-medium">
                      {lang === "ar" && bean.countryAr ? bean.countryAr : bean.country}
                    </p>
                  </div>
                  <span className="flex items-center gap-1 bg-red-100 text-red-600 text-xs font-extrabold px-2.5 py-1 rounded-lg">
                    <AlertTriangle size={12} />
                    {bean.quantityKg.toFixed(1)} {t("kgUnit")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Panel B: Recent Active Orders */}
        <div className="bg-white rounded-2xl border border-border p-5">
          <div className="flex items-center gap-2 mb-4">
            <Clock size={18} className="text-slate" />
            <h3 className="font-extrabold text-charcoal">{t("recentActiveOrders")}</h3>
          </div>

          {loading ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-14 bg-cream animate-pulse rounded-xl" />
              ))}
            </div>
          ) : !d || d.recentActiveOrders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <CheckCircle2 size={28} className="text-green-400 mb-2" />
              <p className="text-sm font-semibold text-brown/60">{t("noActiveOrders")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {d.recentActiveOrders.map((order) => {
                const totalKg = order.items.reduce((s, i) => s + i.quantityKg, 0);
                const statusCounts = order.items.reduce<Record<string, number>>((acc, i) => {
                  acc[i.productionStatus] = (acc[i.productionStatus] ?? 0) + 1;
                  return acc;
                }, {});
                const dominantStatus = Object.entries(statusCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Pending";
                const customerName =
                  lang === "ar" && order.customer.nameAr
                    ? order.customer.nameAr
                    : order.customer.name;

                return (
                  <div
                    key={order.id}
                    className="flex items-center justify-between p-3 bg-cream/50 rounded-xl border border-border-light"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-charcoal truncate">
                        #{order.orderNumber} — {customerName}
                      </p>
                      <p className="text-xs text-brown/50 font-medium">
                        {totalKg} {t("kgUnit")} · {order.items.length} {t("itemsTotal")}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg ltr:ml-2 rtl:mr-2 ${statusColor(dominantStatus)}`}
                    >
                      {dominantStatus === "Pending"
                        ? t("pending")
                        : dominantStatus === "In Production"
                        ? t("statusInProd")
                        : t("statusCompleted")}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* QC Alerts (retained) */}
      {!loading && d && d.qcBatchAlerts.length > 0 && (
        <div className="bg-white rounded-2xl border border-border p-5">
          <div className="flex items-center gap-2 mb-4">
            <Factory size={18} className="text-orange" />
            <h3 className="font-extrabold text-charcoal">{t("openQcBatches")}</h3>
            <span className="ltr:ml-auto rtl:mr-auto text-xs font-bold bg-orange/10 text-orange px-2 py-0.5 rounded-full">
              {d.qcBatchAlerts.length}
            </span>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {d.qcBatchAlerts.map((b) => (
              <div
                key={b.id}
                className={`flex items-center justify-between p-3 rounded-xl border ${
                  b.isOverdue
                    ? "bg-red-50 border-red-200"
                    : b.isUrgent
                    ? "bg-amber-50 border-amber-200"
                    : "bg-cream/50 border-border-light"
                }`}
              >
                <div>
                  <p className="text-sm font-bold text-charcoal font-mono">{b.batchNumber}</p>
                  <p className="text-xs text-brown/60">
                    {b.origin} · {b.testerCount}{" "}
                    {b.testerCount !== 1 ? t("testers") : t("tester")}
                  </p>
                </div>
                {b.deadline && (
                  <div className="text-end">
                    <p
                      className={`text-xs font-bold ${
                        b.isOverdue ? "text-red-600" : b.isUrgent ? "text-amber-600" : "text-brown/50"
                      }`}
                    >
                      {b.isOverdue ? t("overdue") : b.isUrgent ? t("dueSoon") : t("pending")}
                    </p>
                    <p className="text-[10px] text-brown/40">
                      {new Date(b.deadline).toLocaleDateString(lang === "ar" ? "ar-SA" : "en-US")}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
