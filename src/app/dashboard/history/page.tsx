"use client";

import { useState, useEffect } from "react";
import { History, Filter, Download, FileSpreadsheet, FileText } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";

type HistoryItem = {
  type: string; date: string; description: string; details: string;
};

export default function HistoryPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [typeFilter, setTypeFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => { loadHistory(); }, []);

  async function loadHistory() {
    const [ordersRes, batchesRes, qcRes, deliveriesRes] = await Promise.all([
      fetch("/api/orders"), fetch("/api/roasting-batches"),
      fetch("/api/qc-records"), fetch("/api/deliveries"),
    ]);

    const orders = await ordersRes.json();
    const batches = await batchesRes.json();
    const qcRecords = await qcRes.json();
    const deliveries = await deliveriesRes.json();

    const history: HistoryItem[] = [];

    for (const o of orders) {
      const totalKg = o.items.reduce((s: number, i: { quantityKg: number }) => s + i.quantityKg, 0);
      history.push({
        type: "Order",
        date: o.createdAt,
        description: `Order #${o.orderNumber} — ${o.customer.name}`,
        details: `${o.items.length} item(s), ${totalKg}kg total, Payment: ${o.paymentStatus}`,
      });
    }

    for (const b of batches) {
      history.push({
        type: "Production",
        date: b.date,
        description: `Batch ${b.batchNumber} — ${b.orderItem?.beanTypeName || "Unknown"}`,
        details: `${b.greenBeanQuantity}kg green → ${b.roastedBeanQuantity}kg roasted (${b.wasteQuantity}kg waste)`,
      });
    }

    for (const r of qcRecords) {
      history.push({
        type: "QC",
        date: r.date,
        description: `QC: ${r.coffeeOrigin} (${r.processing})`,
        details: `${r.onProfile ? "On Profile" : "Off Profile"} — ${r.remarks || "No remarks"}`,
      });
    }

    for (const d of deliveries) {
      history.push({
        type: "Delivery",
        date: d.date,
        description: `Delivery to ${d.orderItem?.order?.customer?.name || "Unknown"} (#${d.orderItem?.order?.orderNumber || "?"})`,
        details: `${d.quantityKg}kg — ${d.deliveryType === "full" ? "Full" : "Partial"} delivery`,
      });
    }

    history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    setItems(history);
  }

  const [exporting, setExporting] = useState(false);

  async function handleExport(exportType: string) {
    setExporting(true);
    try {
      const res = await fetch(`/api/export?type=${exportType}`);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) {
        alert("No data to export");
        return;
      }

      const rows: Record<string, unknown>[] = [];

      if (exportType === "orders") {
        for (const o of data) {
          for (const item of o.items || []) {
            rows.push({
              "Order #": o.orderNumber,
              Customer: o.customer?.name || "",
              "Order Date": formatDate(o.createdAt),
              "Payment Status": o.paymentStatus,
              "VAT Status": o.vatStatus,
              "Bean Type": item.beanTypeName,
              "Quantity (kg)": item.quantityKg,
              "Production Status": item.productionStatus,
              "Delivery Status": item.deliveryStatus,
              "Delivered (kg)": item.deliveredQty,
              "Remaining (kg)": item.remainingQty,
            });
          }
        }
      } else if (exportType === "production") {
        for (const b of data) {
          rows.push({
            "Batch #": b.batchNumber,
            Date: formatDate(b.date),
            "Order #": b.orderItem?.order?.orderNumber || "",
            Customer: b.orderItem?.order?.customer?.name || "",
            "Bean Type": b.orderItem?.beanTypeName || "",
            "Green Bean": b.greenBean?.beanType || "",
            "Green Qty (kg)": b.greenBeanQuantity,
            "Roasted Qty (kg)": b.roastedBeanQuantity,
            "Waste (kg)": b.wasteQuantity,
            "Roast Profile": b.roastProfile,
            "3kg Bags": b.bags3kg,
            "1kg Bags": b.bags1kg,
            "250g Bags": b.bags250g,
            "150g Bags": b.bags150g,
            "Samples (g)": b.samplesGrams,
          });
        }
      } else if (exportType === "qc") {
        for (const r of data) {
          rows.push({
            Date: formatDate(r.date),
            "S/N": r.serialNumber,
            Origin: r.coffeeOrigin,
            Processing: r.processing,
            "On Profile": r.onProfile ? "Yes" : "No",
            "Under Developed": r.underDeveloped ? "Yes" : "No",
            "Over Developed": r.overDeveloped ? "Yes" : "No",
            Color: r.color || "",
            Remarks: r.remarks || "",
            "Batch #": r.batch?.batchNumber || "",
          });
        }
      } else if (exportType === "deliveries") {
        for (const d of data) {
          rows.push({
            Date: formatDate(d.date),
            "Order #": d.orderItem?.order?.orderNumber || "",
            Customer: d.orderItem?.order?.customer?.name || "",
            "Bean Type": d.orderItem?.beanTypeName || "",
            "Quantity (kg)": d.quantityKg,
            "Delivery Type": d.deliveryType,
            Notes: d.notes || "",
          });
        }
      } else if (exportType === "inventory") {
        for (const g of data) {
          rows.push({
            "S/N": g.serialNumber,
            "Bean Type": g.beanType,
            Country: g.country,
            Region: g.region || "",
            "Quantity (kg)": g.quantityKg,
            "Arrival Date": formatDate(g.arrivalDate),
          });
        }
      }

      if (rows.length === 0) return;

      const headers = Object.keys(rows[0]);
      const csvContent = [
        headers.join(","),
        ...rows.map((row) =>
          headers.map((h) => {
            const val = String(row[h] ?? "");
            return val.includes(",") || val.includes('"') || val.includes("\n")
              ? `"${val.replace(/"/g, '""')}"`
              : val;
          }).join(",")
        ),
      ].join("\n");

      const blob = new Blob(["﻿" + csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `hiqbah-${exportType}-${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  const filtered = items.filter((item) => {
    if (typeFilter !== "all" && item.type !== typeFilter) return false;
    if (dateFrom && new Date(item.date) < new Date(dateFrom)) return false;
    if (dateTo && new Date(item.date) > new Date(dateTo + "T23:59:59")) return false;
    return true;
  });

  const typeColors: Record<string, string> = {
    Order: "bg-blue-100 text-blue-700",
    Production: "bg-orange-100 text-orange-700",
    QC: "bg-purple-100 text-purple-700",
    Delivery: "bg-green-100 text-green-700",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("history")}</h1>
          <p className="text-brown text-sm font-medium">{filtered.length} records</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-border p-4">
        <div className="flex items-center gap-2 mb-3">
          <Download size={16} className="text-gray-400" />
          <span className="text-sm font-medium text-gray-600">Export Data (CSV)</span>
        </div>
        <div className="flex gap-2 flex-wrap">
          {[
            { type: "orders", labelKey: "orders", icon: FileText },
            { type: "production", labelKey: "production", icon: FileSpreadsheet },
            { type: "qc", labelKey: "qc", icon: FileSpreadsheet },
            { type: "deliveries", labelKey: "deliveries", icon: FileText },
            { type: "inventory", labelKey: "inventory", icon: FileSpreadsheet },
          ].map(({ type, labelKey, icon: Icon }) => (
            <button key={type} onClick={() => handleExport(type)} disabled={exporting}
              className="flex items-center gap-2 px-4 py-2 bg-orange text-white rounded-lg text-sm hover:bg-orange-dark disabled:opacity-50 shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200 font-bold">
              <Icon size={14} />{t(labelKey as any)}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-border p-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter size={16} className="text-gray-400" />
          <span className="text-sm font-medium text-gray-600">{t("search")}</span>
        </div>
        <div className="flex gap-3 flex-wrap">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
            className="px-3 py-2 border-2 border-border rounded-xl text-sm bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors">
            <option value="all">{t("allTypes")}</option>
            <option value="Order">{t("typeOrder")}</option>
            <option value="Production">{t("typeProduction")}</option>
            <option value="QC">{t("typeQc")}</option>
            <option value="Delivery">{t("typeDelivery")}</option>
          </select>
          <div className="flex items-center gap-2">
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="px-3 py-2 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
            <span className="text-gray-400">{t("to")}</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="px-3 py-2 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
          </div>
          {(typeFilter !== "all" || dateFrom || dateTo) && (
            <button onClick={() => { setTypeFilter("all"); setDateFrom(""); setDateTo(""); }}
              className="px-3 py-2 text-sm text-brown hover:underline">{t("cancel")}</button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {filtered.map((item, idx) => (
          <div key={idx} className="bg-white rounded-2xl border border-border p-4 flex items-start gap-4">
            <div className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${typeColors[item.type] || "bg-gray-100 text-gray-700"}`}>
              {item.type}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{item.description}</p>
              <p className="text-xs text-gray-500 mt-0.5">{item.details}</p>
            </div>
            <div className="text-xs text-gray-400 whitespace-nowrap">{formatDate(item.date)}</div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-400 bg-white rounded-2xl border">
            <History size={40} className="mx-auto mb-2" /><p>{t("noHistoryFound")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
