"use client";

import { useState, useEffect, useMemo } from "react";
import { Factory, AlertTriangle, CheckCircle, Merge, Box, Boxes, FileText, FileSpreadsheet, Trash2, CalendarDays, Pencil } from "lucide-react";
import EditDateModal, { type EditableBatch } from "@/components/EditDateModal";
import WorkflowFilterBar, { type FilterOption } from "@/components/WorkflowFilterBar";
import { formatDate } from "@/lib/utils";
import { exportBatchesPDF, exportBatchesExcel, type BatchExportRow } from "@/lib/export";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { canStartProduction } from "@/lib/order-operations-client";
import { useI18n } from "@/lib/i18n/context";
import { type TranslationKey } from "@/lib/i18n/translations";

type Batch = {
  id: string; batchNumber: string; date: string; status: string;
  greenBeanQuantity: number; roastedBeanQuantity: number; wasteQuantity: number;
  roastProfile: string | null; blendTiming: string | null;
  isBlend: boolean;
  bags3kg: number; bags1kg: number; bags250g: number; bags150g: number; samplesGrams: number;
  parentBatchId: string | null;
  parentBatch: { id: string; batchNumber: string } | null;
  greenBean: { beanType: string } | null;
  // Nullable since roast-to-stock: a batch roasted for the shelf has no order behind it.
  orderItem: { beanTypeName: string; order: { orderNumber: number; customer: { name: string } } } | null;
  qcRecords: { id: string; onProfile: boolean }[];
  childBatches: { id: string; batchNumber: string }[];
  blendInputs: { id: string; sourceBatchId: string; quantityUsed: number; sourceBatch: { batchNumber: string } }[];
  blendOutputs: { id: string; targetBlendBatchId: string; quantityUsed: number; targetBlendBatch: { batchNumber: string } }[];
};

type CustomerPref = { id: string; greenBeanId: string; profileName: string; usageType?: string };

