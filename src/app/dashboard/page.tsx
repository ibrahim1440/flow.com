"use client";

import { useState, useEffect } from "react";
import { Package, ShoppingCart, Factory, ClipboardCheck, Truck, Users, AlertTriangle, TrendingUp, Clock } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/translations";

type QcBatchAlert = {
  id: string;
  batchNumber: string;
  origin: string;
  testerCount: number;
  deadline: string | null;
  isOverdue: boolean;
  isUrgent: boolean;
};

type Stats = {
  totalOrders: number;
  pendingOrders: number;
  completedOrders: number;
  totalCustomers: number;
  totalBeans: number;
  totalBatches: number;
  totalQcRecords: number;
  totalDeliveries: number;
  totalStockKg: number;
  lowStockBeans: { beanType: string; quantityKg: number }[];
  recentOrders: { orderNumber: number; customer: { name: string }; items: { quantityKg: number; productionStatus: string }[]; createdAt: string }[];
  qcBatchAlerts: QcBatchAlert[];
};

export default function DashboardPage() {
  const { t, lang } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((r) => { if (r.ok) return r.json(); })
      .then((data) => { if (data) setStats(data); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="w-10 h-10 border-4 border-orange border-t-transparent rounded-full animate-spin" /></div>;
  }

  if (!stats) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <Package size={40} className="text-brown/30 mb-3" />
        <p className="text-lg font-bold text-charcoal">{t("noDashboardAccess")}</p>
        <p className="text-sm text-brown/60 mt-1">{t("useSidebar")}</p>
      </div>
    );
  }

  const cards: { labelKey: TranslationKey; value: number; icon: React.ElementType; color: string }[] = [
    { labelKey: "totalOrders",    value: stats.totalOrders,        icon: ShoppingCart, color: "bg-slate" },
    { labelKey: "pendingProd",    value: stats.pendingOrders,      icon: Factory,      color: "bg-orange" },
    { labelKey: "completed",      value: stats.completedOrders,    icon: ClipboardCheck, color: "bg-green-600" },
    { labelKey: "customers",      value: stats.totalCustomers,     icon: Users,        color: "bg-purple-600" },
    { labelKey: "greenBeans",     value: stats.totalBeans,         icon: Package,      color: "bg-emerald-600" },
    { labelKey: "totalStock",     value: Math.round(stats.totalStockKg), icon: Package, color: "bg-teal-600" },
    { labelKey: "roastingBatches",value: stats.totalBatches,       icon: Factory,      color: "bg-brown" },
    { labelKey: "deliveries",     value: stats.totalDeliveries,    icon: Truck,        color: "bg-indigo-600" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-charcoal">{t("dashboard")}</h1>
        <p className="text-brown text-sm font-medium">{t("overview")}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card) => (
          <div key={card.labelKey} className="bg-white rounded-2xl p-4 border border-border hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300 group">
            <div className="flex items-center gap-3">
              <div className={`w-11 h-11 ${card.color} rounded-xl flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform`}>
                <card.icon size={20} className="text-white" />
              </div>
              <div>
                <p className="text-2xl font-extrabold text-charcoal">{card.value}</p>
                <p className="text-xs text-brown/60 font-medium">{t(card.labelKey)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {stats.lowStockBeans?.length > 0 && (
          <div className="bg-white rounded-2xl border border-border p-5">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle size={18} className="text-orange" />
              <h3 className="font-extrabold text-charcoal">{t("lowStockAlerts")}</h3>
            </div>
            <div className="space-y-2">
              {stats.lowStockBeans.map((bean) => (
                <div key={bean.beanType} className="flex items-center justify-between p-3 bg-warning-bg/50 rounded-xl border border-warning/20">
                  <span className="text-sm font-semibold text-charcoal">{bean.beanType}</span>
                  <span className="text-sm font-extrabold text-orange">{bean.quantityKg} kg</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {stats.qcBatchAlerts?.length > 0 && (
          <div className="bg-white rounded-2xl border border-border p-5">
            <div className="flex items-center gap-2 mb-4">
              <Clock size={18} className="text-orange" />
              <h3 className="font-extrabold text-charcoal">{t("openQcBatches")}</h3>
              <span className="ltr:ml-auto rtl:mr-auto text-xs font-bold bg-orange/10 text-orange px-2 py-0.5 rounded-full">
                {stats.qcBatchAlerts.length}
              </span>
            </div>
            <div className="space-y-2">
              {stats.qcBatchAlerts.map((b) => (
                <div key={b.id} className={`flex items-center justify-between p-3 rounded-xl border ${b.isOverdue ? "bg-red-50 border-red-200" : b.isUrgent ? "bg-amber-50 border-amber-200" : "bg-cream/50 border-border-light"}`}>
                  <div>
                    <p className="text-sm font-bold text-charcoal font-mono">{b.batchNumber}</p>
                    <p className="text-xs text-brown/60">
                      {b.origin} · {b.testerCount} {b.testerCount !== 1 ? t("testers") : t("tester")}
                    </p>
                  </div>
                  {b.deadline && (
                    <div className="text-end">
                      <p className={`text-xs font-bold ${b.isOverdue ? "text-red-600" : b.isUrgent ? "text-amber-600" : "text-brown/50"}`}>
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

        <div className="bg-white rounded-2xl border border-border p-5">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp size={18} className="text-slate" />
            <h3 className="font-extrabold text-charcoal">{t("recentOrders")}</h3>
          </div>
          <div className="space-y-2">
            {stats.recentOrders.slice(0, 6).map((order) => {
              const totalKg = order.items.reduce((s, i) => s + i.quantityKg, 0);
              const allDone = order.items.every((i) => i.productionStatus === "Completed");
              return (
                <div key={order.orderNumber} className="flex items-center justify-between p-3 bg-cream/50 rounded-xl border border-border-light">
                  <div>
                    <p className="text-sm font-bold text-charcoal">#{order.orderNumber} — {order.customer.name}</p>
                    <p className="text-xs text-brown/50 font-medium">{totalKg} kg</p>
                  </div>
                  <span className={`status-badge ${allDone ? "status-completed" : "status-pending"}`}>
                    {allDone ? t("statusCompleted") : t("inProgress")}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
