"use client";
// Global history — Direction 2.1 (UI batch 2; GX D-P02, Figma 1494:3302 at 1440, EN 1494:3687,
// 1024 1498:3322, phone 1500:3362).
//
// Visual port only: the same four requests (orders, roasting batches, QC records, deliveries),
// the same merge and newest-first sort, the same type and date filters, and the same CSV export
// (GET /api/export?type=…, identical columns, values and file name). The record lines are now
// written in the viewer's language. A source that does not load (e.g. a module the viewer lacks)
// no longer empties the whole page: the others are shown and the gap is named (D-J02 «partial»).
// The export panel states plainly that the files ignore the filters on screen (GX-D2, a known
// server-side defect, not changed here).
import { useState, useEffect } from "react";
import { formatDate } from "@/lib/utils";
import { inventoryExportRows, orderExportRows } from "@/lib/history-export";
import { Btn, Empty, Notice, OpsBanner, OpsLoading, OpsRoot, PageHeader, countNoun, useL } from "@/components/ops/ui";
import { dateTimeIn } from "@/components/hr/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { useI18n } from "@/lib/i18n/context";
import { DownloadIco } from "../_components/tools-ui";

type HistoryType = "Order" | "Production" | "QC" | "Delivery";
type Line = { ar: string; en: string };
type HistoryItem = {
  type: HistoryType; date: string; description: Line; details: Line; mono?: string;
};

const RECORD_FORMS: [string, string, string, string, string, string] = ["سجل واحد", "سجلان", "سجلات", "سجلًا", "record", "records"];
const LINE_FORMS: [string, string, string, string, string, string] = ["بند واحد", "بندان", "بنود", "بندًا", "line", "lines"];

/** dd/mm/yyyy in Riyadh time (the frame's date column). */
function dmy(d: string): string {
  const s = dateTimeIn(d);
  return s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "—";
}

const PAYMENT_AR: Record<string, string> = { "paid": "مدفوع", "not paid": "غير مدفوع", "partial paid": "مدفوع جزئيًا", "partial": "جزئي" };

