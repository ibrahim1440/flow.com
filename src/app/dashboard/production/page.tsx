"use client";

import { useState, useEffect } from "react";
import { Factory, AlertTriangle, CheckCircle, Merge, Box, FileText, FileSpreadsheet, Trash2, CalendarDays } from "lucide-react";
import EditDateModal, { type EditableBatch } from "@/components/EditDateModal";
import { formatDate } from "@/lib/utils";
import { exportBatchesPDF, exportBatchesExcel, type BatchExportRow } from "@/lib/export";
import { useUser } from "../layout";
import { hasSubPrivilege } from "@/lib/auth";
import { useI18n } from "@/lib/i18n/context";
import { type TranslationKey } from "@/lib/i18n/translations";

type Batch = {
  id: string; batchNumber: string; date: string; status: string;
  greenBeanQuantity: number; roastedBeanQuantity: number; wasteQuantity: number;
  roastProfile: string | null; blendTiming: string | null;
  bags3kg: number; bags1kg: number; bags250g: number; bags150g: number; samplesGrams: number;
  parentBatchId: string | null;
  parentBatch: { id: string; batchNumber: string } | null;
  greenBean: { beanType: string } | null;
  orderItem: { beanTypeName: string; order: { orderNumber: number; customer: { name: string } } };
  qcRecords: { id: string; onProfile: boolean }[];
  childBatches: { id: string; batchNumber: string }[];
};

type OrderItem = {
  id: string; beanTypeName: string; quantityKg: number; productionStatus: string;
  greenBeanId: string | null; greenBean: { id: string; beanType: string; quantityKg: number } | null;
  order: { orderNumber: number; customer: { name: string } };
  roastingBatches: { batchNumber: string; greenBeanQuantity: number; roastedBeanQuantity: number }[];
};

type GreenBean = { id: string; beanType: string; quantityKg: number; serialNumber: string };

const STATUS_STYLES: Record<string, string> = {
  "Pending QC": "bg-warning-bg text-yellow-800",
  "Passed": "bg-info-bg text-slate",
  "Partially Packaged": "bg-amber-100 text-amber-800",
  "Packaged": "bg-success-bg text-green-800",
  "Blended": "bg-purple-100 text-purple-800",
};

function statusLabel(status: string, t: (k: TranslationKey) => string) {
  const map: Record<string, TranslationKey> = {
    "Pending QC": "statusPendingQc",
    "Passed": "statusPassed",
    "Partially Packaged": "statusPartiallyPkg",
    "Packaged": "statusPackaged",
    "Blended": "statusBlended",
  };
  return map[status] ? t(map[status]) : status;
}

