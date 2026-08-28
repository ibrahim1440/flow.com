"use client";

import { useState, useEffect, useMemo } from "react";
import { AlertTriangle, Box, Package, Trash2, CalendarDays } from "lucide-react";
import EditDateModal, { type EditableBatch } from "@/components/EditDateModal";
import WorkflowFilterBar, { type FilterOption } from "@/components/WorkflowFilterBar";
import { formatDate } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";

type Batch = {
  id: string; batchNumber: string; date: string; status: string;
  productId: string | null;
  greenBeanQuantity: number; roastedBeanQuantity: number;
  roastProfile: string | null; blendTiming: string | null;
  bags3kg: number; bags1kg: number; bags250g: number; bags150g: number; samplesGrams: number;
  parentBatchId: string | null;
  parentBatch: { id: string; batchNumber: string } | null;
  greenBean: { beanType: string } | null;
  // Nullable since roast-to-stock: a batch roasted for the shelf has no order behind it.
  orderItem: { beanTypeName: string; productId: string | null; productSkuId: string | null; order: { orderNumber: number; customer: { name: string } } } | null;
};

type ProductSummary = {
  id: string;
  productNameEn: string;
  productNameAr: string | null;
  productSkus: { id: string; skuCode: string; weightGrams: number }[];
};

function packagedKg(b: { bags3kg: number; bags1kg: number; bags250g: number; bags150g: number; samplesGrams: number }) {
  return +(b.bags3kg * 3 + b.bags1kg * 1 + b.bags250g * 0.25 + b.bags150g * 0.15 + b.samplesGrams / 1000).toFixed(3);
}

function isBulkCustom(batch: Batch): boolean {
  return !batch.productId && !(batch.orderItem?.productId ?? null);
}