export default function HistoryPage() {
  const { t, lang } = useI18n();
  const L = useL();
  const ar = lang === "ar";
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState<HistoryType[]>([]);
  const [typeFilter, setTypeFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useD21Phone({ title: t("history"), sub: L("التشغيل", "Operations") });

  useEffect(() => {
    async function loadHistory() {
      const [ordersRes, batchesRes, qcRes, deliveriesRes] = await Promise.all([
        fetch("/api/orders"), fetch("/api/roasting-batches"),
        fetch("/api/qc-records"), fetch("/api/deliveries"),
      ]);

      const read = async (r: Response) => { const j = await r.json().catch(() => null); return Array.isArray(j) ? j : null; };
      const orders = await read(ordersRes);
      const batches = await read(batchesRes);
      const qcRecords = await read(qcRes);
      const deliveries = await read(deliveriesRes);
      const gaps: HistoryType[] = [];
      if (!orders) gaps.push("Order");
      if (!batches) gaps.push("Production");
      if (!qcRecords) gaps.push("QC");
      if (!deliveries) gaps.push("Delivery");

      const history: HistoryItem[] = [];

      for (const o of orders ?? []) {
        const totalKg = o.items.reduce((s: number, i: { quantityKg: number }) => s + i.quantityKg, 0);
        const pay = String(o.paymentStatus ?? "");
        history.push({
          type: "Order",
          date: o.createdAt,
          mono: `#${o.orderNumber}`,
          description: { ar: `الطلب #${o.orderNumber} · ${o.customer.name}`, en: `Order #${o.orderNumber} · ${o.customer.name}` },
          details: {
            ar: `${countNoun(o.items.length, "ar", LINE_FORMS)} · ${totalKg} كغ · الدفع: ${PAYMENT_AR[pay.toLowerCase()] ?? pay}`,
            en: `${countNoun(o.items.length, "en", LINE_FORMS)} · ${totalKg} kg · payment: ${pay}`,
          },
        });
      }

      for (const b of batches ?? []) {
        const bean = b.orderItem?.beanTypeName;
        history.push({
          type: "Production",
          date: b.date,
          description: { ar: `الدفعة ${b.batchNumber} · ${bean || "غير معروف"}`, en: `Batch ${b.batchNumber} · ${bean || "Unknown"}` },
          details: {
            ar: `${b.greenBeanQuantity} كغ أخضر ← ${b.roastedBeanQuantity} كغ محمص · فاقد ${b.wasteQuantity} كغ`,
            en: `${b.greenBeanQuantity} kg green → ${b.roastedBeanQuantity} kg roasted · ${b.wasteQuantity} kg loss`,
          },
        });
      }

      for (const r of qcRecords ?? []) {
        history.push({
          type: "QC",
          date: r.date,
          description: { ar: `جودة: ${r.coffeeOrigin} (${r.processing})`, en: `QC: ${r.coffeeOrigin} (${r.processing})` },
          details: {
            ar: `${r.onProfile ? "ضمن الملف" : "خارج الملف"} · ${r.remarks || "بلا ملاحظات"}`,
            en: `${r.onProfile ? "On profile" : "Off profile"} · ${r.remarks || "no remarks"}`,
          },
        });
      }

      for (const d of deliveries ?? []) {
        const who = d.orderItem?.order?.customer?.name;
        const num = d.orderItem?.order?.orderNumber || "?";
        const full = d.deliveryType === "full";
        // Phase D: which lots the delivery drew from (DeliveryLine, or the ledger for older ones).
        const lots = (d.lots ?? []).map((x: { batchNumber: string | null }) => x.batchNumber).filter(Boolean).join("، ");
        const qtyAr = d.quantityUnits != null ? `${d.quantityUnits} وحدة` : `${d.quantityKg} كغ`;
        const qtyEn = d.quantityUnits != null ? `${d.quantityUnits} units` : `${d.quantityKg} kg`;
        history.push({
          type: "Delivery",
          date: d.date,
          description: { ar: `تسليم إلى ${who || "غير معروف"} (#${num})`, en: `Delivery to ${who || "Unknown"} (#${num})` },
          details: {
            ar: `${qtyAr} · ${full ? "تسليم كامل" : "تسليم جزئي"}${lots ? ` · اللوتات: ${lots}` : ""}`,
            en: `${qtyEn} · ${full ? "full" : "partial"} delivery${lots ? ` · lots: ${lots.replace(/، /g, ", ")}` : ""}`,
          },
        });
      }

      history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setItems(history);
      setMissing(gaps);
      setLoading(false);
    }
    loadHistory();
  }, []);

  const [exporting, setExporting] = useState(false);

  async function handleExport(exportType: string) {
    setExporting(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/export?type=${exportType}`);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) {
        setNotice(L("لا توجد بيانات للتصدير.", "No data to export"));
        return;
      }

      const rows: Record<string, unknown>[] = [];

      if (exportType === "orders") {
        // B1: "VAT Status" is the order's vatInvoiceStatus (lib/history-export).
        rows.push(...orderExportRows(data));
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
            "Quantity (units)": d.quantityUnits ?? "",
            "Delivery Type": d.deliveryType,
            // Phase D: «batch (qty)» per lot the delivery drew from.
            Lots: (d.lots ?? []).map((x: { batchNumber: string | null; quantityUnits: number | null; quantityKg: number }) =>
              `${x.batchNumber ?? "?"} (${x.quantityUnits ?? x.quantityKg})`).join("; "),
            Notes: d.notes || "",
          });
        }
      } else if (exportType === "inventory") {
        // B2: "Arrival Date" is the green lot's receivedDate (lib/history-export).
        rows.push(...inventoryExportRows(data));
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

  const TYPES: { key: string; label: string }[] = [
    { key: "all", label: L("الكل", "All") },
    { key: "Order", label: L("طلبات", "Orders") },
    { key: "Production", label: L("إنتاج", "Production") },
    { key: "QC", label: L("جودة", "QC") },
    { key: "Delivery", label: L("تسليم", "Deliveries") },
  ];
  const typeLabel: Record<HistoryType, string> = { Order: t("typeOrder"), Production: t("typeProduction"), QC: t("typeQc"), Delivery: t("typeDelivery") };
  const filtering = typeFilter !== "all" || !!dateFrom || !!dateTo;
  const EXPORTS: { type: string; label: string }[] = [
    { type: "orders", label: t("orders") },
    { type: "production", label: t("production") },
    { type: "qc", label: t("qc") },
    { type: "deliveries", label: t("deliveries") },
    { type: "inventory", label: t("inventory") },
  ];

  const exportPanel = (
    <aside className="tl-panel" aria-label={L("تصدير CSV", "Export CSV")} data-testid="history-export">
      <div>
        <h2>{L("تصدير CSV · نطاق ثابت", "Export CSV · fixed scope")}</h2>
        <p className="hr-caption" style={{ margin: "2px 0 0" }}>{L("ملف لكل نوع · آخر 500 سجل", "One file per dataset · latest 500 records")}</p>
      </div>
      <Notice tone="warning">
        <strong>{L("لا يطابق الفلاتر المعروضة.", "Doesn't match the filters shown.")}</strong>{" "}
        {L(
          "كل ملف يحوي آخر 500 سجل من نوعه بغض النظر عن النوع والتاريخ المختارين أعلاه. هذا عيب معروف وإصلاحه في الخادم.",
          "Each file holds the latest 500 records of its dataset, whatever type and dates are selected above. This is a known defect; the fix is server-side.",
        )}
      </Notice>
      <div className="tl-acts">
        {EXPORTS.map((e) => (
          <Btn key={e.type} size="sm" onClick={() => handleExport(e.type)} disabled={exporting} data-testid={`export-${e.type}`}>
            <DownloadIco />{e.label}
          </Btn>
        ))}
      </div>
      <p className="tl-foot">{L("المخزون: البن الأخضر فقط (200 صف) · UTF-8", "Inventory: green coffee only (200 rows) · UTF-8")}</p>
    </aside>
  );

  return (
    <OpsRoot className="tl-root">
      <div className="hr-page">
        <PageHeader title={t("history")} />
        <p className="tl-sub">
          <span>{loading ? "…" : countNoun(filtered.length, lang, RECORD_FORMS)}</span>
          <span className="tl-sep">•</span>
          {L("الطلبات والإنتاج والجودة والتسليم", "Orders, production, QC and deliveries")}
        </p>

        {notice ? <OpsBanner tone="info" onClose={() => setNotice(null)}>{notice}</OpsBanner> : null}
        {missing.length > 0 ? (
          <Notice tone="warning">
            {L("لم تُحمَّل بعض المصادر، فالسجل جزئي: ", "Some sources did not load, so the history is partial: ")}
            {missing.map((m) => typeLabel[m]).join(ar ? "، " : ", ")}
          </Notice>
        ) : null}

        <div className="tl-hist">
          <div className="hr-stack" style={{ gap: 12, minWidth: 0 }}>
            <div className="tl-tool">
              <div className="tl-seg" role="group" aria-label={L("النوع", "Type")} data-testid="history-type">
                {TYPES.map((x) => (
                  <button key={x.key} type="button" aria-pressed={typeFilter === x.key} onClick={() => setTypeFilter(x.key)}>{x.label}</button>
                ))}
              </div>
              <label className={`tl-date${dateFrom ? " is-set" : ""}`}>
                <span>{L("من", "From")}</span>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label={L("من تاريخ", "From date")} />
                {dateFrom ? <button type="button" aria-label={L("مسح تاريخ البداية", "Clear start date")} onClick={() => setDateFrom("")}>×</button> : null}
              </label>
              <label className={`tl-date${dateTo ? " is-set" : ""}`}>
                <span>{t("to")}</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label={L("إلى تاريخ", "To date")} />
                {dateTo ? <button type="button" aria-label={L("مسح تاريخ النهاية", "Clear end date")} onClick={() => setDateTo("")}>×</button> : null}
              </label>
              {filtering ? <Btn variant="ghost" size="sm" onClick={() => { setTypeFilter("all"); setDateFrom(""); setDateTo(""); }}>{L("مسح الفلاتر", "Clear filters")}</Btn> : null}
              <span className="tl-sp" />
              <span className="hr-caption tl-hide-phone">{L("الأحدث أولًا", "Newest first")}</span>
            </div>

            {loading ? <OpsLoading /> : filtered.length === 0 ? (
              <Empty title={t("noHistoryFound")} body={filtering ? L("لا سجل يطابق الفلاتر. امسحها لعرض كل السجلات.", "Nothing matches the filters. Clear them to see every record.") : undefined} />
            ) : (
              <div className="hr-tablewrap">
                <table className="hr-table is-mrow" aria-label={t("history")} data-testid="history-table">
                  <thead>
                    <tr>
                      <th style={{ width: 120 }}>{L("النوع", "Type")}</th>
                      <th>{L("السجل", "Record")}</th>
                      <th style={{ width: 140 }}>{L("التاريخ", "Date")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((item, idx) => (
                      <tr key={idx}>
                        <td><span className={`tl-type t-${item.type}`}><span>{typeLabel[item.type]}</span></span></td>
                        <td className="m-title">
                          <span className="strong" style={{ fontWeight: 500 }} dir="auto">{ar ? item.description.ar : item.description.en}</span>
                          <span className="stk-sub hr-desktop-only" style={{ fontSize: 13, color: "var(--text-muted)", display: "block" }}>{ar ? item.details.ar : item.details.en}</span>
                          <span className="hr-msub">{ar ? item.details.ar : item.details.en}</span>
                        </td>
                        <td className="m-end is-stack">
                          <span className="hr-num" style={{ color: "var(--text-secondary)" }}>{dmy(item.date)}</span>
                          <span className="hr-mobile-only"><span className={`tl-type t-${item.type}`}><span>{typeLabel[item.type]}</span></span></span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="tl-foot">{L("حركات المخزون ليست في هذا السجل · راجعها في المخزون › سجل الحركات", "Stock movements are not in this history · see Inventory › Movements")}</p>
          </div>
          {exportPanel}
        </div>
      </div>
    </OpsRoot>
  );
}
