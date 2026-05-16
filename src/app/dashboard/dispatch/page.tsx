"use client";

import { useState, useEffect, useMemo } from "react";
import { Truck, Search, AlertTriangle, Info, Layers } from "lucide-react";
import WorkflowFilterBar, { type FilterOption } from "@/components/WorkflowFilterBar";
import { formatDate } from "@/lib/utils";
import { useUser } from "../layout";
import { hasSubPrivilege } from "@/lib/auth";
import { useI18n } from "@/lib/i18n/context";

// ─── Types ────────────────────────────────────────────────────────────────────

type BatchSlim = {
  status: string;
  bags3kg: number; bags1kg: number; bags250g: number; bags150g: number; samplesGrams: number;
};

type OrderItem = {
  id: string;
  beanTypeName: string;
  quantityKg: number;
  productionStatus: string;
  deliveryStatus: string;
  deliveredQty: number;
  remainingQty: number;
  productId: string | null;
  roastingBatches: BatchSlim[];
  order: { orderNumber: number; customer: { name: string } };
};

type FGLot = {
  id: string;
  batchNumber: string;
  quantityKg: number;
  availableQty: number;
  productId: string;
  product: { productNameEn: string; productNameAr: string | null };
  status: string;
};

type DeliveryRow = {
  id: string;
  date: string;
  quantityKg: number;
  deliveryType: string;
  orderItem: { beanTypeName: string; order: { orderNumber: number; customer: { name: string } } };
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function packagedKg(batches: BatchSlim[]): number {
  return +(batches
    .filter((b) => b.status === "Packaged" || b.status === "Partially Packaged")
    .reduce((sum, b) => sum + b.bags3kg * 3 + b.bags1kg * 1 + b.bags250g * 0.25 + b.bags150g * 0.15 + b.samplesGrams / 1000, 0)
    .toFixed(3));
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DispatchPage() {
  const { t, lang } = useI18n();
  const user = useUser();
  const canDeliver = hasSubPrivilege(user?.permissions ?? {}, "dispatch", "mark_delivered");

  // ── Core data ─────────────────────────────────────────────────────────────
  const [orders,     setOrders]     = useState<{ items: OrderItem[] }[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);

  // ── Filter state ──────────────────────────────────────────────────────────
  const [search,      setSearch]      = useState("");
  const [readySearch, setReadySearch] = useState("");
  const [readyBean,   setReadyBean]   = useState("");
  const [readyOrder,  setReadyOrder]  = useState("");

  // ── Delivery modal state ──────────────────────────────────────────────────
  const [showForm,      setShowForm]      = useState(false);
  const [selectedItem,  setSelectedItem]  = useState<OrderItem | null>(null);
  const [form,          setForm]          = useState({ quantityKg: 0, deliveryType: "full", notes: "" });
  const [lotId,         setLotId]         = useState("");
  const [lots,          setLots]          = useState<FGLot[]>([]);
  const [lotsLoading,   setLotsLoading]   = useState(false);
  const [submitError,   setSubmitError]   = useState("");
  const [submitting,    setSubmitting]    = useState(false);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => { loadData(); }, []);

  async function loadData() {
    const [ordersRes, delRes] = await Promise.all([fetch("/api/orders"), fetch("/api/deliveries")]);
    if (ordersRes.ok) setOrders(await ordersRes.json());
    if (delRes.ok)    setDeliveries(await delRes.json());
  }

  // ── Open delivery modal ───────────────────────────────────────────────────
  async function startDelivery(item: OrderItem) {
    const available = Math.max(0, +(packagedKg(item.roastingBatches) - item.deliveredQty).toFixed(3));
    setSelectedItem(item);
    setForm({
      quantityKg:   available,
      deliveryType: available >= item.quantityKg ? "full" : "partial",
      notes:        "",
    });
    setLotId("");
    setSubmitError("");
    setShowForm(true);

    // Fetch available finished goods lots in parallel with modal open
    setLotsLoading(true);
    try {
      const res = await fetch("/api/finished-goods-lots");
      if (res.ok) {
        const data: FGLot[] = await res.json();
        setLots(data.filter((l) => l.status === "AVAILABLE" && l.availableQty > 0));
      }
    } finally {
      setLotsLoading(false);
    }
  }

  function closeModal() {
    setShowForm(false);
    setSelectedItem(null);
    setLots([]);
    setLotId("");
    setSubmitError("");
  }

  // ── Submit delivery ───────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError("");
    setSubmitting(true);
    const res = await fetch("/api/deliveries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderItemId:        selectedItem!.id,
        quantityKg:         form.quantityKg,
        deliveryType:       form.deliveryType,
        notes:              form.notes || null,
        finishedGoodsLotId: lotId || null,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setSubmitError(data.error || "Delivery failed");
      return;
    }
    closeModal();
    loadData();
  }

  // ── Ready items list ──────────────────────────────────────────────────────
  const readyItems = orders.flatMap((o: any) =>
    o.items
      .filter((i: any) => i.deliveryStatus !== "Delivered" && packagedKg(i.roastingBatches) > i.deliveredQty)
      .map((i: any) => ({ ...i, order: { orderNumber: o.orderNumber, customer: { name: o.customer?.name } } }))
  );

  const readyBeanOptions = useMemo<FilterOption[]>(() => {
    const seen = new Set<string>();
    const opts: FilterOption[] = [];
    for (const item of readyItems) {
      if (!seen.has(item.beanTypeName)) { seen.add(item.beanTypeName); opts.push({ label: item.beanTypeName, value: item.beanTypeName }); }
    }
    return opts;
  }, [readyItems]);

  const readyOrderOptions = useMemo<FilterOption[]>(() => {
    const seen = new Set<string>();
    const opts: FilterOption[] = [];
    for (const item of readyItems) {
      const v = String(item.order.orderNumber);
      if (!seen.has(v)) { seen.add(v); opts.push({ label: `#${v} – ${item.order.customer.name}`, value: v }); }
    }
    return opts;
  }, [readyItems]);

  const filteredReadyItems = useMemo(() => {
    const q = readySearch.toLowerCase();
    return readyItems.filter((item: OrderItem) => {
      if (readyBean && item.beanTypeName !== readyBean) return false;
      if (readyOrder && String(item.order.orderNumber) !== readyOrder) return false;
      if (q && !`${item.order.orderNumber} ${item.order.customer.name} ${item.beanTypeName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [readyItems, readySearch, readyBean, readyOrder]);

  // ── Lot selection derived state ───────────────────────────────────────────
  const selectedLot     = lots.find((l) => l.id === lotId) ?? null;
  const lotExceedsQty   = selectedLot !== null && form.quantityKg > selectedLot.availableQty;
  const canSubmit       = !!lotId && !lotExceedsQty && !submitting;

  // Split lots: matching product first, others below (using optgroup)
  const matchingLots = selectedItem?.productId
    ? lots.filter((l) => l.productId === selectedItem.productId)
    : [];
  const otherLots = selectedItem?.productId
    ? lots.filter((l) => l.productId !== selectedItem.productId)
    : lots;

  function lotLabel(lot: FGLot) {
    const productLabel = lang === "ar" ? (lot.product.productNameAr ?? lot.product.productNameEn) : lot.product.productNameEn;
    return `${lot.batchNumber} — ${productLabel} — ${t("lotAvailableKg")}: ${lot.availableQty.toFixed(1)} kg`;
  }

  return (
    <div className="space-y-6">

      {/* ── Page header ── */}
      <div>
        <h1 className="text-2xl font-extrabold text-charcoal">{t("dispatchTitle")}</h1>
        <p className="text-brown text-sm font-medium">{readyItems.length} {t("itemsReadyDelivery")}</p>
      </div>

      {/* ── Ready for delivery ── */}
      <div>
        <h2 className="font-semibold text-charcoal mb-3">{t("readyForDelivery")}</h2>
        {readyItems.length > 0 && (
          <div className="mb-3">
            <WorkflowFilterBar
              searchQuery={readySearch} onSearchChange={setReadySearch}
              beanOptions={readyBeanOptions} selectedBean={readyBean} onBeanChange={setReadyBean}
              orderOptions={readyOrderOptions} selectedOrder={readyOrder} onOrderChange={setReadyOrder}
              resultCount={filteredReadyItems.length} totalCount={readyItems.length}
            />
          </div>
        )}
        {filteredReadyItems.length === 0 ? (
          <div className="text-center py-8 bg-white rounded-2xl border border-border text-muted-foreground">
            <Truck size={32} className="mx-auto mb-2" /><p>{t("noItemsDelivery")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredReadyItems.map((item) => {
              const packed    = packagedKg(item.roastingBatches);
              const available = Math.max(0, +(packed - item.deliveredQty).toFixed(3));
              return (
                <div key={item.id} className="bg-white rounded-2xl border border-border p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-semibold">#{item.order.orderNumber} — {item.order.customer.name}</p>
                    <p className="text-sm text-brown font-medium">{item.beanTypeName} — {item.quantityKg}kg {t("kgOrdered")}</p>
                    <p className="text-xs text-brown/70 mt-0.5">
                      {t("packaged")}: {packed}kg · {t("availableForDelivery")}: {available}kg
                    </p>
                    {item.deliveredQty > 0 && (
                      <div className="mt-1">
                        <div className="w-48 bg-muted rounded-full h-1.5">
                          <div className="bg-success h-1.5 rounded-full" style={{ width: `${Math.min(100, (item.deliveredQty / packed) * 100)}%` }} />
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{item.deliveredQty}kg {t("deliveredKgLabel")}</p>
                      </div>
                    )}
                  </div>
                  {canDeliver && (
                    <button
                      onClick={() => startDelivery(item)}
                      className="shrink-0 px-4 py-2 bg-orange text-white rounded-lg text-sm hover:bg-orange-dark flex items-center gap-2 shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200 font-bold"
                    >
                      <Truck size={16} /> {t("deliver")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Delivery history ── */}
      <div>
        <h2 className="font-semibold text-charcoal mb-3">{t("deliveryHistory")}</h2>
        <div className="relative mb-3">
          <Search size={18} className="absolute ltr:left-3 rtl:right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text" placeholder={t("searchDeliveries")} value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full ltr:pl-10 rtl:pr-10 pr-4 py-2.5 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
          />
        </div>
        <div className="bg-white rounded-2xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-cream">
              <tr>
                <th className="text-start px-4 py-3 font-semibold">{t("date")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("orderCol")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("customer")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("beanCol")}</th>
                <th className="text-end px-4 py-3 font-semibold">{t("qtyKg")}</th>
                <th className="text-center px-4 py-3 font-semibold">{t("type")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {deliveries
                .filter((d) =>
                  `${d.orderItem.order.orderNumber} ${d.orderItem.order.customer.name} ${d.orderItem.beanTypeName}`
                    .toLowerCase().includes(search.toLowerCase())
                )
                .map((d) => (
                  <tr key={d.id} className="hover:bg-cream/50">
                    <td className="px-4 py-3 text-brown">{formatDate(d.date)}</td>
                    <td className="px-4 py-3">#{d.orderItem.order.orderNumber}</td>
                    <td className="px-4 py-3">{d.orderItem.order.customer.name}</td>
                    <td className="px-4 py-3">{d.orderItem.beanTypeName}</td>
                    <td className="px-4 py-3 text-end font-medium">{d.quantityKg}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`status-badge ${d.deliveryType === "full" ? "status-completed" : "status-partial"}`}>
                        {d.deliveryType === "full" ? t("fullBadge") : t("partialBadge")}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════
          DELIVERY MODAL
          ════════════════════════════════════════════════════════════ */}
      {canDeliver && showForm && selectedItem && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={closeModal}
        >
          <div
            className="bg-white rounded-2xl p-6 w-full max-w-md max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-start justify-between mb-1 gap-3">
              <div>
                <h2 className="text-lg font-extrabold text-charcoal">{t("recordDelivery")}</h2>
                <p className="text-sm text-brown font-medium">
                  #{selectedItem.order.orderNumber} — {selectedItem.beanTypeName}
                </p>
              </div>
              <div className="w-10 h-10 rounded-xl bg-orange/10 flex items-center justify-center shrink-0">
                <Truck size={18} className="text-orange" />
              </div>
            </div>

            {/* Submit error */}
            {submitError && (
              <div className="mt-3 mb-1 flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-medium">
                <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                <span>{submitError}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4 mt-4">

              {/* ── Lot selector ── */}
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1.5">
                  {t("selectBatchLot")} *
                </label>

                {lotsLoading ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 border-2 border-border rounded-xl text-sm text-brown/60">
                    <div className="w-4 h-4 border-2 border-orange border-t-transparent rounded-full animate-spin" />
                    <span>جارٍ تحميل اللوتات…</span>
                  </div>
                ) : lots.length === 0 ? (
                  <div className="flex items-start gap-2 px-3 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
                    <AlertTriangle size={15} className="shrink-0 mt-0.5 text-amber-500" />
                    <span>{t("noLotsAvailable")}</span>
                  </div>
                ) : (
                  <select
                    value={lotId}
                    onChange={(e) => setLotId(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors text-sm bg-white"
                  >
                    <option value="">— اختر اللوت —</option>

                    {/* Matching product group */}
                    {matchingLots.length > 0 && (
                      <optgroup label={`✓ ${t("matchingProduct")}`}>
                        {matchingLots.map((lot) => (
                          <option key={lot.id} value={lot.id}>
                            {lotLabel(lot)}
                          </option>
                        ))}
                      </optgroup>
                    )}

                    {/* Other available lots */}
                    {otherLots.length > 0 && (
                      <optgroup label={t("otherAvailableLots")}>
                        {otherLots.map((lot) => (
                          <option key={lot.id} value={lot.id}>
                            {lotLabel(lot)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                )}

                {/* Selected lot detail card */}
                {selectedLot && (
                  <div className="mt-2 px-3 py-2.5 bg-cream rounded-xl border border-border">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 font-semibold text-charcoal">
                        <Layers size={12} className="text-orange" />
                        {selectedLot.batchNumber}
                      </span>
                      <span className={`font-bold tabular-nums ${
                        selectedLot.availableQty > 0 ? "text-green-600" : "text-red-500"
                      }`}>
                        {selectedLot.availableQty.toFixed(1)} kg {t("lotAvailableKg")}
                      </span>
                    </div>
                    <p className="text-xs text-brown/60 mt-0.5">
                      {lang === "ar"
                        ? (selectedLot.product.productNameAr ?? selectedLot.product.productNameEn)
                        : selectedLot.product.productNameEn}
                    </p>
                  </div>
                )}
              </div>

              {/* ── Quantity ── */}
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1.5">{t("quantityKg")} *</label>
                <input
                  type="number" step="0.001" min="0.001"
                  value={form.quantityKg}
                  onChange={(e) => setForm({ ...form, quantityKg: parseFloat(e.target.value) || 0 })}
                  required
                  className={`w-full px-3 py-2.5 border-2 rounded-xl focus:ring-2 focus:ring-orange/20 outline-none transition-colors text-sm ${
                    lotExceedsQty ? "border-red-300 focus:border-red-400" : "border-border focus:border-orange"
                  }`}
                />
                {/* Max packaged hint */}
                <p className="text-xs text-brown/60 mt-1">
                  {t("maxLabel")} {Math.max(0, +(packagedKg(selectedItem.roastingBatches) - selectedItem.deliveredQty).toFixed(3))} kg ({t("packaged")})
                </p>

                {/* Lot quantity warning */}
                {lotExceedsQty && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs font-bold text-red-600">
                    <AlertTriangle size={13} />
                    {t("lotExceedsWarn")} ({selectedLot!.availableQty.toFixed(1)} kg {t("lotAvailableKg")})
                  </div>
                )}

                {/* FGL deduction note */}
                {selectedLot && !lotExceedsQty && (
                  <div className="mt-1.5 flex items-start gap-1.5 text-xs text-green-700 font-medium">
                    <Info size={13} className="shrink-0 mt-0.5 text-green-500" />
                    {t("fglDeductionNote")}
                  </div>
                )}
              </div>

              {/* ── Delivery type ── */}
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1.5">{t("deliveryType")}</label>
                <select
                  value={form.deliveryType}
                  onChange={(e) => setForm({ ...form, deliveryType: e.target.value })}
                  className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors text-sm bg-white"
                >
                  <option value="full">{t("fullDelivery")}</option>
                  <option value="partial">{t("partialDelivery")}</option>
                </select>
              </div>

              {/* ── Notes ── */}
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1.5">{t("notes")}</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors text-sm resize-none"
                />
              </div>

              {/* ── Actions ── */}
              <div className="flex gap-3 pt-1">
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="flex-1 py-2.5 bg-orange text-white rounded-xl font-bold text-sm hover:bg-orange/90 shadow-md shadow-orange/20 active:scale-[0.98] transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
                >
                  {submitting ? "…" : t("confirmDelivery")}
                </button>
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 py-2.5 border-2 border-border rounded-xl font-bold text-sm text-brown hover:bg-gray-50 transition-colors"
                >
                  {t("cancel")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