export default function PackagingPage() {
  const user = useUser();
  const { t } = useI18n();
  const canCancelBatch = hasSubPrivilege(user?.permissions ?? {}, "production", "cancel_batch");
  const canEditDate = hasSubPrivilege(user?.permissions ?? {}, "production", "edit_date");
  const canOverrideInventory = hasSubPrivilege(user?.permissions ?? {}, "inventory", "override");
  const lang = user?.preferredLanguage ?? "ar";

  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [cancelBatch, setCancelBatch] = useState<Batch | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [editDateBatch, setEditDateBatch] = useState<EditableBatch | null>(null);

  // Filter state
  const [filterSearch, setFilterSearch] = useState("");
  const [filterBean, setFilterBean] = useState("");
  const [filterOrder, setFilterOrder] = useState("");

  // Batch serial superseded lookup
  const [serialLookup, setSerialLookup] = useState<{
    found: boolean;
    query: string;
    currentMatches: { id: string; batchNumber: string; date: string; status: string; beanType: string | null }[];
    superseded: { oldBatchNumber: string; newBatchNumber: string; batchId: string; currentBatchNumber: string | null; date: string | null; status: string | null; beanType: string | null; changedAt: string; reason: string | null }[];
  } | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [form, setForm] = useState({ bags3kg: 0, bags1kg: 0, bags250g: 0, bags150g: 0, samplesGrams: 0 });
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [selectedSkuId, setSelectedSkuId] = useState("");

  useEffect(() => { loadData(); loadProducts(); }, []);

  useEffect(() => {
    const q = filterSearch.trim();
    if (q.length < 8 || !/^\d+$/.test(q)) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/roasting-batches/serial-lookup?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (res.ok) setSerialLookup(await res.json());
        else setSerialLookup(null);
      } catch {
        // aborted or network error — silently ignore
      }
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [filterSearch]);

  async function loadData() {
    const res = await fetch("/api/roasting-batches?statuses=Passed,Partially+Packaged");
    if (res.ok) setBatches(await res.json());
    setLoading(false);
  }

  async function loadProducts() {
    const res = await fetch("/api/coffee-products/summary");
    if (res.ok) setProducts(await res.json());
  }

  function openPackage(batch: Batch) {
    setSelectedBatch(batch);
    setForm({ bags3kg: 0, bags1kg: 0, bags250g: 0, bags150g: 0, samplesGrams: 0 });
    setSelectedProductId("");
    setSelectedSkuId("");
    setError(""); setSuccess("");
    setShowForm(true);
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const requestBody: Record<string, unknown> = { ...form };
    if (isBulkCustom(selectedBatch!)) {
      requestBody.productId = selectedProductId;
      if (selectedSkuId) requestBody.productSkuId = selectedSkuId;
    }
    const res = await fetch(`/api/roasting-batches/${selectedBatch!.id}/package`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) {
      try {
        const data = await res.json();
        setError(data.error || "Failed to package");
      } catch {
        setError("Failed to package");
      }
      return;
    }
    setSuccess(t("packagingRecorded"));
    setShowForm(false);
    loadData();
  }

  const beanOptions = useMemo<FilterOption[]>(() => {
    const seen = new Set<string>();
    const opts: FilterOption[] = [];
    for (const b of batches) {
      const v = b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? "");
      if (!seen.has(v)) { seen.add(v); opts.push({ label: v, value: v }); }
    }
    return opts;
  }, [batches]);

  const orderOptions = useMemo<FilterOption[]>(() => {
    const seen = new Set<string>();
    const opts: FilterOption[] = [];
    for (const b of batches) {
      const v = String((b.orderItem?.order.orderNumber ?? t("stockBatchLabel")));
      if (!seen.has(v)) { seen.add(v); opts.push({ label: `#${v} – ${(b.orderItem?.order.customer.name ?? t("stockBatchLabel"))}`, value: v }); }
    }
    return opts;
  }, [batches, t]);

  const filteredBatches = useMemo(() => {
    const q = filterSearch.toLowerCase();
    return batches.filter((b) => {
      const beanType = b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? "");
      if (filterBean && beanType !== filterBean) return false;
      if (filterOrder && String((b.orderItem?.order.orderNumber ?? t("stockBatchLabel"))) !== filterOrder) return false;
      if (q) {
        const haystack = `${b.batchNumber} ${(b.orderItem?.order.orderNumber ?? t("stockBatchLabel"))} ${(b.orderItem?.order.customer.name ?? t("stockBatchLabel"))} ${beanType}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [batches, filterSearch, filterBean, filterOrder, t]);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="w-10 h-10 border-4 border-orange border-t-transparent rounded-full animate-spin" /></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-charcoal">{t("packaging")}</h1>
        <p className="text-brown text-sm font-medium">{batches.length} {t("batchesReadyPackage")}</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl flex items-center gap-2 text-sm font-bold">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-success-bg border border-green-200 text-green-700 px-4 py-3 rounded-xl flex items-center gap-2 text-sm font-bold">
          {success}
        </div>
      )}

      {batches.length > 0 && (
        <WorkflowFilterBar
          searchQuery={filterSearch} onSearchChange={setFilterSearch}
          beanOptions={beanOptions} selectedBean={filterBean} onBeanChange={setFilterBean}
          orderOptions={orderOptions} selectedOrder={filterOrder} onOrderChange={setFilterOrder}
          resultCount={filteredBatches.length} totalCount={batches.length}
        />
      )}

      {serialLookup?.query === filterSearch.trim() && serialLookup.superseded.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
          <p className="flex items-center gap-1.5 text-amber-800 text-xs font-bold uppercase tracking-wide">
            <AlertTriangle size={12} />
            {lang === "ar" ? "الرقم التسلسلي تم استبداله" : "Batch serial superseded"}
          </p>
          {serialLookup.superseded.map((s, i) => (
            <p key={i} className="text-xs text-amber-800 leading-relaxed">
              {lang === "ar" ? (
                <>
                  الرقم <span className="font-mono font-bold">{s.oldBatchNumber}</span> تم استبداله بـ{" "}
                  <span className="font-mono font-bold">{s.newBatchNumber}</span>
                  {s.beanType && <> · <span className="text-amber-600">{s.beanType}</span></>}
                  {s.reason && <> · {s.reason}</>}
                </>
              ) : (
                <>
                  Batch serial <span className="font-mono font-bold">{s.oldBatchNumber}</span> has been superseded by{" "}
                  <span className="font-mono font-bold">{s.newBatchNumber}</span>
                  {s.beanType && <> · <span className="text-amber-600">{s.beanType}</span></>}
                  {s.reason && <> · <span className="italic">{s.reason}</span></>}
                </>
              )}
            </p>
          ))}
        </div>
      )}
      {filteredBatches.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl border border-border text-brown/40">
          <Box size={40} className="mx-auto mb-3 opacity-50" />
          <p className="font-semibold text-lg">{t("noBatchesToPackage")}</p>
          <p className="text-sm mt-1">{t("batchesAfterQc")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredBatches.map((batch) => {
            const packed = packagedKg(batch);
            const total = batch.roastedBeanQuantity;
            const pct = total > 0 ? Math.min((packed / total) * 100, 100) : 0;
            const remaining = +(total - packed).toFixed(3);
            return (
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
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${batch.status === "Partially Packaged" ? "bg-amber-100 text-amber-800" : "bg-info-bg text-slate"}`}>
                        {batch.status === "Partially Packaged" ? t("statusPartiallyPkg") : t("statusPassed")}
                      </span>
                      {batch.blendTiming && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800">
                          {t("blendedLabel")} {batch.blendTiming}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-brown font-medium">
                      #{(batch.orderItem?.order.orderNumber ?? t("stockBatchLabel"))} — {(batch.orderItem?.order.customer.name ?? t("stockBatchLabel"))} — {batch.greenBean?.beanType || (batch.orderItem?.beanTypeName ?? "")}
                    </p>
                    <p className="text-xs text-brown/50 mt-0.5">
                      {batch.roastedBeanQuantity}kg {t("roastedLabel")} | {batch.greenBeanQuantity}kg {t("greenLabel")} | {formatDate(batch.date)}
                      {batch.roastProfile && ` | ${batch.roastProfile}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {canCancelBatch && (
                      <button onClick={() => setCancelBatch(batch)}
                        className="p-2 rounded-xl text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors" title="Cancel batch">
                        <Trash2 size={16} />
                      </button>
                    )}
                    <button onClick={() => openPackage(batch)}
                      className="flex items-center gap-1.5 px-4 py-2.5 bg-orange text-white rounded-xl text-sm font-bold hover:bg-orange-dark shadow-md shadow-orange/20 active:scale-[0.98] transition-all">
                      <Package size={16} /> {batch.status === "Partially Packaged" ? t("continueProd") : t("packageBtn")}
                    </button>
                  </div>
                </div>
                {/* Progress bar */}
                <div className="mt-2">
                  <div className="flex justify-between text-xs font-bold mb-1">
                    <span className="text-brown">{packed}kg / {total}kg {t("statusPackaged")}</span>
                    {remaining > 0 && <span className="text-brown/50">{remaining}kg {t("remainingKg")}</span>}
                  </div>
                  <div className="w-full bg-muted rounded-full h-2.5">
                    <div
                      className={`h-2.5 rounded-full transition-all duration-500 ${pct >= 99.5 ? "bg-green-500" : pct > 0 ? "bg-orange" : "bg-gray-300"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                {/* Existing bags summary */}
                {packed > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2 pt-2 border-t border-border">
                    {batch.bags3kg > 0 && <span className="px-2 py-0.5 bg-cream rounded-lg text-xs font-bold text-brown">{batch.bags3kg}x 3kg</span>}
                    {batch.bags1kg > 0 && <span className="px-2 py-0.5 bg-cream rounded-lg text-xs font-bold text-brown">{batch.bags1kg}x 1kg</span>}
                    {batch.bags250g > 0 && <span className="px-2 py-0.5 bg-cream rounded-lg text-xs font-bold text-brown">{batch.bags250g}x 250g</span>}
                    {batch.bags150g > 0 && <span className="px-2 py-0.5 bg-cream rounded-lg text-xs font-bold text-brown">{batch.bags150g}x 150g</span>}
                    {batch.samplesGrams > 0 && <span className="px-2 py-0.5 bg-cream rounded-lg text-xs font-bold text-brown">{batch.samplesGrams}g {t("samplesGramsLabel")}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showForm && selectedBatch && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-extrabold text-charcoal mb-1">{t("packageBatchTitle")}</h2>
            <p className="text-sm text-brown font-medium mb-1">{selectedBatch.batchNumber} — {selectedBatch.greenBean?.beanType || (selectedBatch.orderItem?.beanTypeName ?? "")}</p>
            {(() => {
              const alreadyPacked = packagedKg(selectedBatch);
              const remainingCapacity = +(selectedBatch.roastedBeanQuantity - alreadyPacked).toFixed(3);
              const addingKg = +(form.bags3kg * 3 + form.bags1kg * 1 + form.bags250g * 0.25 + form.bags150g * 0.15 + form.samplesGrams / 1000).toFixed(3);
              const newTotalKg = +(alreadyPacked + addingKg).toFixed(3);
              const exceeded = addingKg > remainingCapacity + 0.1;
              const empty = addingKg === 0;
              const needsProduct = isBulkCustom(selectedBatch!);
              const invalid = exceeded || empty || (needsProduct && !selectedProductId);
              const newPct = selectedBatch.roastedBeanQuantity > 0 ? Math.min((newTotalKg / selectedBatch.roastedBeanQuantity) * 100, 100) : 0;
              return (
                <>
                  {alreadyPacked > 0 && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mb-2 font-bold">
                      {t("alreadyPackaged")} {alreadyPacked}kg — {t("remainingCapacity")} {remainingCapacity}kg
                    </p>
                  )}
                  {alreadyPacked === 0 && (
                    <p className="text-xs text-brown/50 mb-2">{selectedBatch.roastedBeanQuantity}kg {t("availableToPackage")}</p>
                  )}
                  {/* Live progress bar */}
                  <div className="mb-4">
                    <div className="w-full bg-muted rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all duration-300 ${newPct >= 99.5 ? "bg-green-500" : newPct > 0 ? "bg-orange" : "bg-gray-300"}`}
                        style={{ width: `${newPct}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-brown/50 mt-1 text-end">{newTotalKg}kg / {selectedBatch.roastedBeanQuantity}kg</p>
                  </div>
                  <form onSubmit={handleSubmit} className="space-y-3">
                    {needsProduct && (
                      <div className="space-y-3 pb-3 border-b border-border">
                        <div>
                          <label className="block text-sm font-bold text-charcoal mb-1">
                            Product <span className="text-red-500">*</span>
                          </label>
                          <select value={selectedProductId}
                            onChange={(e) => { setSelectedProductId(e.target.value); setSelectedSkuId(""); }}
                            className="w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors">
                            <option value="">Select product…</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {lang === "ar" && p.productNameAr ? p.productNameAr : p.productNameEn}
                              </option>
                            ))}
                          </select>
                        </div>
                        {selectedProductId && (products.find((p) => p.id === selectedProductId)?.productSkus.length ?? 0) > 0 && (
                          <div>
                            <label className="block text-sm font-bold text-charcoal mb-1">
                              SKU <span className="text-brown/50 font-normal text-xs">(optional)</span>
                            </label>
                            <select value={selectedSkuId} onChange={(e) => setSelectedSkuId(e.target.value)}
                              className="w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors">
                              <option value="">No specific SKU</option>
                              {products.find((p) => p.id === selectedProductId)?.productSkus.map((sku) => (
                                <option key={sku.id} value={sku.id}>
                                  {sku.skuCode} ({sku.weightGrams >= 1000 ? `${sku.weightGrams / 1000}kg` : `${sku.weightGrams}g`})
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      {([
                        { key: "bags3kg", label: "3kg bags" },
                        { key: "bags1kg", label: "1kg bags" },
                        { key: "bags250g", label: "250g bags" },
                        { key: "bags150g", label: "150g bags" },
                      ] as const).map(({ key, label }) => (
                        <div key={key}>
                          <label className="block text-sm font-bold text-charcoal mb-1">{label}</label>
                          <input type="number" value={form[key]}
                            onChange={(e) => setForm({ ...form, [key]: parseInt(e.target.value) || 0 })}
                            className="w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
                        </div>
                      ))}
                    </div>
                    <div>
                      <label className="block text-sm font-bold text-charcoal mb-1">{t("samplesGramsLabel")}</label>
                      <input type="number" step="0.1" value={form.samplesGrams}
                        onChange={(e) => setForm({ ...form, samplesGrams: parseFloat(e.target.value) || 0 })}
                        className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
                    </div>
                    <div className={`text-sm font-bold px-3 py-2 rounded-xl ${exceeded ? "bg-red-50 border border-red-200 text-red-700" : empty ? "bg-amber-50 border border-amber-200 text-amber-700" : "bg-cream text-brown"}`}>
                      {t("addingLabel")} {addingKg}kg → {t("total")}: {newTotalKg}kg / {selectedBatch.roastedBeanQuantity}kg
                      {exceeded && ` — ${t("exceedsCapacity")}`}
                      {empty && ` — ${t("enterAtLeastOne")}`}
                    </div>
                    <div className="flex gap-3 pt-2">
                      <button type="submit" disabled={invalid}
                        className={`flex-1 py-3 rounded-xl font-bold shadow-md active:scale-[0.98] transition-all duration-200 ${invalid ? "bg-gray-300 text-gray-500 cursor-not-allowed shadow-none" : "bg-orange text-white hover:bg-orange-dark shadow-orange/20"}`}>
                        {t("confirmPackaging")}
                      </button>
                      <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
                        {t("cancel")}
                      </button>
                    </div>
                  </form>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Cancel Batch Modal */}
      {cancelBatch && (() => {
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