export default function ProductionPage() {
  const user = useUser();
  const { t } = useI18n();
  const canStartBatch = hasSubPrivilege(user?.permissions ?? {}, "production", "start_batch");
  const canBlend = hasSubPrivilege(user?.permissions ?? {}, "production", "blend");
  const canCancelBatch = hasSubPrivilege(user?.permissions ?? {}, "production", "cancel_batch");
  const canEditDate = hasSubPrivilege(user?.permissions ?? {}, "production", "edit_date");
  const canOverrideInventory = hasSubPrivilege(user?.permissions ?? {}, "inventory", "override");

  const [orders, setOrders] = useState<{ items: OrderItem[] }[]>([]);
  const [beans, setBeans] = useState<GreenBean[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Roast form
  const [showRoastForm, setShowRoastForm] = useState(false);
  const [selectedItem, setSelectedItem] = useState<OrderItem | null>(null);
  const [roastForm, setRoastForm] = useState({
    greenBeanId: "", greenBeanQuantity: 0, roastedBeanQuantity: 0, roastProfile: "",
  });

  // Blend form
  const [showBlendForm, setShowBlendForm] = useState(false);
  const [blendSelected, setBlendSelected] = useState<Set<string>>(new Set());

  // Tab
  const [tab, setTab] = useState<"pending" | "batches">("pending");

  // Cancel batch modal
  const [cancelBatch, setCancelBatch] = useState<Batch | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Edit date modal
  const [editDateBatch, setEditDateBatch] = useState<EditableBatch | null>(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    const [ordersRes, beansRes, batchRes] = await Promise.all([
      fetch("/api/orders?status=Pending,In+Production"),
      fetch("/api/green-beans"),
      fetch("/api/roasting-batches"),
    ]);
    if (ordersRes.ok) setOrders(await ordersRes.json());
    if (beansRes.ok) setBeans(await beansRes.json());
    if (batchRes.ok) setBatches(await batchRes.json());
  }

  function startProduction(item: OrderItem) {
    setSelectedItem(item);
    const produced = item.roastingBatches.reduce((s: number, b) => s + b.greenBeanQuantity, 0);
    const remaining = item.quantityKg - produced;
    setRoastForm({ greenBeanId: item.greenBeanId || "", greenBeanQuantity: remaining, roastedBeanQuantity: 0, roastProfile: "" });
    setError(""); setSuccess("");
    setShowRoastForm(true);
  }

  async function handleRoastSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (roastForm.greenBeanId) {
      const bean = beans.find((b) => b.id === roastForm.greenBeanId);
      if (bean && bean.quantityKg < roastForm.greenBeanQuantity) {
        setError(`${t("insufficientStock")} ${bean.quantityKg}kg`);
        return;
      }
    }

    const wasteQuantity = Math.max(0, +(roastForm.greenBeanQuantity - roastForm.roastedBeanQuantity).toFixed(2));
    const res = await fetch("/api/roasting-batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderItemId: selectedItem!.id,
        greenBeanId: roastForm.greenBeanId || undefined,
        greenBeanQuantity: roastForm.greenBeanQuantity,
        roastedBeanQuantity: roastForm.roastedBeanQuantity,
        wasteQuantity,
        roastProfile: roastForm.roastProfile || undefined,
      }),
    });

    if (!res.ok) {
      try {
        const data = await res.json();
        setError(data.error || "Failed to create batch");
      } catch {
        setError("Failed to create batch");
      }
      return;
    }

    setSuccess(t("batchCreated"));
    setShowRoastForm(false);
    loadData();
  }

  function toggleBlendBatch(id: string) {
    setBlendSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleBlend() {
    setError("");
    const ids = Array.from(blendSelected);
    const res = await fetch("/api/roasting-batches/blend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchIds: ids }),
    });
    if (!res.ok) {
      try {
        const data = await res.json();
        setError(data.error || "Failed to blend");
      } catch {
        setError("Failed to blend");
      }
      return;
    }
    setSuccess(t("batchesBlended"));
    setShowBlendForm(false);
    setBlendSelected(new Set());
    loadData();
  }

  async function handleCancelBatch(restock: boolean) {
    if (!cancelBatch) return;
    setCancelling(true);
    const res = await fetch(`/api/roasting-batches/${cancelBatch.id}?restock=${restock}`, { method: "DELETE" });
    setCancelling(false);
    if (!res.ok) {
      try { const d = await res.json(); setError(d.error || t("cancelFailed")); }
      catch { setError(t("cancelFailed")); }
    } else {
      setSuccess(t("batchCancelled"));
      setCancelBatch(null);
      loadData();
    }
  }

  const pendingItems = orders.flatMap((o: any) =>
    o.items.filter((i: any) => i.productionStatus !== "Completed" && i.productionStatus !== "Order cancelled")
      .map((i: any) => ({ ...i, order: { orderNumber: o.orderNumber, customer: { name: o.customer?.name } } }))
  );

  const passedBatches = batches.filter((b) => b.status === "Passed");
  const pendingQcBatches = batches.filter((b) => b.status === "Pending QC");
  const blendableBatches = batches.filter((b) => b.status === "Passed" || b.status === "Pending QC");

  function toExportRows(list: Batch[]): BatchExportRow[] {
    return list.map((b) => ({
      batchNumber: b.batchNumber,
      date: formatDate(b.date),
      customer: b.orderItem.order.customer.name,
      orderNumber: b.orderItem.order.orderNumber,
      beanType: b.greenBean?.beanType || b.orderItem.beanTypeName,
      greenBeanQuantity: b.greenBeanQuantity,
      roastedBeanQuantity: b.roastedBeanQuantity,
      wasteQuantity: +(b.greenBeanQuantity - b.roastedBeanQuantity).toFixed(2),
      roastProfile: b.roastProfile,
      status: b.status,
      bags3kg: b.bags3kg,
      bags1kg: b.bags1kg,
      bags250g: b.bags250g,
      bags150g: b.bags150g,
      samplesGrams: b.samplesGrams,
    }));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("production")}</h1>
          <p className="text-brown text-sm font-medium">
            {pendingItems.length} {t("pending")} | {pendingQcBatches.length} {t("awaitingQc")}
          </p>
        </div>
        {canBlend && blendableBatches.length >= 2 && (
          <button onClick={() => { setShowBlendForm(true); setBlendSelected(new Set()); setError(""); }}
            className="flex items-center gap-2 px-4 py-2.5 bg-slate text-white rounded-xl font-bold text-sm hover:bg-slate-dark transition-all duration-200 shadow-md">
            <Merge size={16} /> {t("blendBatches")}
          </button>
        )}
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl flex items-center gap-2"><AlertTriangle size={18} />{error}</div>}
      {success && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl flex items-center gap-2"><CheckCircle size={18} />{success}</div>}

      {/* Tabs */}
      <div className="flex gap-2">
        <button onClick={() => setTab("pending")}
          className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${tab === "pending" ? "bg-charcoal text-white" : "bg-white border border-border text-brown hover:border-slate"}`}>
          {t("pendingOrders")}
        </button>
        <button onClick={() => setTab("batches")}
          className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${tab === "batches" ? "bg-charcoal text-white" : "bg-white border border-border text-brown hover:border-slate"}`}>
          {t("allBatches")} ({batches.length})
        </button>
      </div>

      {tab === "pending" && (
        <div>
          {pendingItems.length === 0 ? (
            <div className="text-center py-8 bg-white rounded-2xl border border-border text-brown/40">
              <Factory size={32} className="mx-auto mb-2 opacity-50" /><p className="font-semibold">{t("noPendingItems")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {pendingItems.map((item: OrderItem) => {
                const produced = item.roastingBatches.reduce((s: number, b) => s + b.greenBeanQuantity, 0);
                const remaining = item.quantityKg - produced;
                const progress = item.quantityKg > 0 ? (produced / item.quantityKg) * 100 : 0;
                return (
                  <div key={item.id} className="bg-white rounded-2xl border border-border p-4 hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <p className="font-bold text-charcoal">#{item.order.orderNumber} — {item.order.customer.name}</p>
                        <p className="text-sm text-brown font-medium">{item.beanTypeName} — {item.quantityKg}kg {t("kgOrdered")}</p>
                      </div>
                      {canStartBatch && (
                        <button onClick={() => startProduction(item)}
                          className="px-4 py-2 bg-orange text-white rounded-xl text-sm font-bold hover:bg-orange-dark shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200">
                          {produced > 0 ? t("continueProd") : t("startProduction")}
                        </button>
                      )}
                    </div>
                    {produced > 0 && (
                      <div>
                        <div className="flex justify-between text-xs text-brown mb-1">
                          <span>{produced}kg {t("producedKg")}</span>
                          <span>{remaining}kg {t("remainingKg")}</span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-2">
                          <div className="bg-orange h-2 rounded-full transition-all" style={{ width: `${Math.min(progress, 100)}%` }} />
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2">
                          {item.roastingBatches.map((b) => {
                            const fullBatch = canEditDate
                              ? batches.find((x) => x.batchNumber === b.batchNumber)
                              : undefined;
                            return fullBatch ? (
                              <button
                                key={b.batchNumber}
                                onClick={() => setEditDateBatch(fullBatch)}
                                className="flex items-center gap-1 px-2 py-0.5 bg-cream text-brown rounded-lg text-xs font-mono hover:bg-orange/10 hover:text-orange transition-colors"
                                title={t("editDateBtn")}
                              >
                                {b.batchNumber}
                                <CalendarDays size={9} className="opacity-50" />
                              </button>
                            ) : (
                              <span key={b.batchNumber} className="px-2 py-0.5 bg-cream text-brown rounded-lg text-xs font-mono">{b.batchNumber}</span>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "batches" && (
        <div className="space-y-3">
          {batches.length > 0 && (
            <div className="flex gap-2 justify-end">
              <button onClick={() => exportBatchesPDF(toExportRows(batches))}
                className="flex items-center gap-1.5 px-3 py-2 bg-[#738995] text-white rounded-xl text-xs font-bold hover:bg-[#5f7580] shadow-sm active:scale-[0.98] transition-all">
                <FileText size={14} /> PDF
              </button>
              <button onClick={() => exportBatchesExcel(toExportRows(batches))}
                className="flex items-center gap-1.5 px-3 py-2 bg-[#E25D2F] text-white rounded-xl text-xs font-bold hover:bg-[#c94e24] shadow-sm active:scale-[0.98] transition-all">
                <FileSpreadsheet size={14} /> Excel
              </button>
            </div>
          )}
          {batches.length === 0 ? (
            <div className="text-center py-8 bg-white rounded-2xl border border-border text-brown/40">
              <Box size={32} className="mx-auto mb-2 opacity-50" /><p className="font-semibold">{t("noData")}</p>
            </div>
          ) : (
            batches.map((batch) => (
              <div key={batch.id} className="bg-white rounded-2xl border border-border p-4 hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-charcoal font-mono">{batch.batchNumber}</p>
                      {canEditDate && (
                        <button
                          onClick={() => setEditDateBatch(batch)}
                          className="p-1 rounded-lg text-brown/40 hover:text-orange hover:bg-orange/10 transition-colors"
                          title={t("editDateBtn")}
                        >
                          <CalendarDays size={13} />
                        </button>
                      )}
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${STATUS_STYLES[batch.status] || "bg-gray-100 text-gray-600"}`}>
                        {statusLabel(batch.status, t)}
                      </span>
                      {batch.blendTiming && (
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${batch.blendTiming === "Before QC" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                          {t("blendedLabel")} {batch.blendTiming === "Before QC" ? t("blendBeforeQc") : t("blendAfterQc")}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-brown font-medium">
                      #{batch.orderItem.order.orderNumber} — {batch.orderItem.order.customer.name} — {batch.greenBean?.beanType || batch.orderItem.beanTypeName}
                    </p>
                    <p className="text-xs text-brown/50 mt-0.5">
                      {batch.roastedBeanQuantity}kg {t("roastedLabel")} | {batch.greenBeanQuantity}kg {t("greenLabel")} | {formatDate(batch.date)}
                      {batch.roastProfile && ` | ${batch.roastProfile}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {canCancelBatch && (
                      <button onClick={() => setCancelBatch(batch)}
                        className="p-2 rounded-xl text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors" title="Cancel batch">
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>
                {batch.status === "Packaged" && (batch.bags3kg > 0 || batch.bags1kg > 0 || batch.bags250g > 0 || batch.bags150g > 0 || batch.samplesGrams > 0) && (
                  <div className="flex flex-wrap gap-2 mt-2 pt-2 border-t border-border">
                    {batch.bags3kg > 0 && <span className="px-2 py-0.5 bg-cream rounded-lg text-xs font-bold text-brown">{batch.bags3kg}x 3kg</span>}
                    {batch.bags1kg > 0 && <span className="px-2 py-0.5 bg-cream rounded-lg text-xs font-bold text-brown">{batch.bags1kg}x 1kg</span>}
                    {batch.bags250g > 0 && <span className="px-2 py-0.5 bg-cream rounded-lg text-xs font-bold text-brown">{batch.bags250g}x 250g</span>}
                    {batch.bags150g > 0 && <span className="px-2 py-0.5 bg-cream rounded-lg text-xs font-bold text-brown">{batch.bags150g}x 150g</span>}
                    {batch.samplesGrams > 0 && <span className="px-2 py-0.5 bg-cream rounded-lg text-xs font-bold text-brown">{batch.samplesGrams}g {t("samplesGramsLabel")}</span>}
                  </div>
                )}
                {batch.childBatches.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border">
                    <p className="text-xs text-brown/50">{t("sourceBatches")}: {batch.childBatches.map((c) => c.batchNumber).join(", ")}</p>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Roast Form Modal */}
      {showRoastForm && selectedItem && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowRoastForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-extrabold text-charcoal mb-1">{t("recordRoastTitle")}</h2>
            <p className="text-sm text-brown font-medium mb-4">#{selectedItem.order.orderNumber} — {selectedItem.beanTypeName}</p>
            <p className="text-xs text-brown/50 mb-4">{t("snAutoGenerated")}</p>
            <form onSubmit={handleRoastSubmit} className="space-y-3">
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1">{t("greenBeanSource")}</label>
                <select value={roastForm.greenBeanId} onChange={(e) => setRoastForm({ ...roastForm, greenBeanId: e.target.value })}
                  className="w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors">
                  <option value="">{t("selectBeanStock")}</option>
                  {beans.map((b) => (
                    <option key={b.id} value={b.id}>{b.beanType} ({b.serialNumber}) — {b.quantityKg}kg</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1">{t("greenBeanQty")}</label>
                  <input type="number" step="0.01" value={roastForm.greenBeanQuantity}
                    onChange={(e) => setRoastForm({ ...roastForm, greenBeanQuantity: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required />
                </div>
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1">{t("roastedQty")}</label>
                  <input type="number" step="0.01" value={roastForm.roastedBeanQuantity}
                    onChange={(e) => setRoastForm({ ...roastForm, roastedBeanQuantity: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required />
                </div>
              </div>
              {(() => {
                const roastedExceeds = roastForm.roastedBeanQuantity > roastForm.greenBeanQuantity && roastForm.greenBeanQuantity > 0;
                return (
                  <>
                    {roastedExceeds && (
                      <div className="text-sm font-bold px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700">
                        {t("roastedExceedsGreen")}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-bold text-charcoal mb-1">{t("wasteKg")}</label>
                        <input type="number" step="0.01"
                          value={Math.max(0, +(roastForm.greenBeanQuantity - roastForm.roastedBeanQuantity).toFixed(2))}
                          readOnly className="w-full px-3 py-2.5 border-2 border-border rounded-xl bg-cream/50 text-brown outline-none" />
                      </div>
                      <div>
                        <label className="block text-sm font-bold text-charcoal mb-1">{t("roastProfileLabel")}</label>
                        <input type="text" value={roastForm.roastProfile}
                          onChange={(e) => setRoastForm({ ...roastForm, roastProfile: e.target.value })}
                          className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" placeholder={t("roastProfilePlaceholder")} />
                      </div>
                    </div>
                    <div className="flex gap-3 pt-2">
                      <button type="submit" disabled={roastedExceeds}
                        className={`flex-1 py-3 rounded-xl font-bold shadow-md active:scale-[0.98] transition-all duration-200 ${roastedExceeds ? "bg-gray-300 text-gray-500 cursor-not-allowed shadow-none" : "bg-orange text-white hover:bg-orange-dark shadow-orange/20"}`}>
                        {t("recordBatch")}
                      </button>
                      <button type="button" onClick={() => setShowRoastForm(false)} className="flex-1 py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
                        {t("cancel")}
                      </button>
                    </div>
                  </>
                );
              })()}
            </form>
          </div>
        </div>
      )}

      {/* Blend Form Modal */}
      {showBlendForm && (() => {
        const selectedBatches = blendableBatches.filter((b) => blendSelected.has(b.id));
        const selectedStatuses = new Set(selectedBatches.map((b) => b.status));
        const isMixed = selectedStatuses.size > 1;
        const blendType = selectedStatuses.size === 1
          ? (selectedStatuses.has("Pending QC") ? "Before QC" : "After QC")
          : null;
        const canSubmit = blendSelected.size >= 2 && !isMixed;
        return (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowBlendForm(false)}>
            <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-lg font-extrabold text-charcoal mb-1">{t("blendBatches")}</h2>
              <p className="text-sm text-brown font-medium mb-4">{t("blendSelectHint")}</p>
              <div className="space-y-2 mb-4">
                {blendableBatches.map((batch) => {
                  const selected = blendSelected.has(batch.id);
                  return (
                    <div key={batch.id}
                      onClick={() => toggleBlendBatch(batch.id)}
                      className={`p-3 rounded-xl border-2 cursor-pointer transition-all ${selected ? "border-orange bg-orange/5" : "border-border hover:border-slate/30"}`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-bold text-charcoal font-mono text-sm">{batch.batchNumber}</p>
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${STATUS_STYLES[batch.status]}`}>
                              {statusLabel(batch.status, t)}
                            </span>
                          </div>
                          <p className="text-xs text-brown">{batch.greenBean?.beanType || batch.orderItem.beanTypeName} — {batch.roastedBeanQuantity}kg</p>
                        </div>
                        <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${selected ? "bg-orange border-orange" : "border-gray-300"}`}>
                          {selected && <CheckCircle size={14} className="text-white" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {isMixed && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-xl text-xs font-bold mb-4">
                  {t("cannotMixStatuses")}
                </div>
              )}
              {blendSelected.size >= 2 && !isMixed && (
                <div className={`rounded-xl p-3 mb-4 border ${blendType === "Before QC" ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200"}`}>
                  <p className="text-xs font-bold text-charcoal mb-1">
                    {t("blendPreview")} — <span className={blendType === "Before QC" ? "text-amber-700" : "text-emerald-700"}>{blendType === "Before QC" ? t("blendBeforeQc") : t("blendAfterQc")}</span>
                  </p>
                  <p className="text-xs text-brown">
                    {blendSelected.size} batches | {t("totalRoasted")}: {selectedBatches.reduce((s, b) => s + b.roastedBeanQuantity, 0)}kg
                    {blendType === "Before QC" && ` — ${t("blendNeedQc")}`}
                    {blendType === "After QC" && ` — ${t("blendToPackaging")}`}
                  </p>
                </div>
              )}
              <div className="flex gap-3">
                <button onClick={handleBlend} disabled={!canSubmit}
                  className="flex-1 py-3 bg-slate text-white rounded-xl font-bold hover:bg-slate-dark shadow-md disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] transition-all duration-200">
                  {t("blendBatches")} ({blendSelected.size})
                </button>
                <button onClick={() => setShowBlendForm(false)} className="flex-1 py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
                  {t("cancel")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Cancel Batch Modal */}
      {cancelBatch && (() => {
        const isPendingQc = cancelBatch.status === "Pending QC";
        const hasBean = !!cancelBatch.greenBean;
        return (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => !cancelling && setCancelBatch(null)}>
            <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-red-100 rounded-xl"><Trash2 size={20} className="text-red-600" /></div>
                <div>
                  <h2 className="font-extrabold text-charcoal">{t("cancelBatchTitle")}</h2>
                  <p className="text-sm text-brown font-mono">{cancelBatch.batchNumber}</p>
                </div>
              </div>

              {isPendingQc ? (
                <>
                  <p className="text-sm text-brown mb-5">{t("cancelBatchMsgPre")}</p>
                  <div className="flex gap-3">
                    <button onClick={() => handleCancelBatch(true)} disabled={cancelling}
                      className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 disabled:opacity-50 active:scale-[0.98] transition-all">
                      {cancelling ? "…" : t("cancelConfirmRestock")}
                    </button>
                    <button onClick={() => setCancelBatch(null)} disabled={cancelling}
                      className="flex-1 py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
                      {t("cancel")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-brown mb-5">{t("cancelBatchMsgPost")}</p>
                  <div className="flex flex-col gap-2">
                    <button onClick={() => handleCancelBatch(false)} disabled={cancelling}
                      className="w-full py-3 bg-charcoal text-white rounded-xl font-bold hover:bg-charcoal/80 disabled:opacity-50 active:scale-[0.98] transition-all">
                      {cancelling ? "…" : t("cancelMarkWasted")}
                    </button>
                    {hasBean && (
                      <button onClick={() => handleCancelBatch(true)} disabled={cancelling || !canOverrideInventory}
                        title={!canOverrideInventory ? t("noOverridePermission") : undefined}
                        className="w-full py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] transition-all">
                        {cancelling ? "…" : t("cancelRestock")}
                      </button>
                    )}
                    <button onClick={() => setCancelBatch(null)} disabled={cancelling}
                      className="w-full py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
                      {t("cancel")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Edit Date Modal */}
      {editDateBatch && (
        <EditDateModal
          batch={editDateBatch}
          onClose={() => setEditDateBatch(null)}
          onSuccess={({ newBatchNumber, parentBatchId, newParentBatchNumber }) => {
            setBatches((prev) =>
              prev.map((b) => {
                if (b.id === editDateBatch.id) return { ...b, batchNumber: newBatchNumber };
                if (parentBatchId && b.id === parentBatchId && newParentBatchNumber)
                  return { ...b, batchNumber: newParentBatchNumber };
                return b;
              })
            );
            const msg = newParentBatchNumber
              ? `${t("dateUpdatedMsg")} ${newBatchNumber}. ${t("blendAlsoUpdated")}`
              : `${t("dateUpdatedMsg")} ${newBatchNumber}`;
            setSuccess(msg);
            setEditDateBatch(null);
          }}
        />
      )}
    </div>
  );
}
