"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { AlertTriangle, Info, Layers } from "lucide-react";
import { Bar, Btn, Notice, OpsEmpty, OpsError, OpsLoading, OpsPane, OpsRoot, PageHeader, StatusDot, Tabs, Kg, kg, opsDate, Units, UNIT_FORMS, countNoun } from "@/components/ops/ui";
import WorkflowFilterBar, { type FilterOption } from "@/components/WorkflowFilterBar";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
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
  // Non-null on a SKU line: it is sold, reserved and shipped in whole units.
  quantityUnits: number | null;
  deliveredUnits: number;
  productSku: { id: string; skuCode: string; weightGrams: number } | null;
};

/**
 * One dispatch, one key.
 *
 * The server refuses a delivery without an Idempotency-Key, and uses it to tell a retry
 * of one dispatch apart from a second dispatch that happens to look identical. Only the
 * client knows which of those the operator meant, so the key is minted here — once per
 * opened dispatch form — and deliberately survives a failed attempt.
 *
 * randomUUID needs a secure context; a shop-floor tablet on plain http over the LAN would
 * not have it. getRandomValues is available either way, so the fallback keeps the same 128
 * bits of entropy rather than degrading to something guessable.
 */
function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A SKU line ships units; a legacy line ships kilograms. */
const isUnitLine = (i: OrderItem | null): boolean => !!i && i.quantityUnits !== null && !!i.productSku;

