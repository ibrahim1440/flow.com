"use client";

import { useState, useEffect } from "react";
import { TrendingUp, Calendar, ShoppingCart, BarChart3 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";

type Prediction = {
  customerId: string; customerName: string; totalOrders: number;
  avgIntervalDays: number; avgQuantityKg: number; lastOrderDate: string;
  nextPredictedDate: string; daysUntilNext: number; topBeans: string[];
  confidence: number;
};

export default function AnalyticsPage() {
  const { t } = useI18n();
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/predictions")
      .then((r) => r.json())
      .then(setPredictions)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-4 border-orange border-t-transparent rounded-full animate-spin" /></div>;
  }

  const upcomingOrders = predictions.filter((p) => p.daysUntilNext <= 30);
  const overdueOrders = predictions.filter((p) => p.daysUntilNext < 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-charcoal">{t("predictiveAnalytics")}</h1>
        <p className="text-brown text-sm font-medium">{t("analyticsSubtitle")}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-red-50 rounded-2xl border border-red-200 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Calendar size={18} className="text-red-600" />
            <span className="font-semibold text-red-700">{t("overdue")}</span>
          </div>
          <p className="text-3xl font-bold text-red-600">{overdueOrders.length}</p>
          <p className="text-xs text-red-500">{t("customersOverdue")}</p>
        </div>
        <div className="bg-amber-50 rounded-2xl border border-amber-200 p-4">
          <div className="flex items-center gap-2 mb-2">
            <ShoppingCart size={18} className="text-amber-600" />
            <span className="font-semibold text-amber-700">{t("next30Days")}</span>
          </div>
          <p className="text-3xl font-bold text-amber-600">{upcomingOrders.length}</p>
          <p className="text-xs text-amber-500">{t("expectedOrdersSoon")}</p>
        </div>
        <div className="bg-blue-50 rounded-2xl border border-blue-200 p-4">
          <div className="flex items-center gap-2 mb-2">
            <BarChart3 size={18} className="text-blue-600" />
            <span className="font-semibold text-blue-700">{t("trackedCustomers")}</span>
          </div>
          <p className="text-3xl font-bold text-blue-600">{predictions.length}</p>
          <p className="text-xs text-blue-500">{t("analyticsSubtitle")}</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
        <div className="p-4 border-b border-border">
          <h2 className="font-semibold text-charcoal flex items-center gap-2">
            <TrendingUp size={18} /> {t("customers")}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-cream">
              <tr>
                <th className="text-start px-4 py-3 font-semibold">{t("customer")}</th>
                <th className="text-center px-4 py-3 font-semibold">{t("totalOrders")}</th>
                <th className="text-center px-4 py-3 font-semibold">{t("avgInterval")}</th>
                <th className="text-center px-4 py-3 font-semibold">{t("avgQty")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("history")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("daysUntilNext")}</th>
                <th className="text-center px-4 py-3 font-semibold">{t("days")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("topBeans")}</th>
                <th className="text-center px-4 py-3 font-semibold">{t("confidence")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {predictions.map((p) => (
                <tr key={p.customerId} className={`hover:bg-cream/50 ${p.daysUntilNext < 0 ? "bg-red-50" : p.daysUntilNext <= 7 ? "bg-amber-50" : ""}`}>
                  <td className="px-4 py-3 font-medium">{p.customerName}</td>
                  <td className="px-4 py-3 text-center">{p.totalOrders}</td>
                  <td className="px-4 py-3 text-center">{p.avgIntervalDays} {t("days")}</td>
                  <td className="px-4 py-3 text-center">{p.avgQuantityKg} kg</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(p.lastOrderDate)}</td>
                  <td className="px-4 py-3 font-medium">{formatDate(p.nextPredictedDate)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-1 rounded-full text-xs font-bold ${
                      p.daysUntilNext < 0 ? "bg-red-100 text-red-700" :
                      p.daysUntilNext <= 7 ? "bg-amber-100 text-amber-700" :
                      "bg-green-100 text-green-700"
                    }`}>
                      {p.daysUntilNext < 0 ? `${Math.abs(p.daysUntilNext)}d overdue` : `${p.daysUntilNext}d`}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {p.topBeans.map((bean) => (
                        <span key={bean} className="px-2 py-0.5 bg-cream text-brown rounded text-xs">{bean}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center gap-1 justify-center">
                      <div className="w-12 bg-gray-200 rounded-full h-1.5">
                        <div className="bg-orange h-1.5 rounded-full" style={{ width: `${p.confidence}%` }} />
                      </div>
                      <span className="text-xs text-gray-500">{p.confidence}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {predictions.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <TrendingUp size={40} className="mx-auto mb-2" /><p>{t("noAnalyticsData")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
