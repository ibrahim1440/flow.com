"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { AlertTriangle, Box, Package, Trash2, CalendarDays, Boxes, X } from "lucide-react";
import EditDateModal, { type EditableBatch } from "@/components/EditDateModal";
import WorkflowFilterBar, { type FilterOption } from "@/components/WorkflowFilterBar";
import { formatDate } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { createRequestKeyHolder } from "@/lib/request-key";

type Batch = {
  id: string; batchNumber: string; date: string; status: string;
  productId: string | null;
  // Roasted coffee from this batch not yet packed into a finished SKU. The BOM draws
  // on this, so it is what caps how many units can be packed.
  roastedAvailableKg: number;
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

// The Finished Products catalog, for packing a roast into whole SKU units (step 12).
type CatalogSku = {
  id: string;
  skuCode: string;
  name: string;
  packSize: string;
  weightGrams: number;
  isActive: boolean;
  hasBom: boolean;
  availableUnits: number;
};

type BomPerUnit = {
  label: string;
  unitOfMeasure: string;
  quantityPerUnit: number;
  quantityAvailable: number;
};

function packagedKg(b: { bags3kg: number; bags1kg: number; bags250g: number; bags150g: number; samplesGrams: number }) {
  return +(b.bags3kg * 3 + b.bags1kg * 1 + b.bags250g * 0.25 + b.bags150g * 0.15 + b.samplesGrams / 1000).toFixed(3);
}

function isBulkCustom(batch: Batch): boolean {
  return !batch.productId && !(batch.orderItem?.productId ?? null);
}

/**
 * Which packaging method a batch uses, whether that choice is now fixed, and whether the
 * batch is one of the few where the data genuinely does not decide it.
 *
 * The two paths are mutually exclusive and the server enforces it in both directions:
 * pack-sku refuses a batch that already carries a legacy kilogram lot, and the kilogram
 * route refuses one that already has finished units. This screen used to offer both
 * buttons side by side until the kilogram path had been used, so an operator could pick
 * the path the server was about to refuse, and a part-packed batch never showed which
 * path it was already committed to.
 *
 * Derivation, in order:
 *   1. A first operation has run — locked to whichever one ran.
 *   2. The line was ordered as a SKU — finished units.
 *   3. The line was ordered against a product but not a SKU — the legacy kilogram flow.
 *   4. A roast made for the shelf against a product — both are genuinely open, so the
 *      operator is asked, once, and the answer stands until a first operation locks it.
 *   5. No product anywhere — kilograms; there is no SKU context to pack into.
 */
type PackMethod = "sku" | "bulk";

function packMethodFor(batch: Batch): { method: PackMethod; locked: boolean; ambiguous: boolean } {
  const bulkKg = packagedKg(batch);
  if (bulkKg > 0) return { method: "bulk", locked: true, ambiguous: false };

  // Coffee drawn off the batch that the bag counters do not account for was taken by the
  // finished-unit path. Tested above a gram to stay clear of float noise in the kg columns.
  //
  // The status check is not redundant. This screen only ever loads Passed and Partially
  // Packaged batches, and a real part-finished SKU run always lands on Partially Packaged —
  // pack-sku marks a batch Packaged once under 0.05kg is left, and Packaged batches are not
  // in this list. A Passed batch showing drawn-off coffee is instead an old blend written
  // before blend/route.ts conserved mass, whose roastedAvailableKg was left at 0. Neither
  // path can run on one of those, so it is not locked to either.
  const skuKg = +(batch.roastedBeanQuantity - batch.roastedAvailableKg - bulkKg).toFixed(3);
  if (skuKg > 0.001 && batch.status === "Partially Packaged") {
    return { method: "sku", locked: true, ambiguous: false };
  }

  if (batch.orderItem) {
    return {
      method: batch.orderItem.productSkuId ? "sku" : "bulk",
      locked: false,
      ambiguous: false,
    };
  }

  // A stock roast. With a product behind it both paths are real work an operator might
  // legitimately want, and nothing in the data prefers one — this is the only case the
  // frozen contract asks the operator to settle.
  if (batch.productId) return { method: "sku", locked: false, ambiguous: true };

  return { method: "bulk", locked: false, ambiguous: false };
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

  // ── Pack as finished product (step 12) ───────────────────────────────────

  // Operator override of the derived packing method, per batch, before anything has been
  // packed. The method is only LOCKED once a first operation has run; until then the
  // derivation is a default, not a ruling, and a product-linked roast the floor needs to
  // bag by weight has to stay reachable. Kept out of the card as a quiet secondary link so
  // there is still exactly one primary action per batch.
  const [methodOverride, setMethodOverride] = useState<Record<string, PackMethod>>({});
  const [packBatch, setPackBatch] = useState<Batch | null>(null);
  const [catalog, setCatalog] = useState<CatalogSku[]>([]);
  const [packSkuId, setPackSkuId] = useState("");
  const [packUnits, setPackUnits] = useState(0);
  const [packBom, setPackBom] = useState<BomPerUnit[]>([]);
  const [packError, setPackError] = useState("");
  const [packing, setPacking] = useState(false);

  // Names the packaging operation currently being attempted. One per packing path,
  // because the two forms can be open over the same session and must not share an
  // operation identity. Refs rather than state: the key must survive a re-render and
  // changing it must not cause one. All of the retry rules live in the holder, which
  // harness-selftest asserts directly — see src/lib/request-key.ts.
  const packKeyHolder = useRef(createRequestKeyHolder());
  const packageKeyHolder = useRef(createRequestKeyHolder());

  useEffect(() => { loadData(); loadProducts(); loadCatalog(); }, []);

  // Pull the selected SKU's per-unit BOM so the modal can show what a given number of
  // units will consume before anything is committed.
  useEffect(() => {
    // Clearing when the selection is emptied happens in the select's onChange, not
    // here: a setState in an effect body triggers a cascading render.
    if (!packSkuId) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/products/${packSkuId}`);
      if (cancelled) return;
      setPackBom(res.ok ? ((await res.json()).bomPerUnit ?? []) : []);
    })();
    return () => { cancelled = true; };
  }, [packSkuId]);

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

  async function loadCatalog() {
    const res = await fetch("/api/products");
    if (res.ok) setCatalog(await res.json());
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

  function openPackSku(batch: Batch) {
    setPackBatch(batch);
    setPackSkuId("");
    setPackUnits(0);
    setPackBom([]);
    setPackError("");
  }

  async function handlePackSku(e: React.FormEvent) {
    e.preventDefault();
    setPackError("");
    setPacking(true);
    try {
      const res = await fetch(`/api/roasting-batches/${packBatch!.id}/pack-sku`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": packKeyHolder.current.keyForAttempt(),
        },
        body: JSON.stringify({ productSkuId: packSkuId, units: packUnits }),
      });
      // Retires the key only if the server actually decided. A 5xx leaves it in place, so
      // the operator's next click is recognised as the same operation rather than packing
      // the coffee a second time; a thrown fetch never reaches this line at all.
      packKeyHolder.current.recordResponse(res.status);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPackError(data.error || "Failed to pack.");
        return;
      }
      setSuccess(`${t("packSkuDone")}: ${data.unitsPacked} × ${data.skuCode}`);
      setPackBatch(null);
      loadData();
      // Finished stock changed, so the catalog's availableUnits is now stale.
      loadCatalog();
    } finally {
      setPacking(false);
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
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": packageKeyHolder.current.keyForAttempt(),
      },
      body: JSON.stringify(requestBody),
    });
    packageKeyHolder.current.recordResponse(res.status);
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
              <div key={batch.id} data-testid={`pack-batch-${batch.batchNumber}`} className="bg-white rounded-2xl border border-border p-4 hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300">
                <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
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
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {canCancelBatch && (
                      <button onClick={() => setCancelBatch(batch)}
                        className="p-2 rounded-xl text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors" title="Cancel batch">
                        <Trash2 size={16} />
                      </button>
                    )}
                    {/* Step 12 — ONE packaging action per batch. Which path it opens is
                        derived by packMethodFor and fixed after the first operation, so the
                        operator is never shown two competing primary buttons for one job,
                        and a part-packed batch continues in the method it is committed to.

                        The one exception is a stock roast with a product behind it, where
                        both paths are genuinely open and nothing in the data prefers one.
                        That is asked once, as a choice rather than as two primary actions,
                        and the answer then behaves exactly like a derived method. */}
                    {(() => {
                      const { method: derived, locked, ambiguous } = packMethodFor(batch);
                      const answer = methodOverride[batch.id];
                      const mustAsk = ambiguous && !locked && !answer;
                      // The answer only applies while the method is still open. Once a first
                      // operation has run the server refuses the other path anyway, so a
                      // stale answer must not be able to open a dead form.
                      const method = locked ? derived : (answer ?? derived);
                      const partial = batch.status === "Partially Packaged";

                      if (mustAsk) {
                        return (
                          <div className="flex flex-col items-end gap-1">
                            <span className="text-[10px] font-semibold text-brown/60 text-end">
                              {t("pkgChooseMethod")}
                            </span>
                            <div className="flex gap-2">
                              {(["sku", "bulk"] as const).map((m) => (
                                <button
                                  key={m}
                                  type="button"
                                  onClick={() => setMethodOverride((prev) => ({ ...prev, [batch.id]: m }))}
                                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-bold border-2 border-border text-brown bg-white hover:border-orange/60 hover:text-orange active:scale-[0.98] transition-all"
                                >
                                  {m === "sku" ? <Boxes size={15} /> : <Package size={15} />}
                                  {m === "sku" ? t("pkgMethodSku") : t("pkgMethodBulk")}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div className="flex flex-col items-end gap-1 w-full xl:w-auto">
                          <button
                            onClick={() => (method === "sku" ? openPackSku(batch) : openPackage(batch))}
                            className="flex items-center justify-center gap-1.5 w-full xl:w-auto px-4 py-2.5 bg-orange text-white rounded-xl text-sm font-bold hover:bg-orange-dark shadow-md shadow-orange/20 active:scale-[0.98] transition-all"
                          >
                            {method === "sku" ? <Boxes size={16} /> : <Package size={16} />}
                            {partial ? t("continuePackaging") : t("startPackaging")}
                          </button>
                          <span className="text-[10px] font-semibold text-brown/60 text-end">
                            {method === "sku" ? t("pkgMethodSku") : t("pkgMethodBulk")}
                            {locked && <> · {t("pkgMethodLocked")}</>}
                          </span>
                        </div>
                      );
                    })()}
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
            {/* The method this batch is being packed in, named on the form itself. A
                continuation has to say which path it is continuing — the card that opened
                it is behind a modal by then. */}
            <p className="text-[11px] font-bold text-brown/60 mb-2">
              {t("pkgMethodBulk")}
              {packMethodFor(selectedBatch).locked && <> · {t("pkgMethodLocked")}</>}
            </p>
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
                    {/* The closing warning, next to the button that would close the batch.
                        Packaging the last of a roast finalises it, and the screen said
                        nothing about that until it had already happened. 0.05kg is the same
                        slack the server uses to decide a batch is finished. */}
                    {!invalid && newTotalKg >= selectedBatch.roastedBeanQuantity - 0.05 && (
                      <p className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-start gap-1.5">
                        <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                        {t("pkgClosingWarning")}
                      </p>
                    )}
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

      {/* ── Step 12: pack a roast into whole units of a finished SKU ────────── */}
      {packBatch && (() => {
        const sku = catalog.find((c) => c.id === packSkuId);
        const sellable = catalog.filter((c) => c.isActive && c.hasBom);
        // Roasted coffee is what caps the run: the BOM's coffee line per unit divided
        // into what this batch still holds. Materials are checked by the server, which
        // is the only place that can reserve them.
        const coffeePerUnit = packBom
          .filter((b) => b.unitOfMeasure === "KG")
          .reduce((s, b) => s + b.quantityPerUnit, 0);
        const maxUnits = coffeePerUnit > 0
          ? Math.floor((packBatch.roastedAvailableKg + 0.0005) / coffeePerUnit)
          : 0;
        const overCapacity = packUnits > maxUnits;
        // What the floor can actually make right now, and what is missing if the operator
        // asked for more. Reported as three separate numbers — requested, possible, missing
        // — because collapsing them into one auto-corrected figure is exactly the silent
        // substitution the frozen contract forbids: the operator must change the request
        // themselves, or the pack sheet and the shelf stop agreeing about what was made.
        //
        // Availability is the snapshot this modal loaded. The server still holds the real
        // reservation and can refuse a run this preview thought was fine.
        // MATERIALS only — bags, labels, boxes. The BOM's roasted-coffee line is drawn from
        // THIS batch, not from a shelf, so it is not a material that can be short: its
        // ceiling is roastedAvailableKg and is already enforced by maxUnits/overCapacity
        // above. Counting it here read the coffee as missing stock and blocked a pack the
        // batch could fully cover. Split on the same test coffeePerUnit uses, so the two
        // halves of the BOM cannot drift apart.
        const materialLines = packBom.filter((b) => b.unitOfMeasure !== "KG");
        const materialCap = materialLines.length > 0
          ? Math.min(...materialLines.map((b) => (b.quantityPerUnit > 0 ? Math.floor((b.quantityAvailable + 0.0005) / b.quantityPerUnit) : Infinity)))
          : Infinity;
        const maxPossibleUnits = Math.max(0, Math.min(maxUnits, Number.isFinite(materialCap) ? materialCap : maxUnits));
        const shortLines = packUnits > 0
          ? materialLines
              .map((b) => ({ ...b, need: +(b.quantityPerUnit * packUnits).toFixed(3) }))
              .filter((b) => b.need > b.quantityAvailable + 0.0005)
          : [];
        // Confirmation is blocked, not adjusted.
        const blockedByShortage = packUnits > 0 && shortLines.length > 0;
        return (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
            <form onSubmit={handlePackSku} className="bg-white rounded-2xl w-full max-w-lg my-8 shadow-xl">
              <div className="flex items-center justify-between p-4 border-b border-oo-border-default">
                <div>
                  <h2 className="font-extrabold text-oo-text-primary">{t("packSkuTitle")}</h2>
                  <p className="text-xs text-oo-text-muted font-mono">{packBatch.batchNumber}</p>
                </div>
                <button type="button" onClick={() => setPackBatch(null)} aria-label="Close">
                  <X size={20} className="text-oo-text-muted" />
                </button>
              </div>

              <div className="p-4 space-y-3">
                {/* What this run is continuing: the locked method, what the batch has
                    already given up, and what is left to pack. A continuation form that
                    showed only the remainder made a second pass look like a first one. */}
                <div className="rounded-xl bg-oo-bg-subtle px-3 py-2 text-sm space-y-0.5">
                  <p className="text-[11px] font-bold text-oo-text-muted">
                    {t("pkgMethodSku")}
                    {packMethodFor(packBatch).locked && <> · {t("pkgMethodLocked")}</>}
                  </p>
                  {packBatch.roastedBeanQuantity - packBatch.roastedAvailableKg > 0.001 && (
                    <p>
                      <span className="text-oo-text-secondary">{t("alreadyPackaged")} </span>
                      <b className="text-oo-text-primary">
                        {+(packBatch.roastedBeanQuantity - packBatch.roastedAvailableKg).toFixed(3)} kg
                      </b>
                    </p>
                  )}
                  <p>
                    <span className="text-oo-text-secondary">{t("roastedAvailableLabel")}: </span>
                    <b className="text-oo-text-primary">{packBatch.roastedAvailableKg} kg</b>
                  </p>
                </div>

                {sellable.length === 0 ? (
                  <p className="text-sm font-semibold text-oo-status-blocked">{t("packSkuNoProducts")}</p>
                ) : (
                  <>
                    <label className="block">
                      <span className="text-xs font-bold text-oo-text-secondary">{t("productNameLabel")}</span>
                      <select
                        value={packSkuId}
                        onChange={(e) => { setPackSkuId(e.target.value); setPackUnits(0); setPackBom([]); }}
                        className="w-full px-3 py-2 rounded-xl border border-oo-border-default text-sm"
                        required
                      >
                        <option value="">—</option>
                        {sellable.map((c) => (
                          <option key={c.id} value={c.id}>{c.name} ({c.skuCode})</option>
                        ))}
                      </select>
                    </label>

                    {sku && packBom.length > 0 && (
                      <>
                        <label className="block">
                          <span className="text-xs font-bold text-oo-text-secondary">
                            {t("unitsToPackLabel")} — {t("maxUnitsLabel")}: {maxUnits}
                          </span>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            max={maxUnits > 0 ? maxUnits : undefined}
                            value={packUnits || ""}
                            onChange={(e) => setPackUnits(parseInt(e.target.value, 10) || 0)}
                            className="w-full px-3 py-2 rounded-xl border border-oo-border-default text-sm"
                            required
                          />
                        </label>

                        {packUnits > 0 && (
                          <div className="rounded-xl border border-oo-border-default p-2.5">
                            <p className="text-[11px] font-bold text-oo-text-muted uppercase mb-1">
                              {t("productionReqConsumes")}
                            </p>
                            <ul className="space-y-0.5">
                              {packBom.map((b, i) => {
                                const need = +(b.quantityPerUnit * packUnits).toFixed(3);
                                const short = need > b.quantityAvailable + 0.0005;
                                return (
                                  <li key={i} className="text-xs flex items-center gap-1.5 flex-wrap">
                                    <span className="text-oo-text-secondary">
                                      {b.label}: <b>{need}</b> {b.unitOfMeasure === "KG" ? "kg" : "pcs"}
                                    </span>
                                    {short && (
                                      <span className="text-oo-status-blocked font-semibold">
                                        ({t("productionReqShort")} — {b.quantityAvailable})
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}

                        {/* Material shortage, as its own panel and in three separate
                            figures: what was requested, what is actually possible right now,
                            and what is missing. The requested number is never rewritten to
                            the possible one — quietly packing fewer units than an operator
                            asked for is the one outcome that leaves the floor and the system
                            disagreeing about what was made. Confirmation is blocked instead,
                            so changing the request stays a deliberate act. */}
                        {blockedByShortage && (
                          <div className="rounded-xl border border-oo-status-blocked/40 bg-red-50 p-2.5" role="alert">
                            <p className="text-[11px] font-bold text-oo-status-blocked uppercase mb-1.5 flex items-center gap-1.5">
                              <AlertTriangle size={13} /> {t("pkgShortageTitle")}
                            </p>
                            <div className="grid grid-cols-2 gap-x-3 gap-y-1 mb-2">
                              <span className="text-[11px] text-oo-text-muted">{t("pkgShortageRequested")}</span>
                              <span className="text-xs font-bold tabular-nums text-end">{packUnits}</span>
                              <span className="text-[11px] text-oo-text-muted">{t("pkgShortageMaxPossible")}</span>
                              <span className="text-xs font-bold tabular-nums text-end">{maxPossibleUnits}</span>
                            </div>
                            <p className="text-[11px] font-bold text-oo-status-blocked uppercase mb-1">
                              {t("pkgShortageMissing")}
                            </p>
                            <ul className="space-y-0.5 mb-1.5">
                              {shortLines.map((b, i) => (
                                <li key={i} className="text-xs text-oo-text-secondary">
                                  {b.label}:{" "}
                                  <span className="text-oo-status-blocked font-semibold">
                                    {+(b.need - b.quantityAvailable).toFixed(3)} {b.unitOfMeasure === "KG" ? "kg" : "pcs"}
                                  </span>{" "}
                                  <span className="text-oo-text-muted">
                                    ({t("pkgShortageRequested")} {b.need} · {t("pkgShortageAvailable")} {b.quantityAvailable})
                                  </span>
                                </li>
                              ))}
                            </ul>
                            <p className="text-[11px] font-semibold text-oo-text-muted">{t("pkgShortageNoChange")}</p>
                          </div>
                        )}

                        {overCapacity && (
                          <p className="text-xs font-semibold text-oo-status-blocked">
                            {t("roastedAvailableLabel")}: {packBatch.roastedAvailableKg} kg — {t("maxUnitsLabel")}: {maxUnits}
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}

                {/* Closing warning, kept inside the scrolling body immediately above the
                    footer so it sits next to the action that would close the batch. The
                    0.05kg threshold is the one pack-sku itself uses to mark a batch
                    Packaged, so this fires exactly when the batch will actually close. */}
                {packUnits > 0 && !blockedByShortage && !overCapacity && coffeePerUnit > 0 &&
                  packBatch.roastedAvailableKg - packUnits * coffeePerUnit < 0.05 && (
                  <p className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-start gap-1.5">
                    <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                    {t("pkgClosingWarning")}
                  </p>
                )}

                {packError && (
                  <p className="text-xs font-semibold text-oo-status-blocked flex items-start gap-1.5">
                    <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" /> {packError}
                  </p>
                )}
              </div>

              <div className="flex gap-3 p-4 border-t border-oo-border-default">
                <button
                  type="submit"
                  disabled={packing || !packSkuId || packUnits <= 0 || overCapacity || blockedByShortage}
                  className="flex-1 py-2.5 rounded-xl bg-oo-action-primary text-white font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {packing ? "…" : t("packSkuBtn")}
                </button>
                <button type="button" onClick={() => setPackBatch(null)}
                  className="flex-1 py-2.5 border border-oo-border-default rounded-xl font-bold text-sm hover:bg-oo-bg-subtle">
                  {t("cancel")}
                </button>
              </div>
            </form>
          </div>
        );
      })()}
    </div>
  );
}