type OrderItem = {
  id: string; beanTypeName: string; quantityKg: number; productionStatus: string;
  /** Kilograms preparation review covered from the shelf. Null until the review runs. */
  availableQuantity: number | null;
  greenBeanId: string | null; greenBean: { id: string; beanType: string; quantityKg: number } | null;
  order: { orderNumber: number; customer: { name: string; roastPreferences: CustomerPref[] } };
  // `status` is already returned by GET /api/orders (the include selects every scalar on the
  // batch); it was simply not declared here, so the screen could not tell a rejected roast
  // from a good one and counted both as produced progress. See producedFinishedKg below.
  roastingBatches: { batchNumber: string; greenBeanQuantity: number; roastedBeanQuantity: number; isBlend: boolean; status: string }[];
  // The sellable unit this line was ordered in, when it was ordered as one. Already in the
  // GET /api/orders payload (the item include selects productSku); it was simply not
  // declared here, so a line ordered as 240 x 250g bags could only be shown as 60kg.
  productSku?: { skuCode: string; weightGrams: number } | null;
  productionOrders?: { id: string; productionNumber: string; status: string }[];
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

function formatKg(value: number): string {
  return String(parseFloat(value.toFixed(3)));
}

export default function ProductionPage() {
  const user = useUser();
  const { t, lang } = useI18n();
  const canStartBatch = hasSubPrivilege(user?.permissions ?? {}, "production", "start_batch");
  const canBlend = hasSubPrivilege(user?.permissions ?? {}, "production", "blend");
  const canRoastToStock = hasSubPrivilege(user?.permissions ?? {}, "production", "roast_to_stock");
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
    greenBeanId: "", greenBeanQuantity: 0, roastedBeanQuantity: 0, roastProfile: "", productId: "",
  });
  const [products, setProducts] = useState<{ id: string; productNameEn: string; productNameAr: string | null }[]>([]);
  // Roast-to-stock: no order behind the batch, so its output lands on the shelf free for
  // whichever order needs it first.
  const [stockMode, setStockMode] = useState(false);
  // FINISHED kilograms this line still needs, kept separate from anything the operator
  // types into the green-weight field. Holding it in its own piece of state is the point:
  // the two numbers used to share one, which is how a finished remainder ended up being
  // submitted as a green weight.
  const [remainingFinishedKg, setRemainingFinishedKg] = useState(0);
  // Which production plan this roast is being made for. Preselected when the line has only
  // one live plan; left empty when it has several, because that is a decision only the
  // operator standing at the roaster can make. The server refuses an ambiguous roast, so an
  // empty value here surfaces as a clear refusal rather than a silently unattributed batch.
  const [poChoice, setPoChoice] = useState("");

  // Profile overrides (keyed by orderItemId) — local state for per-session profile hints
  const [profileOverrides, setProfileOverrides] = useState<Record<string, string>>({});
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);

  // Blend form
  const [showBlendForm, setShowBlendForm] = useState(false);
  const [blendSelected, setBlendSelected] = useState<Set<string>>(new Set());

  // Tab
  const [tab, setTab] = useState<"pending" | "batches">("pending");

  // Pending tab filter state
  const [pendingSearch, setPendingSearch] = useState("");
  const [pendingBean, setPendingBean] = useState("");
  const [pendingOrder, setPendingOrder] = useState("");

  // Overproduction confirmation
  const [overproductionExcess, setOverproductionExcess] = useState<number | null>(null);
  // The server will not authorize surplus production on the strength of a click: it wants
  // surplusOverride together with a written reason, and refuses an admin without one. The
  // dialog used to send neither, so Add as Surplus could not authorize anything at all.
  const [surplusReason, setSurplusReason] = useState("");
  const [surplusError, setSurplusError] = useState<string | null>(null);

  // Cancel batch modal
  const [cancelBatch, setCancelBatch] = useState<Batch | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Blending is the one mutating action here with no backend retry protection: the route is
  // concurrency-safe — two blends cannot spend the same roasted coffee twice — but it is not
  // idempotent, so two submissions of the same intent against sources that have room both
  // succeed and two blend batches exist where the operator meant one. A button that stays
  // live while its own request is in flight is the likeliest way to send the second.
  //
  // This is defence in depth and NOT idempotency: it removes the everyday cause (a double
  // click, an impatient second press) and does nothing about a retried request, a refreshed
  // tab or a direct API call. Durable protection needs a request key and a uniqueness
  // constraint, the way packaging got one — which is a schema change, and is recorded for
  // the migration decision rather than smuggled in here.
  const [blending, setBlending] = useState(false);

  // Edit date modal
  const [editDateBatch, setEditDateBatch] = useState<EditableBatch | null>(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    const [ordersRes, beansRes, batchRes, productsRes] = await Promise.all([
      fetch("/api/orders?status=Pending,In+Production"),
      fetch("/api/green-beans"),
      fetch("/api/roasting-batches"),
      // Needed only by the roast-to-stock path, which must name the product it produces.
      fetch("/api/coffee-products/summary"),
    ]);
    if (ordersRes.ok) setOrders(await ordersRes.json());
    if (beansRes.ok) setBeans(await beansRes.json());
    if (productsRes.ok) setProducts(await productsRes.json());
    if (batchRes.ok) setBatches(await batchRes.json());
  }

  function startProduction(item: OrderItem) {
    setStockMode(false);
    setSelectedItem(item);
    // ── Finished demand, in finished kilograms ──────────────────────────────
    // The figure below is what the ORDER still needs: finished coffee. It is deliberately
    // NOT written into the green-weight field. The previous version summed greenBeanQuantity
    // — the weight loaded into the roaster — subtracted it from quantityKg, which is finished
    // weight, and then prefilled the green input with the result. Two different physical
    // quantities were being treated as one, and because roasting always loses weight the
    // suggestion was short every time.
    //
    // Converting finished demand to a green weight needs the coffee's roast loss, which this
    // screen does not have. The operator weighs what goes into the roaster, so the green
    // field is left for them to fill; the remaining demand is shown beside it as context.
    // A rejected roast produced nothing usable, so it is not progress. Counting it made the
    // line look partly covered and hid the work that still has to be done again.
    const producedFinishedKg = item.roastingBatches
      .filter((b) => !b.isBlend && b.status !== "Rejected")
      .reduce((s: number, b) => s + b.roastedBeanQuantity, 0);
    const coveredFromShelf = item.availableQuantity ?? 0;
    const remainingFinishedKg = Number(
      Math.max(0, item.quantityKg - coveredFromShelf - producedFinishedKg).toFixed(3),
    );
    setRemainingFinishedKg(remainingFinishedKg);
    const pref = item.order.customer.roastPreferences?.find((p) => p.greenBeanId === item.greenBeanId);
    const profileHint = profileOverrides[item.id] ?? pref?.profileName ?? "";
    const livePos = livePosFor(item);
    setPoChoice(livePos.length === 1 ? livePos[0].id : "");
    setRoastForm({ greenBeanId: item.greenBeanId || "", greenBeanQuantity: 0, roastedBeanQuantity: 0, roastProfile: profileHint, productId: "" });
    setError(""); setSuccess("");
    setShowRoastForm(true);
  }

  function closeRoastForm() {
    setShowRoastForm(false);
    // Never leave stock mode armed: the next order-driven roast would post without its
    // order item and silently become a stock batch.
    setStockMode(false);
  }

  function startStockProduction() {
    setStockMode(true);
    setSelectedItem(null);
    setRoastForm({ greenBeanId: "", greenBeanQuantity: 0, roastedBeanQuantity: 0, roastProfile: "", productId: "" });
    setError(""); setSuccess("");
    setShowRoastForm(true);
  }

  /**
   * The single live production order for a line, or undefined.
   *
   * Undefined when there is none and, deliberately, when there is more than one: choosing
   * between them is not something a screen should do silently, and the server refuses a
   * mismatched pairing anyway.
   */
  function livePosFor(item: OrderItem | null): { id: string; productionNumber: string; status: string }[] {
    return (item?.productionOrders ?? []).filter(
      (p) => p.status === "PENDING" || p.status === "IN_PRODUCTION",
    );
  }

  async function handleRoastSubmit(e: React.FormEvent, forceSubmit = false) {
    e.preventDefault();
    setError("");
    setSurplusError(null);

    if (roastForm.greenBeanId) {
      const bean = beans.find((b) => b.id === roastForm.greenBeanId);
      if (bean && bean.quantityKg < roastForm.greenBeanQuantity) {
        setError(`${t("insufficientStock")} ${bean.quantityKg}kg`);
        return;
      }
    }

    if (!forceSubmit && !stockMode && selectedItem) {
      // A courtesy warning only — the server holds the real ceiling and computes it from
      // the canonical planning figures, which include scheduled production this screen
      // cannot see. remainingFinishedKg has already had produced output and shelf cover
      // subtracted, so the comparison here is finished against finished.
      const excess = +(roastForm.roastedBeanQuantity - remainingFinishedKg).toFixed(2);
      if (excess > 0) {
        setOverproductionExcess(excess);
        setSurplusReason("");
        return;
      }
    }

    const wasteQuantity = Math.max(0, +(roastForm.greenBeanQuantity - roastForm.roastedBeanQuantity).toFixed(2));
    const res = await fetch("/api/roasting-batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Omitting orderItemId is what makes this a stock batch.
        orderItemId: stockMode ? undefined : selectedItem!.id,
        productId: stockMode ? roastForm.productId : undefined,
        greenBeanId: roastForm.greenBeanId || undefined,
        greenBeanQuantity: roastForm.greenBeanQuantity,
        roastedBeanQuantity: roastForm.roastedBeanQuantity,
        wasteQuantity,
        roastProfile: roastForm.roastProfile || undefined,
        // The production order this roast is being made for, when the line has exactly one
        // live one. Without it the batch was stored unlinked and the production order could
        // never account for what had been roasted against it. The server validates the id
        // and derives it anyway when it is unambiguous, so this is the screen stating what
        // it is looking at rather than the only route to the link.
        productionOrderId: stockMode ? undefined : (poChoice || undefined),
        // Only on the deliberate second submit, and only ever what the operator typed.
        ...(forceSubmit ? { surplusOverride: true, surplusReason: surplusReason.trim() } : {}),
      }),
    });

    if (!res.ok) {
      try {
        const data = await res.json();
        if (forceSubmit) {
          setSurplusError(data.error || "Failed to create batch");
        } else {
          setError(data.error || "Failed to create batch");
        }
      } catch {
        if (forceSubmit) {
          setSurplusError("Failed to create batch");
        } else {
          setError("Failed to create batch");
        }
      }
      return;
    }

    setOverproductionExcess(null);
    setSuccess(t("batchCreated"));
    closeRoastForm();
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
    // Guarded on the state itself rather than only on the disabled attribute: the attribute
    // stops the pointer, this stops everything else — a keyboard activation, a queued click
    // delivered before React re-renders, a second call from anywhere.
    if (blending) return;
    setBlending(true);
    setError("");
    const ids = Array.from(blendSelected);
    try {
      const res = await fetch("/api/roasting-batches/blend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchIds: ids }),
      });
      if (!res.ok) {
        // A refusal is deterministic — the server did not blend — so the form reopens with
        // the selection intact and the operator may correct and retry.
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
    } catch {
      // A network failure is NOT deterministic: the blend may or may not have committed.
      // Saying so is more honest than inviting a retry that could double it.
      setError("The blend could not be confirmed. Reload the batch list before trying again.");
    } finally {
      setBlending(false);
    }
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

  // Defence in depth only — the backend is the authority (see productionGateRefusal in
  // services/order-operations). An operator must not be offered Start Production for work
  // the server will refuse, so canStartProduction applies the same conditions the gate
  // does: the order is in a production-entry status, the line has been through preparation
  // review, and it is not blocked. Approval is NOT among them — it no longer gates the
  // normal path. Every field is already in the /api/orders payload; nothing was added to it.
  const pendingItems = orders.flatMap((o: any) =>
    o.items
      .filter((i: { preparationDecision: string | null }) => canStartProduction(o, i))
      .filter((i: any) => i.productionStatus !== "Completed" && i.productionStatus !== "Order cancelled")
      // A line preparation covered entirely from the shelf is not production work, and
      // listing it here invented a roasting task for coffee the order already holds.
      //
      // Display only. The server gate deliberately does not refuse these (see
      // productionGateRefusal: productionRequiredQuantity goes stale, so the live shortfall
      // is recomputed per caller), and canStartProduction still mirrors the gate exactly.
      // If coverage later evaporates, preparation review is re-run and the line reappears
      // here with a decision that reflects the shortfall.
      .filter((i: { preparationDecision: string | null }) => i.preparationDecision !== "Available on Shelf")
      .map((i: any) => ({
        ...i,
        order: {
          orderNumber: o.orderNumber,
          customer: {
            name: o.customer?.name,
            roastPreferences: o.customer?.roastPreferences ?? [],
          },
        },
      }))
      .filter((i: any) => {
        // Roasted output against ordered finished weight. Summing greenBeanQuantity here
        // compared roaster INPUT against customer OUTPUT and hid lines that still needed
        // roasting, because the green figure is always the larger of the two.
        // Rejected roasts are not progress — a line whose only roast failed QC must stay in
        // the queue rather than disappearing from it as though it were covered.
        const producedFinishedKg = (i.roastingBatches ?? [])
          .filter((b: any) => !b.isBlend && b.status !== "Rejected")
          .reduce((s: number, b: any) => s + b.roastedBeanQuantity, 0);
        return i.quantityKg - producedFinishedKg > 0;
      })
  );

  const pendingBeanOptions = useMemo<FilterOption[]>(() => {
    const seen = new Set<string>();
    const opts: FilterOption[] = [];
    for (const item of pendingItems) {
      const v = item.beanTypeName;
      if (!seen.has(v)) { seen.add(v); opts.push({ label: v, value: v }); }
    }
    return opts;
  }, [pendingItems]);

  const pendingOrderOptions = useMemo<FilterOption[]>(() => {
    const seen = new Set<string>();
    const opts: FilterOption[] = [];
    for (const item of pendingItems) {
      const v = String(item.order.orderNumber);
      if (!seen.has(v)) { seen.add(v); opts.push({ label: `#${v} – ${item.order.customer.name}`, value: v }); }
    }
    return opts;
  }, [pendingItems]);

  const filteredPending = useMemo(() => {
    const q = pendingSearch.toLowerCase();
    return pendingItems.filter((item: OrderItem) => {
      if (pendingBean && item.beanTypeName !== pendingBean) return false;
      if (pendingOrder && String(item.order.orderNumber) !== pendingOrder) return false;
      if (q) {
        const haystack = `${item.order.orderNumber} ${item.order.customer.name} ${item.beanTypeName}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [pendingItems, pendingSearch, pendingBean, pendingOrder]);

  const passedBatches = batches.filter((b) => b.status === "Passed");
  const pendingQcBatches = batches.filter((b) => b.status === "Pending QC");
  const blendableBatches = batches.filter((b) => (b.status === "Passed" || b.status === "Pending QC") && !b.isBlend);

  function toExportRows(list: Batch[]): BatchExportRow[] {
    return list.map((b) => ({
      batchNumber: b.batchNumber,
      date: formatDate(b.date),
      customer: (b.orderItem?.order.customer.name ?? t("stockBatchLabel")),
      orderNumber: (b.orderItem?.order.orderNumber ?? t("stockBatchLabel")),
      beanType: b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? ""),
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
        <div className="flex items-center gap-2 flex-wrap">
          {canStartBatch && canRoastToStock && (
            <button onClick={startStockProduction}
              className="flex items-center gap-2 px-4 py-2.5 bg-orange text-white rounded-xl font-bold text-sm hover:bg-orange-dark transition-all duration-200 shadow-md active:scale-[0.98]">
              <Boxes size={16} /> {t("roastToStock")}
            </button>
          )}
          {canBlend && blendableBatches.length >= 2 && (
            <button onClick={() => { setShowBlendForm(true); setBlendSelected(new Set()); setError(""); }}
              className="flex items-center gap-2 px-4 py-2.5 bg-slate text-white rounded-xl font-bold text-sm hover:bg-slate-dark transition-all duration-200 shadow-md">
              <Merge size={16} /> {t("blendBatches")}
            </button>
          )}
        </div>
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
        <div className="space-y-3">
          {pendingItems.length > 0 && (
            <WorkflowFilterBar
              searchQuery={pendingSearch} onSearchChange={setPendingSearch}
              beanOptions={pendingBeanOptions} selectedBean={pendingBean} onBeanChange={setPendingBean}
              orderOptions={pendingOrderOptions} selectedOrder={pendingOrder} onOrderChange={setPendingOrder}
              resultCount={filteredPending.length} totalCount={pendingItems.length}
            />
          )}
          {filteredPending.length === 0 ? (
            <div className="text-center py-8 bg-white rounded-2xl border border-border text-brown/40">
              <Factory size={32} className="mx-auto mb-2 opacity-50" /><p className="font-semibold">{t("noPendingItems")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredPending.map((item: OrderItem) => {
                // Both sides finished weight. Charting green input against a finished target
                // overstated progress on every line, since green is always heavier.
                const produced = item.roastingBatches.filter((b) => !b.isBlend && b.status !== "Rejected").reduce((s: number, b) => s + b.roastedBeanQuantity, 0);
                const remaining = item.quantityKg - produced;
                const progress = item.quantityKg > 0 ? (produced / item.quantityKg) * 100 : 0;
                // Required / Produced / Remaining in the unit the line was ORDERED in. A
                // line sold as 240 x 250g bags is worked in bags; only a legacy line with no
                // SKU behind it is worked in kilograms. Roasting still happens by weight, so
                // the kilogram figure stays on the card as an explicitly-labelled aside
                // rather than as one of the three numbers.
                const unitKg = item.productSku && item.productSku.weightGrams > 0 ? item.productSku.weightGrams / 1000 : 0;
                const inUnits = unitKg > 0;
                // Whole units only: a part-filled bag is not a produced bag.
                const requiredDisp = inUnits ? Math.round(item.quantityKg / unitKg) : item.quantityKg;
                const producedDisp = inUnits ? Math.floor(produced / unitKg) : produced;
                const remainingDisp = inUnits ? Math.max(0, requiredDisp - producedDisp) : Math.max(0, remaining);
                // A roast that failed QC no longer counts as progress (see producedFinishedKg),
                // which is correct but silent: the line simply stayed in the queue with no
                // explanation. Surfaced here so the reason for the outstanding work is visible.
                const rejectedCount = item.roastingBatches.filter((b) => !b.isBlend && b.status === "Rejected").length;
                return (
                  <div key={item.id} data-testid={`roast-item-${item.order.orderNumber}`} className="bg-white rounded-2xl border border-border p-4 hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300">
                    <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-charcoal">#{item.order.orderNumber} — {item.order.customer.name}</p>
                        {/* The translation already carries the unit ("kg ordered"), so the
                            literal kg here was rendering "12kg kg ordered". */}
                        <p className="text-sm text-brown font-medium">{item.beanTypeName} — {inUnits ? <>{requiredDisp} × {item.productSku!.skuCode}</> : <>{item.quantityKg} {t("kgOrdered")}</>}</p>
                        {/* The plan this work belongs to, printed on the task itself. A
                            separate production-order card would have been a second copy of
                            the same job, and the operator would have had to match them by
                            hand. Every live plan is listed: when there is more than one the
                            roast form asks which, and hiding the extras here would make that
                            question arrive from nowhere. */}
                        {livePosFor(item).length > 0 && (
                          <p className="flex flex-wrap items-center gap-1 mt-1">
                            {livePosFor(item).map((p) => (
                              <span
                                key={p.id}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-300 font-mono"
                              >
                                {t("prodOrderRef")} {p.productionNumber}
                              </span>
                            ))}
                          </p>
                        )}
                        {rejectedCount > 0 && (
                          <p className="mt-1">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-800 border border-red-300">
                              <AlertTriangle size={11} aria-hidden="true" /> {rejectedCount} {t("prodRejectedRoasts")}
                            </span>
                          </p>
                        )}
                        {/* Customer roast profile badge */}
                        {editingProfileId === item.id ? (
                          <div className="flex items-center gap-2 mt-1">
                            <input
                              type="text"
                              placeholder={t("overrideProfile")}
                              defaultValue={profileOverrides[item.id] ?? item.order.customer.roastPreferences?.find((p: CustomerPref) => p.greenBeanId === item.greenBeanId)?.profileName ?? ""}
                              autoFocus
                              className="text-xs px-2 py-1 border border-orange rounded-lg focus:ring-2 focus:ring-orange/20 outline-none w-40"
                              onBlur={(e) => {
                                const val = e.target.value.trim();
                                setProfileOverrides((prev) => ({ ...prev, [item.id]: val }));
                                setEditingProfileId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  const val = (e.target as HTMLInputElement).value.trim();
                                  setProfileOverrides((prev) => ({ ...prev, [item.id]: val }));
                                  setEditingProfileId(null);
                                }
                                if (e.key === "Escape") setEditingProfileId(null);
                              }}
                            />
                          </div>
                        ) : (() => {
                          const pref = item.order.customer.roastPreferences?.find((p: CustomerPref) => p.greenBeanId === item.greenBeanId);
                          const displayProfile = profileOverrides[item.id] ?? pref?.profileName ?? null;
                          return (
                            <div className="flex items-center gap-1.5 mt-1">
                              {displayProfile ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                                  ⭐ {t("customerPrefBadge")}: {displayProfile}
                                  {pref?.usageType && pref.usageType !== "BOTH" && (
                                    <span className="opacity-70">
                                      ({pref.usageType === "ESPRESSO" ? t("usageEspresso") : t("usageFilter")})
                                    </span>
                                  )}
                                  {pref?.usageType === "BOTH" && (
                                    <span className="opacity-70">({t("usageBoth")})</span>
                                  )}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500">
                                  {t("standardBadge")}
                                </span>
                              )}
                              <button
                                onClick={() => setEditingProfileId(item.id)}
                                className="p-0.5 rounded text-brown/30 hover:text-orange transition-colors"
                                title={t("overrideProfile")}
                              >
                                <Pencil size={11} />
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                      {canStartBatch && (
                        <button onClick={() => startProduction(item)}
                          className="w-full xl:w-auto flex items-center justify-center flex-shrink-0 px-4 py-2 bg-orange text-white rounded-xl text-sm font-bold hover:bg-orange-dark shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200">
                          {produced > 0 ? t("continueProd") : t("startProduction")}
                        </button>
                      )}
                    </div>
                    {/* Required / Produced / Remaining — always shown, always in finished
                        kilograms. These figures used to appear only once a first roast
                        existed, so a fresh task carried no number an operator could act on. */}
                    <div>
                      <div className="flex justify-between gap-2 text-xs text-brown mb-1">
                        <span>{inUnits ? `${requiredDisp} ${t("unitsRequired")}` : `${formatKg(item.quantityKg)}kg ${t("requiredKg")}`}</span>
                        <span>{inUnits ? `${producedDisp} ${t("unitsProduced")}` : `${formatKg(produced)}kg ${t("producedKg")}`}</span>
                        <span className="font-bold text-charcoal">{inUnits ? `${remainingDisp} ${t("unitsRemaining")}` : `${formatKg(Math.max(0, remaining))}kg ${t("remainingKg")}`}</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2">
                        <div className="bg-orange h-2 rounded-full transition-all" style={{ width: `${Math.min(progress, 100)}%` }} />
                      </div>
                      {/* Roasting is done by weight whatever the line was sold in, so the
                          kilograms stay on the card — labelled as the roasting figure, not
                          mixed in with the three numbers above. */}
                      {inUnits && remaining > 0 && (
                        <p className="text-[11px] text-brown/50 mt-1">
                          ≈ {formatKg(Math.max(0, remaining))}kg {t("toRoastAside")}
                        </p>
                      )}
                      {produced > 0 && (
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
                      )}
                    </div>
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
                className="flex items-center gap-1.5 px-3 py-2 bg-[#6B7280] text-white rounded-xl text-xs font-bold hover:bg-[#4B5563] shadow-sm active:scale-[0.98] transition-all">
                <FileText size={14} /> PDF
              </button>
              <button onClick={() => exportBatchesExcel(toExportRows(batches))}
                className="flex items-center gap-1.5 px-3 py-2 bg-[#4f46e5] text-white rounded-xl text-xs font-bold hover:bg-[#4338ca] shadow-sm active:scale-[0.98] transition-all">
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
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${STATUS_STYLES[batch.status] || "bg-gray-100 text-gray-600"}`}>
                        {statusLabel(batch.status, t)}
                      </span>
                      {batch.isBlend && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-violet-100 text-violet-800 border border-violet-200">
                          مزيج
                        </span>
                      )}
                      {batch.blendTiming && (
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${batch.blendTiming === "Before QC" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                          {t("blendedLabel")} {batch.blendTiming === "Before QC" ? t("blendBeforeQc") : t("blendAfterQc")}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-brown font-medium">
                      #{(batch.orderItem?.order.orderNumber ?? t("stockBatchLabel"))} — {(batch.orderItem?.order.customer.name ?? t("stockBatchLabel"))} — {batch.greenBean?.beanType || (batch.orderItem?.beanTypeName ?? "")}
                    </p>
                    <p className="text-xs text-brown/50 mt-0.5">
                      {formatKg(batch.roastedBeanQuantity)}kg {t("roastedLabel")} | {formatKg(batch.greenBeanQuantity)}kg {t("greenLabel")} | {formatDate(batch.date)}
                      {batch.roastProfile && ` | ${batch.roastProfile}`}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
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
                {batch.blendOutputs.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border">
                    <p className="text-xs text-violet-600 font-medium">
                      → {t("usedInBlend")}: {batch.blendOutputs.map((o) => o.targetBlendBatch.batchNumber).join(", ")}
                    </p>
                  </div>
                )}
                {batch.isBlend && batch.blendInputs.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border">
                    <p className="text-xs text-violet-600/70">
                      {t("blendSources")}: {batch.blendInputs.map((inp) => `${inp.sourceBatch.batchNumber} (${formatKg(inp.quantityUsed)}kg)`).join(" + ")}
                    </p>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Overproduction Confirmation Modal */}
      {overproductionExcess !== null && selectedItem && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-start gap-3 mb-4">
              <div className="p-2 bg-amber-100 rounded-xl shrink-0">
                <span className="text-2xl">⚠️</span>
              </div>
              <div>
                <h3 className="font-extrabold text-charcoal text-base">{t("overprodWarnTitle")}</h3>
                <p className="text-sm text-brown mt-1">
                  {t("overprodWarnBody")}{" "}
                  <span className="font-bold text-amber-700">+{formatKg(overproductionExcess)}kg</span>
                  {". "}
                  {t("overprodWarnConfirm")}
                </p>
                <p className="text-xs text-brown/60 mt-2">
                  {t("requiredQtyLabel")}: {selectedItem.quantityKg}kg — {t("totalProducedLabel")}: {+(
                    selectedItem.roastingBatches.filter((b) => !b.isBlend && b.status !== "Rejected").reduce((s, b) => s + b.roastedBeanQuantity, 0) +
                    roastForm.roastedBeanQuantity
                  ).toFixed(2)}kg
                </p>
              </div>
            </div>
            {surplusError ? (
              <div className="space-y-3">
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2.5 rounded-xl text-sm font-semibold">
                  {surplusError}
                </div>
                <button
                  onClick={() => { setOverproductionExcess(null); setSurplusError(null); }}
                  className="w-full py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
                  {t("cancel")}
                </button>
              </div>
            ) : (
              <>
              <label className="block mb-3">
                <span className="block text-xs font-bold text-charcoal mb-1">
                  {t("surplusReasonLabel")} <span className="text-red-500">*</span>
                </span>
                <textarea
                  value={surplusReason}
                  onChange={(e) => setSurplusReason(e.target.value)}
                  rows={2}
                  placeholder={t("surplusReasonPlaceholder")}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors resize-none"
                />
              </label>
              <div className="flex gap-3">
                <button
                  disabled={surplusReason.trim().length < 8}
                  onClick={async () => {
                    setSurplusError(null);
                    const fakeEvent = { preventDefault: () => {} } as React.FormEvent;
                    await handleRoastSubmit(fakeEvent, true);
                  }}
                  className="flex-1 py-3 bg-amber-500 text-white rounded-xl font-bold hover:bg-amber-600 active:scale-[0.98] transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed">
                  {t("addAsSurplus")}
                </button>
                <button
                  onClick={() => { setOverproductionExcess(null); setSurplusError(null); }}
                  className="flex-1 py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
                  {t("cancel")}
                </button>
              </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Roast Form Modal */}
      {showRoastForm && (selectedItem || stockMode) && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) closeRoastForm(); }}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg">
            <h2 className="text-lg font-extrabold text-charcoal mb-1">
              {stockMode ? t("roastToStockTitle") : t("recordRoastTitle")}
            </h2>
            {stockMode ? (
              <p className="text-sm text-brown font-medium mb-4">{t("roastToStockHint")}</p>
            ) : (
              <p className="text-sm text-brown font-medium mb-4">#{selectedItem!.order.orderNumber} — {selectedItem!.beanTypeName}</p>
            )}
            <p className="text-xs text-brown/50 mb-4">{t("snAutoGenerated")}</p>
            <form onSubmit={handleRoastSubmit} className="space-y-3">
              {/* The page-level error banner sits behind this modal's backdrop, so a failed
                  submit from here has to report itself inside the dialog. */}
              {error && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold px-3 py-2 rounded-xl">
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
                </div>
              )}
              {stockMode && (
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1">{t("productLabel")}</label>
                  <select value={roastForm.productId} onChange={(e) => setRoastForm({ ...roastForm, productId: e.target.value })}
                    className="w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required>
                    <option value="">{t("selectProduct")}</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{lang === "ar" ? (p.productNameAr ?? p.productNameEn) : p.productNameEn}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-brown/60">{t("roastToStockProductHint")}</p>
                </div>
              )}
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1">{t("greenBeanSource")}</label>
                <select value={roastForm.greenBeanId} onChange={(e) => setRoastForm({ ...roastForm, greenBeanId: e.target.value })}
                  className="w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required>
                  <option value="">{t("selectBeanStock")}</option>
                  {beans.map((b) => (
                    <option key={b.id} value={b.id}>{b.beanType} ({b.serialNumber}) — {formatKg(b.quantityKg)}kg</option>
                  ))}
                </select>
              </div>
              {!stockMode && livePosFor(selectedItem).length > 1 && (
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1">
                    Production order
                  </label>
                  <select
                    value={poChoice}
                    onChange={(e) => setPoChoice(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
                  >
                    <option value="">Select which production order this roast is for…</option>
                    {livePosFor(selectedItem).map((p) => (
                      <option key={p.id} value={p.id}>{p.productionNumber} — {p.status}</option>
                    ))}
                  </select>
                </div>
              )}
              {!stockMode && remainingFinishedKg > 0 && (
                <p className="text-sm text-brown/70">
                  {/* FINISHED kilograms still owed. Shown as context beside the green field,
                      never written into it: converting this to a green weight needs the
                      coffee's roast loss, which this screen does not hold. */}
                  Still to produce: {formatKg(remainingFinishedKg)}kg finished
                </p>
              )}
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
                const roastedIsZero  = roastForm.roastedBeanQuantity <= 0;
                const selectedBean = roastForm.greenBeanId
                  ? beans.find((b) => b.id === roastForm.greenBeanId) ?? null
                  : null;
                const insufficientStock =
                  selectedBean !== null &&
                  roastForm.greenBeanQuantity > 0 &&
                  roastForm.greenBeanQuantity > selectedBean.quantityKg;
                const greenQtyInvalid = roastForm.greenBeanQuantity <= 0;
                // greenBeanId is required by the API for every direct roast, and a stock
                // roast has no order item to prefill it from — so the button must reflect
                // that rather than letting the user submit into a 400.
                const submitDisabled =
                  roastedExceeds || roastedIsZero || insufficientStock || greenQtyInvalid ||
                  !roastForm.greenBeanId || (stockMode && !roastForm.productId);
                return (
                  <>
                    {greenQtyInvalid && (
                      <div className="text-sm font-bold px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700">
                        Green bean quantity must be greater than 0.
                      </div>
                    )}
                    {roastedIsZero && (
                      <div className="text-sm font-bold px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700">
                        Roasted quantity must be greater than 0.
                      </div>
                    )}
                    {roastedExceeds && (
                      <div className="text-sm font-bold px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700">
                        {t("roastedExceedsGreen")}
                      </div>
                    )}
                    {insufficientStock && selectedBean && (
                      <div className="text-sm font-bold px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700">
                        Insufficient stock. Available: {formatKg(selectedBean.quantityKg)} kg.
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-bold text-charcoal mb-1">{t("wasteKg")}</label>
                        <input type="number" step="0.01"
                          value={Math.max(0, +(roastForm.greenBeanQuantity - roastForm.roastedBeanQuantity).toFixed(2))}
                          readOnly className="w-full px-3 py-2.5 border-2 border-border rounded-xl bg-cream/50 text-brown outline-none" />
                        {roastForm.greenBeanQuantity > 0 && roastForm.roastedBeanQuantity > 0 && !roastedExceeds && (
                          <p className="text-xs text-gray-500 mt-1">
                            Loss rate: {(((roastForm.greenBeanQuantity - roastForm.roastedBeanQuantity) / roastForm.greenBeanQuantity) * 100).toFixed(1)}%
                          </p>
                        )}
                      </div>
                      <div>
                        <label className="block text-sm font-bold text-charcoal mb-1">{t("roastProfileLabel")}</label>
                        <input type="text" value={roastForm.roastProfile}
                          onChange={(e) => setRoastForm({ ...roastForm, roastProfile: e.target.value })}
                          className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" placeholder={t("roastProfilePlaceholder")} />
                      </div>
                    </div>
                    <div className="flex gap-3 pt-2">
                      <button type="submit" disabled={submitDisabled}
                        className={`flex-1 py-3 rounded-xl font-bold shadow-md active:scale-[0.98] transition-all duration-200 ${submitDisabled ? "bg-gray-300 text-gray-500 cursor-not-allowed shadow-none" : "bg-orange text-white hover:bg-orange-dark shadow-orange/20"}`}>
                        {t("recordBatch")}
                      </button>
                      <button type="button" onClick={() => closeRoastForm()} className="flex-1 py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
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
        // Blending an order's coffee together with stock coffee has no single right answer:
        // the result either swallows the order's production into free stock, or claims
        // unowned stock for an order that never asked for it. The server refuses such a
        // selection; say so here rather than letting the operator discover it on submit.
        const owners = new Set(selectedBatches.map((b) => (b.orderItem ? "order" : "stock")));
        const mixesOwnership = owners.size > 1;
        const distinctOrderItems = new Set(
          selectedBatches.filter((b) => b.orderItem).map((b) => b.orderItem!.order.orderNumber)
        );
        const mixesOrders = distinctOrderItems.size > 1;
        const canSubmit = blendSelected.size >= 2 && !isMixed && !mixesOwnership && !mixesOrders;
        return (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) setShowBlendForm(false); }}>
            <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto">
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
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${batch.orderItem ? "bg-info-bg text-slate" : "bg-amber-100 text-amber-800"}`}>
                              {batch.orderItem ? `#${batch.orderItem.order.orderNumber}` : t("stockBatchLabel")}
                            </span>
                          </div>
                          <p className="text-xs text-brown">{batch.greenBean?.beanType || (batch.orderItem?.beanTypeName ?? "")} — {batch.roastedBeanQuantity}kg</p>
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
              {(mixesOwnership || mixesOrders) && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-xl text-xs font-bold mb-4">
                  {mixesOwnership ? t("cannotMixStockAndOrder") : t("cannotMixOrders")}
                </div>
              )}
              {blendSelected.size >= 2 && !isMixed && !mixesOwnership && !mixesOrders && (
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
                <button onClick={handleBlend} disabled={!canSubmit || blending}
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