type FGLot = {
  id: string;
  batchNumber: string;
  quantityKg: number;
  availableQty: number;
  reservedQty: number;
  /** Promised to the order item being delivered — shippable by it, invisible to others. */
  reservedForThisItem?: number;
  /** reservedForThisItem + free stock: what this item may take off the lot right now. */
  deliverableQty?: number;
  /** The same figure in whole units, present only on unit-tracked lots. */
  deliverableUnits?: number;
  unitsAvailable?: number;
  productId: string;
  product: { productNameEn: string; productNameAr: string | null };
  status: string;
  roastingBatch?: { orderItemId: string } | null;
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
  // G-1: «جاهز للتسليم» / «سجل التسليمات» are tabs.
  const [tab,         setTab]         = useState<"ready" | "history">("ready");
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
  // G-10 (OG-D7): a refused submit (4xx — nothing was recorded) and an unconfirmed one
  // (5xx / network — it may have been recorded; the same key is reused on retry) read
  // differently.
  const [submitKind,    setSubmitKind]    = useState<"refused" | "unconfirmed" | null>(null);
  const [submitting,    setSubmitting]    = useState(false);
  // Not state: changing it must never re-render, and a retry has to read the value the
  // previous attempt used, not one a render cycle may not have committed yet.
  const requestKeyRef = useRef<string | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => { loadData(); }, []);

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  async function loadData() {
    const [ordersRes, delRes] = await Promise.all([fetch("/api/orders"), fetch("/api/deliveries")]);
    const take = async (r: Response) => (r.ok ? r.json() : (await r.text(), null));
    const [ordersJ, delJ] = await Promise.all([ordersRes, delRes].map(take));
    setLoadError(ordersJ === null || delJ === null);
    if (ordersJ) setOrders(ordersJ);
    if (delJ) setDeliveries(delJ);
    setLoaded(true);
  }

  // ── Open delivery modal ───────────────────────────────────────────────────
  async function startDelivery(item: OrderItem) {
    // A SKU line's outstanding amount is a unit count and comes straight off the line —
    // not from summing packaged bags of its own batches, which is the legacy heuristic
    // and says nothing about a line filled from shelf stock someone else roasted.
    const outstandingUnits = isUnitLine(item)
      ? Math.max(0, (item.quantityUnits ?? 0) - item.deliveredUnits)
      : 0;
    const available = isUnitLine(item)
      ? outstandingUnits
      : Math.max(0, +(packagedKg(item.roastingBatches) - item.deliveredQty).toFixed(3));

    setSelectedItem(item);
    setForm({
      quantityKg:   available,
      deliveryType: isUnitLine(item)
        ? (available >= outstandingUnits ? "full" : "partial")
        : (available >= item.quantityKg ? "full" : "partial"),
      notes:        "",
    });
    setLotId("");
    setSubmitError("");
    // A new intended dispatch starts here.
    requestKeyRef.current = newIdempotencyKey();
    setShowForm(true);

    // What this specific item can ship from. Filtering the global lot list by free
    // quantity is wrong: a batch roasted for this very order is reserved to it in full
    // the moment it is packaged, so its own lot has zero free quantity and would be
    // filtered out — leaving the ordinary roast -> package -> deliver path with nothing
    // to pick. The server returns each lot's deliverableQty for this item: its own
    // reservation plus whatever is free to anyone.
    setLotsLoading(true);
    try {
      const res = await fetch(`/api/order-items/${item.id}/fulfillment-options`);
      if (res.ok) {
        const data = await res.json();
        type ApiLot = Omit<FGLot, "product"> & { product: FGLot["product"] | null };
        setLots(
          (data.matchingLots as ApiLot[])
            .filter((l) => (l.deliverableQty ?? 0) > 0)
            // Legacy/unnamed lots fall back to their batch number so the picker never
            // renders a blank row.
            .map((l) => ({ ...l, product: l.product ?? { productNameEn: l.batchNumber, productNameAr: null } }))
        );
      } else {
        setLots([]);
      }
    } finally {
      setLotsLoading(false);
    }
  }

  /**
   * G-4 (owner, 15 Oct): choosing a lot pre-fills what that lot can ship for this line —
   * the lower of the outstanding amount and the lot's free quantity — and the type follows
   * (partial when it is less than the outstanding amount). The operator can still change both.
   */
  function chooseLot(id: string) {
    setLotId(id);
    const lot = lots.find((l) => l.id === id);
    if (!lot || !selectedItem) return;
    const unit = isUnitLine(selectedItem);
    const outstanding = unit
      ? Math.max(0, (selectedItem.quantityUnits ?? 0) - selectedItem.deliveredUnits)
      : Math.max(0, +(packagedKg(selectedItem.roastingBatches) - selectedItem.deliveredQty).toFixed(3));
    const free = Math.max(0, (unit ? lot.deliverableUnits : lot.deliverableQty) ?? 0);
    const qty = unit ? Math.min(outstanding, Math.floor(free)) : +Math.min(outstanding, free).toFixed(3);
    const full = unit ? qty >= outstanding : qty >= selectedItem.quantityKg;
    setForm((f) => ({ ...f, quantityKg: qty, deliveryType: full ? "full" : "partial" }));
  }

  function closeModal() {
    requestKeyRef.current = null;
    setShowForm(false);
    setSelectedItem(null);
    setLots([]);
    setLotId("");
    setSubmitError("");
    setSubmitKind(null);
  }

  // ── Submit delivery ───────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // A second submit while the first is still open would be a second POST under the same
    // key: the server would answer it correctly, but the two responses would race to set
    // this component’s state. Refuse it here instead.
    if (submitting) return;

    // Normally openModal minted this when the operator opened the form. It is null in exactly
    // one case: the previous attempt was definitively refused (see below), which released it.
    // Minting a fresh one then is correct — this is a new intent, not a retry of a dead one.
    const requestKey = requestKeyRef.current ?? (requestKeyRef.current = newIdempotencyKey());

    setSubmitError("");
    setSubmitKind(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/deliveries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey,
        },
        body: JSON.stringify({
          orderItemId:        selectedItem!.id,
          // The same input box carries units for a SKU line and kilograms for a legacy one;
          // the server branches on the line, so send the field it will actually read.
          ...(isUnitLine(selectedItem)
            ? { quantityUnits: Math.trunc(form.quantityKg) }
            : { quantityKg: form.quantityKg }),
          deliveryType:       form.deliveryType,
          notes:              form.notes || null,
          finishedGoodsLotId: lotId || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // ── What the key does after a failure ────────────────────────────────
        // Only two outcomes exist on this route: it committed and answered 200/201, or it
        // rolled back entirely. A 4xx is therefore a decision — no delivery, no stock
        // drawn — and the intent it refused is dead, so the key is released and a
        // corrected resubmission is judged on its own terms instead of colliding with a
        // claim for the dispatch the operator has just changed.
        //
        // A 5xx is the opposite: the request may have committed and the answer been lost.
        // Keeping the key is what makes the retry a replay of that dispatch rather than a
        // second one, which is the entire reason this header exists.
        if (res.status >= 500) {
          setSubmitKind("unconfirmed");
          setSubmitError(data.error || "");
        } else {
          requestKeyRef.current = null;
          setSubmitKind("refused");
          setSubmitError(data.error || "");
        }
        return;
      }

      // 200 (the server replayed an earlier identical dispatch) and 201 (it created one)
      // both mean exactly one delivery exists and it is the one that was asked for.
      closeModal();
      loadData();
    } catch {
      // The request never produced an answer, so whether it reached the server is unknown.
      // The key stays; the operator retries the same dispatch.
      setSubmitKind("unconfirmed");
      setSubmitError("");
    } finally {
      // Reached on every path — including the throw above, which previously left the
      // button disabled with no way back except a reload.
      setSubmitting(false);
    }
  }

  // ── Ready items list ──────────────────────────────────────────────────────
  // An item is ready when there is coffee it can ship: either its own batches have been
  // packaged, or preparation review covered it from the shelf. Gating on packaged batches
  // alone — the rule the delivery route itself no longer uses — would hide exactly the
  // orders this change exists to enable: the ones filled from stock with no roast at all.
  const readyItems = orders.flatMap((o: any) =>
    // Only orders the delivery route will actually accept. This mirrors
    // DELIVERY_ALLOWED_STATUSES in lib/services/order-operations — that is the
    // enforcement, this is only here so dispatch is not shown cancelled, held and
    // unapproved orders it would be refused on. Keep the two in step.
    (o.status === "Preparing" || o.status === "Ready for Shipping" ? o.items : [])
      .filter((i: any) => {
        if (i.deliveryStatus === "Delivered") return false;
        // A SKU line is shippable when units remain on it. Its stock may have been
        // reserved from shelf lots somebody else roasted, so the packaged-bags heuristic
        // below — which only ever looks at this line's OWN batches — would hide it.
        if (i.quantityUnits !== null && i.quantityUnits !== undefined) {
          return (i.quantityUnits - (i.deliveredUnits ?? 0)) > 0;
        }
        return packagedKg(i.roastingBatches) > i.deliveredQty || (i.availableQuantity ?? 0) > 0;
      })
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
  const selectedLot   = lots.find((l) => l.id === lotId) ?? null;
  const unitLine      = isUnitLine(selectedItem);
  // What this item may take off the selected lot: its own reservation plus free stock.
  // Compared in the line's own denomination — units for a SKU line, kilograms otherwise —
  // so the ceiling matches what the input box actually holds.
  const lotFreeQty    = selectedLot
    ? Math.max(0, (unitLine ? selectedLot.deliverableUnits : selectedLot.deliverableQty) ?? 0)
    : 0;
  const lotExceedsQty = selectedLot !== null && form.quantityKg > lotFreeQty;
  const canSubmit = !!lotId && !lotExceedsQty && !submitting;

  // Split lots by priority:
  // Tier 1/2: lots matching orderItem.productId (SKU-ready path, unchanged)
  // Tier 3:   lots whose roastingBatch links back to this orderItem (bulk/custom path)
  // Other:    remaining unrelated lots
  const matchingLots = selectedItem
    ? selectedItem.productId
      ? lots.filter((l) => l.productId === selectedItem.productId)
      : lots.filter((l) => l.roastingBatch?.orderItemId === selectedItem.id)
    : [];
  const otherLots = lots.filter((l) => !matchingLots.includes(l));

  function lotLabel(lot: FGLot) {
    const productLabel = lang === "ar" ? (lot.product.productNameAr ?? lot.product.productNameEn) : lot.product.productNameEn;
    if (unitLine) {
      const freeUnits = Math.max(0, lot.deliverableUnits ?? 0);
      return `${lot.batchNumber} — ${productLabel} — ${t("availableLabel")}: ${countNoun(freeUnits, lang, UNIT_FORMS)}`;
    }
    const free = Math.max(0, lot.deliverableQty ?? 0);
    return `${lot.batchNumber} — ${productLabel} — ${t("lotAvailableKg")}: ${free.toFixed(1)} ${t("opsKgUnit")}`;
  }

  const shownDeliveries = deliveries.filter((d) =>
    `${d.orderItem.order.orderNumber} ${d.orderItem.order.customer.name} ${d.orderItem.beanTypeName}`
      .toLowerCase().includes(search.toLowerCase())
  );

  const readyFiltered = !!(readySearch || readyBean || readyOrder);
  const clearReadyFilters = () => { setReadySearch(""); setReadyBean(""); setReadyOrder(""); };
  const deliveringId = canDeliver && showForm && selectedItem ? selectedItem.id : null;

  return (
    <OpsRoot className="ops-dispatch">
    <div className={`hr-split${deliveringId ? " has-preview" : ""}`}>
    <div className="hr-page">
      <PageHeader title={t("opsDispatchTitle")}>
        <span><span className="hr-num">{readyItems.length}</span> {t("itemsReadyDelivery")}</span>
      </PageHeader>

      {loadError ? <OpsError message={t("opsLoadFailed")} onRetry={loadData} /> : null}
      {!loaded && !loadError ? <OpsLoading /> : null}

      {loaded ? (
        <Tabs
          label={t("opsDispatchTitle")}
          value={tab}
          onChange={setTab}
          items={[
            { key: "ready", label: t("readyForDelivery"), count: readyItems.length },
            { key: "history", label: t("deliveryHistory"), count: deliveries.length },
          ]}
        />
      ) : null}

      {/* ── Ready for delivery (G-1 tab) ── */}
      {loaded && tab === "ready" ? <section className="hr-stack" style={{ gap: 12 }} aria-label={t("readyForDelivery")}>
        {readyItems.length > 0 && (
          <WorkflowFilterBar
            searchQuery={readySearch} onSearchChange={setReadySearch}
            beanOptions={readyBeanOptions} selectedBean={readyBean} onBeanChange={setReadyBean}
            orderOptions={readyOrderOptions} selectedOrder={readyOrder} onOrderChange={setReadyOrder}
            resultCount={filteredReadyItems.length} totalCount={readyItems.length}
          />
        )}
        {readyItems.length === 0 ? (
          <OpsEmpty title={t("noItemsDelivery")} />
        ) : filteredReadyItems.length === 0 && readyFiltered ? (
          // G-2: filtered to nothing is not «nothing to deliver».
          <OpsEmpty title={t("opsNoResults")} body={t("opsNoResultsBody")} action={<Btn onClick={clearReadyFilters}>{t("opsClearFilters")}</Btn>} />
        ) : (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow ops-dispatch" aria-label={t("readyForDelivery")}>
              <thead>
                <tr>
                  <th>{t("opsOrderCol")}</th>
                  <th>{t("customer")}</th>
                  <th>{t("beanCol")}</th>
                  <th className="num">{t("qtyKg")}</th>
                  <th className="num">{t("packaged")}</th>
                  <th className="num">{t("availableForDelivery")}</th>
                  <th>{t("deliveredCol")}</th>
                  <th aria-label={t("opsActions")} />
                </tr>
              </thead>
              <tbody>
                {filteredReadyItems.map((item) => {
                  const packed    = packagedKg(item.roastingBatches);
                  const available = Math.max(0, +(packed - item.deliveredQty).toFixed(3));
                  return (
                    <tr key={item.id} data-testid={`dispatch-row-${item.order.orderNumber}`} aria-selected={deliveringId === item.id}>
                      <td className="hr-id">#{item.order.orderNumber}</td>
                      <td className="m-title">
                        {/* N-07: a Latin name in the Arabic table truncates at its own end. */}
                        <span className="strong ops-ell-auto" dir="auto">{item.order.customer.name}</span>
                        <span className="ops-line">
                          <span className="hr-mobile-only"><span className="hr-id">#{item.order.orderNumber}</span> · {item.beanTypeName} · </span>
                          <span className="hr-num">{kg(item.quantityKg)}</span> {t("kgOrdered")} · {t("packaged")} <Kg v={packed} /> · {t("availableForDelivery")} <Kg v={available} />
                        </span>
                      </td>
                      <td><span className="ops-ell-auto" dir="auto">{item.beanTypeName}</span></td>
                      {/* N-06 (OG-D1, FREEZE): table quantities at 2 dp. */}
                      <td className="num"><span className="hr-num">{kg(item.quantityKg)}</span></td>
                      <td className="num"><span className="hr-num">{kg(packed)}</span></td>
                      <td className="num"><span className="hr-num">{kg(available)}</span></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {item.deliveredQty > 0 ? (
                          <>
                            <Bar pct={packed > 0 ? (item.deliveredQty / packed) * 100 : 0} tone="success" />{" "}
                            <span className="hr-caption"><Kg v={item.deliveredQty} /><span className="hr-hide-preview"> {t("deliveredKgLabel")}</span></span>
                          </>
                        ) : <span className="hr-muted">—</span>}
                      </td>
                      <td className="m-end">
                        {canDeliver && (
                          <Btn size="sm" variant="primary" className="ops-deliver" onClick={() => startDelivery(item)}>{t("deliver")}</Btn>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section> : null}

      {/* ── Delivery history (G-1 tab) ── */}
      {loaded && tab === "history" ? <section className="hr-stack" style={{ gap: 12 }} aria-label={t("deliveryHistory")}>
        <div className="hr-filterbar">
          <input
            type="text" placeholder={t("searchDeliveries")} aria-label={t("searchDeliveries")} value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="hr-input hr-search"
          />
        </div>
        {deliveries.length === 0 ? (
          <OpsEmpty title={t("noData")} />
        ) : shownDeliveries.length === 0 ? (
          <OpsEmpty title={t("opsNoResults")} body={t("opsNoResultsBody")} action={<Btn onClick={() => setSearch("")}>{t("opsClearFilters")}</Btn>} />
        ) : (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow" aria-label={t("deliveryHistory")}>
              <thead>
                <tr>
                  <th>{t("date")}</th>
                  <th>{t("orderCol")}</th>
                  <th>{t("customer")}</th>
                  <th>{t("beanCol")}</th>
                  <th className="num">{t("qtyKg")}</th>
                  <th>{t("type")}</th>
                </tr>
              </thead>
              <tbody>
                {shownDeliveries.map((d) => (
                  <tr key={d.id}>
                    <td>{opsDate(d.date, lang)}</td>
                    <td className="hr-id">#{d.orderItem.order.orderNumber}</td>
                    <td className="m-title">
                      <span className="strong">{d.orderItem.order.customer.name}</span>
                      <span className="hr-msub">
                        <span className="hr-id">#{d.orderItem.order.orderNumber}</span> · {d.orderItem.beanTypeName} · <Kg v={d.quantityKg} /> · {opsDate(d.date, lang)}
                      </span>
                    </td>
                    <td>{d.orderItem.beanTypeName}</td>
                    <td className="num"><span className="hr-num">{kg(d.quantityKg)}</span></td>
                    <td className="m-end">
                      <StatusDot map={{ full: [t("fullBadge"), "success"], partial: [t("partialBadge"), "warning"] }} value={d.deliveryType === "full" ? "full" : "partial"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section> : null}
    </div>

      {/* G-3 (OG-D1 / D2 / D6): recording a delivery is the pane beside the list (1440), the
          drawer over it (1024) and a bottom sheet on the phone. Same fields, same request,
          same idempotency key as the dialog it replaces. */}
      {deliveringId && selectedItem ? (
        <OpsPane
          testId="delivery-pane"
          label={t("recordDelivery")}
          title={t("recordDelivery")}
          sub={<><span className="hr-id">#{selectedItem.order.orderNumber}</span> · {selectedItem.beanTypeName}</>}
          busy={submitting}
          onClose={closeModal}
          footer={
            <>
              <Btn variant="primary" type="submit" form="delivery-form" disabled={!canSubmit} busy={submitting}>{t("confirmDelivery")}</Btn>
              <Btn onClick={closeModal} disabled={submitting}>{t("cancel")}</Btn>
            </>
          }
        >
          {submitKind ? (
            <Notice tone="danger">
              <strong style={{ fontWeight: 600 }}>{submitKind === "refused" ? t("deliveryRefused") : t("deliveryUnconfirmed")}</strong>
              {/* D-7: the server answers in English; an Arabic session shows only its own message. */}
              {submitError && lang === "en" ? <div>{submitError}</div> : null}
            </Notice>
          ) : null}
          <form id="delivery-form" onSubmit={handleSubmit} className="hr-stack" style={{ gap: 14 }}>
              {/* ── Lot selector ── */}
              <div>
                <label htmlFor="delivery-lot" className="block text-sm font-bold text-charcoal mb-1.5">
                  {t("selectBatchLot")} *
                </label>

                {lotsLoading ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 border-2 border-border rounded-xl text-sm text-brown/60">
                    <div className="w-4 h-4 border-2 border-orange border-t-transparent rounded-full animate-spin" />
                    {/* Also hard-coded Arabic: an English session saw it while the
                        lot list loaded, which on a remote database is several seconds. */}
                    <span>{t("loadingLots")}</span>
                  </div>
                ) : lots.length === 0 ? (
                  <div className="space-y-1.5">
                    <div className="flex items-start gap-2 px-3 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
                      <AlertTriangle size={15} className="shrink-0 mt-0.5 text-amber-500" />
                      <span>{t("noLotsAvailable")}</span>
                    </div>
                  </div>
                ) : (
                  <select
                    id="delivery-lot"
                    value={lotId}
                    onChange={(e) => chooseLot(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors text-sm bg-white"
                  >
                    {/* Was hard-coded Arabic, so an English session saw one Arabic string
                        in the middle of an otherwise English form. */}
                    <option value="">{t("selectLot")}</option>

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
                        lotFreeQty > 0 ? "text-green-600" : "text-red-500"
                      }`}>
                        {unitLine ? <Units v={lotFreeQty} /> : <Kg v={lotFreeQty} digits={1} />} {t("lotAvailableKg")}
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
                <label htmlFor="delivery-qty" className="block text-sm font-bold text-charcoal mb-1.5">
                  {unitLine ? `${t("quantityUnitsLabel")} *` : `${t("quantityKg")} *`}
                </label>
                <input
                  id="delivery-qty"
                  type="number"
                  step={unitLine ? 1 : 0.001}
                  min={unitLine ? 1 : 0.001}
                  value={form.quantityKg}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      quantityKg: unitLine
                        ? (parseInt(e.target.value, 10) || 0)
                        : (parseFloat(e.target.value) || 0),
                    })
                  }
                  required
                  className={`w-full px-3 py-2.5 border-2 rounded-xl focus:ring-2 focus:ring-orange/20 outline-none transition-colors text-sm ${
                    lotExceedsQty ? "border-red-300 focus:border-red-400" : "border-border focus:border-orange"
                  }`}
                />
                {/* Outstanding hint. A SKU line reads it straight off the line; the legacy
                    path keeps its packaged-bags heuristic. */}
                <p className="text-xs text-brown/60 mt-1">
                  {unitLine
                    ? `${t("maxLabel")} ${countNoun(Math.max(0, (selectedItem.quantityUnits ?? 0) - selectedItem.deliveredUnits), lang, UNIT_FORMS)}`
                    : `${t("maxLabel")} ${Math.max(0, +(packagedKg(selectedItem.roastingBatches) - selectedItem.deliveredQty).toFixed(3))} ${t("opsKgUnit")} (${t("packaged")})`}
                </p>

                {/* Lot quantity warning */}
                {lotExceedsQty && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs font-bold text-red-600">
                    <AlertTriangle size={13} />
                    {t("lotExceedsWarn")} ({unitLine ? <Units v={lotFreeQty} /> : <Kg v={lotFreeQty} digits={1} />} {t("lotAvailableKg")})
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
                <label htmlFor="delivery-type" className="block text-sm font-bold text-charcoal mb-1.5">{t("deliveryType")}</label>
                <select
                  id="delivery-type"
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
                <label htmlFor="delivery-notes" className="block text-sm font-bold text-charcoal mb-1.5">{t("notes")}</label>
                <textarea
                  id="delivery-notes"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors text-sm resize-none"
                />
              </div>

          </form>
        </OpsPane>
      ) : null}
    </div>
    </OpsRoot>
  );
}
