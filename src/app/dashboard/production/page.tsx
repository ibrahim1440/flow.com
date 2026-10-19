"use client";

import { Select } from "@/components/ui/Select";
import { Fragment, useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, Merge, Boxes, FileText, FileSpreadsheet, Trash2, CalendarDays, Pencil } from "lucide-react";
import { Btn, Dot, Metrics, Notice, OpsBanner, OpsEmpty, OpsError, OpsLoading, OpsPane, OpsRoot, PageHeader, SecHead, StatusDot, Tabs, kg, type Tone, Kg, opsDate } from "@/components/ops/ui";
import EditDateModal, { type EditableBatch } from "@/components/EditDateModal";
import WorkflowFilterBar, { type FilterOption } from "@/components/WorkflowFilterBar";
import { exportBatchesPDF, exportBatchesExcel, type BatchExportRow } from "@/lib/export";
import { PRINT_PHASE1_NOTE_ID, PrintPhase1Notice, usePrintCertified } from "@/components/print/Certification";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { canStartProduction } from "@/lib/order-operations-client";
import { useI18n } from "@/lib/i18n/context";
import { type TranslationKey } from "@/lib/i18n/translations";

import { RestockReason, restockReasonOk } from "@/components/ops/RestockReason";
type Batch = {
  id: string; batchNumber: string; date: string; status: string;
  /** When the batch was recorded (the reference log lists batches by this time). */
  createdAt: string;
  /** The 48-hour QC reminder, computed by the batches API. */
  qcDeadline?: string | null;
  greenBeanQuantity: number; roastedBeanQuantity: number; wasteQuantity: number;
  roastProfile: string | null; blendTiming: string | null;
  isBlend: boolean;
  bags3kg: number; bags1kg: number; bags250g: number; bags150g: number; samplesGrams: number;
  parentBatchId: string | null;
  parentBatch: { id: string; batchNumber: string } | null;
  /** The green lot this roast consumed; the list payload carries the whole lot row. */
  greenBean: { beanType: string; serialNumber?: string | null } | null;
  /** Roasted kilograms not yet packed (the packaging page's «remaining» figure). */
  roastedAvailableKg?: number;
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

/** Direction 2.1 status dots for a roasting batch (label from the same translation keys). */
function batchStatusMap(t: (k: TranslationKey) => string): Record<string, [string, Tone]> {
  return {
    "Pending QC": [t("statusPendingQc"), "warning"],
    "Passed": [t("statusPassed"), "success"],
    "Partially Packaged": [t("statusPartiallyPkg"), "info"],
    "Packaged": [t("statusPackaged"), "success"],
    "Blended": [t("statusBlended"), "neutral"],
    "Rejected": [t("rejectedLabel"), "danger"],
  };
}

function formatKg(value: number): string {
  return String(parseFloat(value.toFixed(3)));
}

export default function ProductionPage() {
  const user = useUser();
  const router = useRouter();
  const { t, lang } = useI18n();
  // Owner decision D1: the batches PDF (jsPDF) is a printable document, so it follows the same
  // PRINT_CERTIFIED gate as every other print action (unknown = off). Excel stays available.
  const printing = usePrintCertified();
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
  // Validation notices appear once the roaster has touched the quantities (or tried to submit),
  // not the moment the form opens (D-3).
  const [roastTouched, setRoastTouched] = useState(false);
  // Disclosure rows of the two tables (prd-schedule / prd-overview keep one line per row).
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());
  const toggleRow = (id: string) => setOpenRows((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
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
  // The module root is the overview (prd-overview); the roasting list is the schedule tab.
  const [tab, setTab] = useState<"pending" | "batches" | "blend">("batches");

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
  // The restock reason belongs to the batch being cancelled: opening another batch starts empty.
  const [restockDraft, setRestockDraft] = useState<{ batchId: string; text: string }>({ batchId: "", text: "" });
  const restockReason = cancelBatch && restockDraft.batchId === cancelBatch.id ? restockDraft.text : "";
  const setRestockReason = (text: string) => setRestockDraft({ batchId: cancelBatch?.id ?? "", text });
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

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [openPoCount, setOpenPoCount] = useState<number | null>(null);
  async function loadData() {
    const [ordersRes, beansRes, batchRes, productsRes, posRes] = await Promise.all([
      fetch("/api/orders?status=Pending,In+Production"),
      fetch("/api/green-beans"),
      fetch("/api/roasting-batches"),
      // Needed only by the roast-to-stock path, which must name the product it produces.
      fetch("/api/coffee-products/summary"),
      // The «open production orders» tile and tab count (prd-overview), read only.
      fetch("/api/production-orders?status=PENDING,IN_PRODUCTION"),
    ]);
    // Refused responses are read to the end so the page settles (an unread body keeps the
    // connection open); a failed queue or batch list is reported, not shown as empty.
    const take = async (r: Response) => (r.ok ? r.json() : (await r.text(), null));
    const [ordersJ, beansJ, productsJ, batchJ, posJ] = await Promise.all([ordersRes, beansRes, productsRes, batchRes, posRes].map(take));
    setOpenPoCount(Array.isArray(posJ) ? posJ.length : null);
    setLoadError(ordersJ === null || batchJ === null);
    if (ordersJ) setOrders(ordersJ);
    if (beansJ) setBeans(beansJ);
    if (productsJ) setProducts(productsJ);
    if (batchJ) setBatches(batchJ);
    setLoaded(true);
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
    setRoastTouched(false);
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
    setRoastTouched(false);
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
        setError(`${t("insufficientStock")} ${bean.quantityKg} ${t("opsKgUnit")}`);
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
    // A restock is an inventory override: it carries its reason (owner decision, inventory Option A).
    const res = await fetch(`/api/roasting-batches/${cancelBatch.id}?restock=${restock}`, restock
      ? { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: restockReason.trim() }) }
      : { method: "DELETE" });
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

  const pendingQcBatches = batches.filter((b) => b.status === "Pending QC");
  const blendableBatches = batches.filter((b) => (b.status === "Passed" || b.status === "Pending QC") && !b.isBlend);

  function toExportRows(list: Batch[]): BatchExportRow[] {
    return list.map((b) => ({
      batchNumber: b.batchNumber,
      date: opsDate(b.date, lang),
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

  // Today, in the batch's own date (the roasting date the server stores, local day).
  const todayKey = new Date().toDateString();
  const todays = batches.filter((b) => new Date(b.date).toDateString() === todayKey);
  const roastedToday = todays.filter((b) => b.status !== "Rejected" && !b.isBlend).reduce((s, b) => s + b.roastedBeanQuantity, 0);
  // The packaging page's rule: accepted or partly packed batches, by what is still unpacked.
  const packableBatches = batches.filter((b) => b.status === "Passed" || b.status === "Partially Packaged");
  const packableKg = packableBatches.reduce((s, b) => s + (b.roastedAvailableKg ?? b.roastedBeanQuantity), 0);
  const now = Date.now();
  const hoursSince = (iso: string) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 3600000));
  const oldestPendingQcH = pendingQcBatches.length > 0 ? Math.max(...pendingQcBatches.map((b) => hoursSince(b.createdAt))) : 0;
  const oldestPackableH = packableBatches.length > 0 ? Math.max(...packableBatches.map((b) => hoursSince(b.createdAt))) : 0;
  // prd-schedule «سجل اليوم»: today's batches by the time they were recorded, latest first.
  const todayLog = [...todays].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  // Every live plan behind the queue, counted once (the «أوامر الإنتاج» tab count).
  const livePoIds = new Set<string>();
  const pendingPos: { id: string; productionNumber: string; orderNumber: number }[] = [];
  for (const item of pendingItems) for (const p of item.productionOrders ?? []) {
    if (p.status === "PENDING" || p.status === "IN_PRODUCTION") livePoIds.add(p.id);
    if (p.status === "PENDING" && !pendingPos.some((x) => x.id === p.id)) pendingPos.push({ id: p.id, productionNumber: p.productionNumber, orderNumber: item.order.orderNumber });
  }
  // prd-overview «يحتاج انتباهك»: rejected roasts awaiting a decision, QC waits past half the
  // 48-hour reminder, and plans that are not released yet. Oldest first, six at most.
  const rejectedBatches = batches.filter((b) => b.status === "Rejected");
  const lateQc = pendingQcBatches.filter((b) => hoursSince(b.createdAt) >= 24).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const counted = batches.filter((b) => b.status !== "Rejected" && !b.isBlend);
  const totals = {
    green: batches.reduce((s, b) => s + b.greenBeanQuantity, 0),
    roasted: batches.reduce((s, b) => s + b.roastedBeanQuantity, 0),
    countedKg: counted.reduce((s, b) => s + b.roastedBeanQuantity, 0),
  };
  const since30 = now - 30 * 86400000;
  const blendHistory = batches.filter((b) => b.isBlend && new Date(b.createdAt).getTime() >= since30);
  const stageMap = batchStatusMap(t);

  // The planned-roaster block (prd-schedule «المحمصة اليوم»). Roasters, capacities and slots are
  // not modelled yet, so every row shows the approved «غير متوفر بعد» pattern.
  const roasterBlock = (
    <section className="hr-stack" style={{ gap: 8 }} aria-label={t("opsRoasterToday")}>
      <SecHead title={t("opsRoasterToday")} caption={<Dot tone="neutral">{t("opsPlannedTag")}</Dot>} />
      <dl className="ops-props">
        <dt>{t("opsRoasterWord")}</dt><dd className="hr-muted">{t("opsNotAvailableYet")}</dd>
        <dt>{t("opsCapacity")}</dt><dd className="hr-muted">{t("opsNotAvailableYet")}</dd>
        <dt>{t("opsCurrentSlot")}</dt><dd>{todayLog[0] ? <><span className="hr-num">{opsDate(todayLog[0].createdAt, lang, true)}</span> · <span className="ops-serial">{todayLog[0].batchNumber}</span> · <Kg v={todayLog[0].roastedBeanQuantity} /></> : <span className="hr-muted">{t("opsNotAvailableYet")}</span>}</dd>
        <dt>{t("opsNextSlot")}</dt><dd className="hr-muted">{t("opsNotAvailableYet")}</dd>
        <dt>{t("opsRoastProfileRow")}</dt><dd>{t("opsFreeTextPerBatch")}</dd>
      </dl>
    </section>
  );

  const todayLogBlock = (
    <section className="hr-stack" style={{ gap: 8 }} aria-label={t("opsTodayLog")}>
      <SecHead title={t("opsTodayLog")} caption={t("opsTodayLogCaption")} />
      {todayLog.length === 0 ? <p className="hr-caption" style={{ margin: 0 }}>{t("opsNoBatchesToday")}</p> : (
        <ol className="ops-log">
          {todayLog.map((b) => {
            const [label, tone] = stageMap[b.status] ?? [b.status, "neutral" as Tone];
            return (
              <li key={b.id}>
                <span className="ops-log-time">{opsDate(b.createdAt, lang, true).replace(/^\S+\s/, "")}</span>
                <span className="ops-log-main"><span className="ops-serial">{b.batchNumber}</span> {b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? "")}</span>
                <span className="ops-log-end"><Kg strong v={b.roastedBeanQuantity} /><Dot tone={tone}>{label}{!b.orderItem ? ` · ${t("opsForStock")}` : ""}</Dot></span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );

  return (
    <OpsRoot>
    <div className={`hr-split${showBlendForm ? " has-preview" : ""}`}>
    <div className="hr-page">
      <PageHeader
        title={t("opsProductionTitle")}
        actions={(canStartBatch && canRoastToStock) || (canBlend && blendableBatches.length >= 2) ? (
          <>
            {canBlend && blendableBatches.length >= 2 && (
              <Btn onClick={() => { setShowBlendForm(true); setBlendSelected(new Set()); setError(""); }}>
                <Merge size={15} aria-hidden="true" /> {t("blendBatches")}
              </Btn>
            )}
            {canStartBatch && canRoastToStock && (
              <Btn variant="primary" onClick={startStockProduction}>
                <Boxes size={15} aria-hidden="true" /> {t("roastToStock")}
              </Btn>
            )}
          </>
        ) : null}
      >
        <span><span className="hr-num">{pendingItems.length}</span> {t("pending")} · <span className="hr-num">{pendingQcBatches.length}</span> {t("awaitingQc")}</span>
      </PageHeader>

      {error && <OpsBanner tone="danger" onClose={() => setError("")}>{error}</OpsBanner>}
      {success && <OpsBanner tone="success" onClose={() => setSuccess("")}>{success}</OpsBanner>}

      {/* Metric values are numbers only (the kit lays them out LTR); words and units go in the caption. */}

      {/* prd-schedule / prd-overview: one module strip — overview · production orders · roasting
          schedule · blending · packaging. Orders and packaging are their own routes, so those
          two tabs navigate; «التتبع والمطابقة» has no route yet and is not drawn. */}
      <Tabs
        label={t("production")}
        value={tab}
        onChange={(k) => {
          if (k === "orders") { router.push("/dashboard/production-orders"); return; }
          if (k === "packaging") { router.push("/dashboard/packaging"); return; }
          setTab(k);
        }}
        items={[
          { key: "batches" as const, label: t("opsTabOverview") },
          { key: "orders" as const, label: t("opsTabOrders"), count: openPoCount ?? livePoIds.size },
          { key: "pending" as const, label: t("opsTabSchedule"), count: pendingItems.length },
          { key: "blend" as const, label: t("opsTabBlend") },
          { key: "packaging" as const, label: t("packaging"), count: packableBatches.length },
        ]}
      />

      {/* prd-overview tiles: a number, then the unit and qualifier underneath. The phone keeps
          the first two (prd-390a). */}
      {tab === "batches" ? <Metrics items={[
        [t("opsRoastedToday"), kg(roastedToday, 1), t("opsKgUnit")],
        [t("opsAwaitingQc"), pendingQcBatches.length, oldestPendingQcH > 0 ? `${t("opsBatchesWord")} · ${t("opsOldestSince")} ${oldestPendingQcH} ${t("opsHoursShort")}` : `${t("opsBatchesWord")} · ${t("opsRejectedNotCounted")}`],
        [t("opsPackable"), kg(packableKg, 1), oldestPackableH > 0 ? `${t("opsKgUnit")} · ${t("opsOldestSince")} ${oldestPackableH} ${t("opsHoursShort")}` : t("opsKgUnit"), "hr-hide-mobile"],
        [t("opsOpenPOs"), openPoCount ?? livePoIds.size, undefined, "hr-hide-mobile"],
      ]} /> : null}

      {loadError ? <OpsError message={t("opsLoadFailed")} onRetry={loadData} /> : null}
      {!loaded && !loadError ? <OpsLoading /> : null}

      {loaded && tab === "pending" && (
        <>
          <SecHead title={t("opsWorkList")} caption={t("opsWorkListCaption")} />
          {pendingItems.length > 0 && (
            <WorkflowFilterBar
              searchQuery={pendingSearch} onSearchChange={setPendingSearch}
              beanOptions={pendingBeanOptions} selectedBean={pendingBean} onBeanChange={setPendingBean}
              orderOptions={pendingOrderOptions} selectedOrder={pendingOrder} onOrderChange={setPendingOrder}
              resultCount={filteredPending.length} totalCount={pendingItems.length}
            />
          )}
          {filteredPending.length === 0 ? (
            <OpsEmpty title={t("noPendingItems")} />
          ) : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow ops-rows" aria-label={t("opsRoastQueue")}>
                <thead>
                  <tr>
                    <th>{t("opsOrderCol")}</th>
                    <th className="hr-hide-mobile">{t("opsProductCol")}</th>
                    <th className="num">{t("requiredQtyLabel")}</th>
                    <th className="num">{t("totalProducedLabel")}</th>
                    <th className="num">{t("remainingCol")}</th>
                    <th>{t("opsScheduledCol")}</th>
                    <th className="hr-hide-compact">{t("prodOrderRef")}</th>
                    <th aria-label={t("opsActions")} />
                  </tr>
                </thead>
                <tbody>
                  {filteredPending.map((item: OrderItem) => {
                    // Both sides finished weight. Charting green input against a finished target
                    // overstated progress on every line, since green is always heavier.
                    const produced = item.roastingBatches.filter((b) => !b.isBlend && b.status !== "Rejected").reduce((s: number, b) => s + b.roastedBeanQuantity, 0);
                    const remaining = item.quantityKg - produced;
                    const inUnits = !!item.productSku && item.productSku.weightGrams > 0;
                    const unitsOf = (kgs: number) => Math.round((kgs * 1000) / item.productSku!.weightGrams);
                    const requiredDisp = inUnits ? unitsOf(item.quantityKg) : null;
                    const producedDisp = inUnits ? unitsOf(produced) : null;
                    const remainingDisp = inUnits ? Math.max(0, unitsOf(item.quantityKg) - unitsOf(produced)) : null;
                    // Rejected roasts are excluded from progress above; the count used to be
                    // silent; surfaced so the reason for the outstanding work is visible.
                    const rejectedCount = item.roastingBatches.filter((b) => !b.isBlend && b.status === "Rejected").length;
                    const pref = item.order.customer.roastPreferences?.find((p: CustomerPref) => p.greenBeanId === item.greenBeanId);
                    const displayProfile = profileOverrides[item.id] ?? pref?.profileName ?? null;
                    const pos = livePosFor(item);
                    const open = openRows.has(item.id);
                    const required = inUnits ? <span className="hr-num">{requiredDisp}</span> : <Kg v={formatKg(item.quantityKg)} />;
                    const producedCell = inUnits ? <span className="hr-num">{producedDisp}</span> : <Kg v={formatKg(produced)} />;
                    const remainingCell = inUnits ? <strong className="hr-num">{remainingDisp}</strong> : <Kg strong v={formatKg(Math.max(0, remaining))} />;
                    return (
                      <Fragment key={item.id}>
                        {/* prd-schedule: one 46 px line per order line; the plan flags, the customer's
                            roast profile and the recorded batches sit in the disclosure row below. */}
                        <tr data-testid={`roast-item-${item.order.orderNumber}`}>
                          <td className="m-title">
                            <span className="ops-rowhead">
                              <button type="button" className="ops-disclose hr-hide-mobile" aria-expanded={open} aria-label={t("opsDetails")} onClick={() => toggleRow(item.id)}><ChevronDown size={14} aria-hidden="true" /></button>
                              <span className="hr-id">#{item.order.orderNumber}</span>
                              <span className="ops-ell" style={{ maxWidth: 180 }}>{item.order.customer.name}</span>
                            </span>
                            <span className="hr-msub">
                              {item.beanTypeName}{inUnits ? <> · <span className="hr-num">{requiredDisp}</span> × <span className="ops-serial">{item.productSku!.skuCode}</span></> : null} · {t("remainingCol")} {remainingCell}
                            </span>
                          </td>
                          <td className="hr-hide-mobile"><span className="ops-ell">{item.beanTypeName}{inUnits ? <> · <span className="ops-serial">{item.productSku!.skuCode}</span></> : null}</span></td>
                          <td className="num">{required}</td>
                          <td className="num">{producedCell}</td>
                          <td className="num">{remainingCell}</td>
                          <td>
                            {pos.length > 0 ? <><span className="hr-num">{pos.length}</span> {t("opsPlannedWord")}</> : <span className="hr-muted">{t("opsNoPlan")}</span>}
                            {rejectedCount > 0 ? <> · <span className="hr-dot tone-danger"><span><span className="hr-num">{rejectedCount}</span> {t("prodRejectedRoasts")}</span></span></> : null}
                          </td>
                          <td className="hr-hide-compact">{pos[0] ? <span className="ops-serial">{pos[0].productionNumber}</span> : <span className="hr-muted">—</span>}</td>
                          <td className="m-end">
                            {canStartBatch && (
                              <Btn size="sm" variant={produced > 0 ? "secondary" : "primary"} onClick={() => startProduction(item)}>
                                {produced > 0 ? t("continueProd") : t("startProduction")}
                              </Btn>
                            )}
                          </td>
                        </tr>
                        {open ? (
                          <tr className="ops-detailrow">
                            <td colSpan={8}>
                              <div className="ops-extras">
                                {/* The plan this work belongs to, printed on the task itself. Every live
                                    plan is listed: when there is more than one the roast form asks which. */}
                                {pos.map((p) => (
                                  <span key={p.id} className="hr-flag tone-info"><span>{t("prodOrderRef")} <span className="ops-serial">{p.productionNumber}</span></span></span>
                                ))}
                                {inUnits && remaining > 0 ? <span className="hr-caption">≈ <Kg v={formatKg(Math.max(0, remaining))} /> {t("toRoastAside")}</span> : null}
                                {/* Customer roast profile (a local, per-session hint; never sent). */}
                                {editingProfileId === item.id ? (
                                  <input
                                    type="text"
                                    placeholder={t("overrideProfile")}
                                    defaultValue={profileOverrides[item.id] ?? pref?.profileName ?? ""}
                                    autoFocus
                                    className="hr-input"
                                    style={{ height: 28, width: 180 }}
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
                                ) : (
                                  <span className="hr-caption" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                    {displayProfile ? (
                                      <>
                                        {t("customerPrefBadge")}: {displayProfile}
                                        {pref?.usageType && pref.usageType !== "BOTH" ? <> ({pref.usageType === "ESPRESSO" ? t("usageEspresso") : t("usageFilter")})</> : null}
                                        {pref?.usageType === "BOTH" ? <> ({t("usageBoth")})</> : null}
                                      </>
                                    ) : t("standardBadge")}
                                    <button type="button" className="hr-btn is-ghost is-sm" style={{ height: 24, padding: "0 4px" }} onClick={() => setEditingProfileId(item.id)} title={t("overrideProfile")} aria-label={t("overrideProfile")}>
                                      <Pencil size={12} aria-hidden="true" />
                                    </button>
                                  </span>
                                )}
                                {item.roastingBatches.map((b) => {
                                  const fullBatch = canEditDate ? batches.find((x) => x.batchNumber === b.batchNumber) : undefined;
                                  return fullBatch ? (
                                    <button key={b.batchNumber} type="button" className="hr-btn is-ghost is-sm" style={{ height: 24, padding: "0 6px" }} onClick={() => setEditDateBatch(fullBatch)} title={t("editDateBtn")}>
                                      <span className="ops-serial">{b.batchNumber}</span> <CalendarDays size={11} aria-hidden="true" />
                                    </button>
                                  ) : (
                                    <span key={b.batchNumber} className="ops-serial">{b.batchNumber}</span>
                                  );
                                })}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {/* prd-schedule: today's log beside the planned-roaster block. */}
          <div className="ops-cols" style={{ marginTop: 16 }}>
            {todayLogBlock}
            {roasterBlock}
          </div>
        </>
      )}

      {loaded && tab === "blend" && (
        <>
          <SecHead
            title={t("opsBlendable")}
            caption={t("opsBlendableCaption")}
            action={canBlend && blendableBatches.length >= 2 ? (
              <Btn size="sm" onClick={() => { setShowBlendForm(true); setBlendSelected(new Set()); setError(""); }}><Merge size={14} aria-hidden="true" /> {t("blendBatches")}</Btn>
            ) : undefined}
          />
          {blendableBatches.length === 0 ? <OpsEmpty title={t("noData")} /> : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow ops-rows" aria-label={t("opsBlendable")}>
                <thead>
                  <tr>
                    <th>{t("opsBatchCol")}</th>
                    <th>{t("opsProductOrderCol")}</th>
                    <th className="num">{t("opsRoastedOutCol")}</th>
                    <th>{t("opsStatusCol")}</th>
                    <th>{t("opsRecordedCol")}</th>
                  </tr>
                </thead>
                <tbody>
                  {blendableBatches.map((b) => {
                    const product = b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? "");
                    return (
                      <tr key={b.id}>
                        <td className="m-title">
                          <span className="ops-phone-title">{product}</span>
                          <span className="ops-serial hr-hide-mobile">{b.batchNumber}</span>
                          <span className="hr-msub"><span className="ops-serial">{b.batchNumber}</span> · {opsDate(b.createdAt, lang, true)} · <StatusDot map={stageMap} value={b.status} /></span>
                        </td>
                        <td className="hr-hide-mobile"><span className="ops-ell">{product}{b.orderItem ? <> <span className="hr-id">#{b.orderItem.order.orderNumber}</span></> : <> · {t("stockBatchLabel")}</>}</span></td>
                        <td className="num m-end"><Kg strong v={b.roastedBeanQuantity} /></td>
                        <td className="hr-hide-mobile"><StatusDot map={stageMap} value={b.status} /></td>
                        <td className="hr-hide-mobile"><span className="hr-num">{opsDate(b.createdAt, lang)}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <SecHead title={t("opsBlendHistory")} caption={t("opsLast30Days")} />
          {blendHistory.length === 0 ? <p className="hr-caption" style={{ margin: 0 }}>{t("opsNoBlends")}</p> : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow ops-rows" aria-label={t("opsBlendHistory")}>
                <thead>
                  <tr>
                    <th>{t("opsBatchCol")}</th>
                    <th>{t("opsSourcesCol")}</th>
                    <th className="num">{t("opsRoastedOutCol")}</th>
                    <th>{t("opsStatusCol")}</th>
                    <th>{t("opsRecordedCol")}</th>
                  </tr>
                </thead>
                <tbody>
                  {blendHistory.map((b) => (
                    <tr key={b.id}>
                      <td className="m-title">
                        <span className="ops-phone-title">{b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? t("statusBlended"))}</span>
                        <span className="ops-serial hr-hide-mobile">{b.batchNumber}</span>
                        <span className="hr-msub"><span className="ops-serial">{b.batchNumber}</span> · {opsDate(b.createdAt, lang, true)} · <StatusDot map={stageMap} value={b.status} /></span>
                      </td>
                      <td className="hr-hide-mobile"><span className="ops-ell" style={{ maxWidth: 420 }}>{b.blendInputs.map((inp) => <Fragment key={inp.id}><span className="ops-serial">{inp.sourceBatch.batchNumber}</span> (<Kg v={inp.quantityUsed} />) </Fragment>)}</span></td>
                      <td className="num m-end"><Kg strong v={b.roastedBeanQuantity} /></td>
                      <td className="hr-hide-mobile"><StatusDot map={stageMap} value={b.status} /></td>
                      <td className="hr-hide-mobile"><span className="hr-num">{opsDate(b.createdAt, lang)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {loaded && tab === "batches" && (
        <>
          <SecHead
            title={t("allBatches")}
            caption={<><span className="hr-num">{todays.length}</span> {t("opsTodaysBatches").toLowerCase()}</>}
            action={batches.length > 0 ? (
              <span style={{ display: "inline-flex", gap: 8 }}>
                <Btn size="sm" data-testid="batches-pdf" disabled={printing !== true} aria-describedby={printing === true ? undefined : PRINT_PHASE1_NOTE_ID} onClick={() => { if (printing === true) exportBatchesPDF(toExportRows(batches)); }}><FileText size={14} aria-hidden="true" /> PDF</Btn>
                <Btn size="sm" data-testid="batches-excel" onClick={() => exportBatchesExcel(toExportRows(batches))}><FileSpreadsheet size={14} aria-hidden="true" /> Excel</Btn>
              </span>
            ) : undefined}
          />
          {batches.length > 0 && printing === false ? <PrintPhase1Notice /> : null}
          {batches.length === 0 ? (
            <OpsEmpty title={t("noData")} />
          ) : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow ops-rows" aria-label={t("allBatches")}>
                <thead>
                  <tr>
                    <th>{t("opsBatchCol")}</th>
                    <th>{t("opsProductOrderCol")}</th>
                    <th className="hr-hide-compact">{t("opsGreenLotCol")}</th>
                    <th className="num">{t("opsGreenInCol")}</th>
                    <th className="num">{t("opsRoastedOutCol")}</th>
                    <th className="num hr-hide-compact">{t("opsLossCol")}</th>
                    <th>{t("opsStatusCol")}</th>
                    <th>{t("opsRecordedCol")}</th>
                    <th aria-label={t("opsActions")} />
                  </tr>
                </thead>
                <tbody>
                  {batches.map((batch) => {
                    const loss = batch.greenBeanQuantity > 0 ? (1 - batch.roastedBeanQuantity / batch.greenBeanQuantity) * 100 : 0;
                    const lineage = [
                      batch.childBatches.length > 0 ? `${t("sourceBatches")}: ${batch.childBatches.map((c) => c.batchNumber).join(", ")}` : null,
                      batch.blendOutputs.length > 0 ? `${t("usedInBlend")}: ${batch.blendOutputs.map((o) => o.targetBlendBatch.batchNumber).join(", ")}` : null,
                      batch.isBlend && batch.blendInputs.length > 0 ? `${t("blendSources")}: ${batch.blendInputs.map((inp) => `${inp.sourceBatch.batchNumber} (${formatKg(inp.quantityUsed)} ${t("opsKgUnit")})`).join(" + ")}` : null,
                    ].filter(Boolean);
                    const bags = batch.status === "Packaged" ? [
                      batch.bags3kg > 0 ? `${batch.bags3kg}× 3kg` : null,
                      batch.bags1kg > 0 ? `${batch.bags1kg}× 1kg` : null,
                      batch.bags250g > 0 ? `${batch.bags250g}× 250g` : null,
                      batch.bags150g > 0 ? `${batch.bags150g}× 150g` : null,
                      batch.samplesGrams > 0 ? `${batch.samplesGrams}g ${t("samplesGramsLabel")}` : null,
                    ].filter(Boolean) : [];
                    const extras = [
                      batch.roastProfile,
                      batch.isBlend ? `${t("statusBlended")}${batch.blendTiming ? ` · ${batch.blendTiming === "Before QC" ? t("blendBeforeQc") : t("blendAfterQc")}` : ""}` : null,
                      ...bags, ...lineage,
                    ].filter(Boolean) as string[];
                    const open = openRows.has(batch.id);
                    const product = batch.greenBean?.beanType || (batch.orderItem?.beanTypeName ?? "");
                    return (
                      <Fragment key={batch.id}>
                        {/* prd-overview: one 46 px line per batch; profile, bags and lineage open below. */}
                        <tr data-testid={`batch-row-${batch.batchNumber}`}>
                          <td className="m-title">
                            <span className="ops-phone-title">{product}{!batch.orderItem ? <span className="hr-muted"> · {t("stockBatchLabel")}</span> : null}</span>
                            <span className="ops-rowhead hr-hide-mobile">
                              {extras.length > 0 ? <button type="button" className="ops-disclose hr-hide-mobile" aria-expanded={open} aria-label={t("opsDetails")} onClick={() => toggleRow(batch.id)}><ChevronDown size={14} aria-hidden="true" /></button> : null}
                              <span className="ops-serial">{batch.batchNumber}</span>
                              {canEditDate && (
                                <button type="button" className="hr-btn is-ghost is-sm" style={{ height: 24, padding: "0 4px" }} onClick={() => setEditDateBatch(batch)} title={t("editDateBtn")} aria-label={t("editDateBtn")}>
                                  <CalendarDays size={13} aria-hidden="true" />
                                </button>
                              )}
                            </span>
                            <span className="hr-msub">
                              <span className="ops-serial">{batch.batchNumber}</span>{batch.orderItem ? <> · <span className="hr-id">#{batch.orderItem.order.orderNumber}</span></> : null} · {opsDate(batch.createdAt, lang, true)} · <StatusDot map={stageMap} value={batch.status} />
                            </span>
                          </td>
                          <td className="hr-hide-mobile">
                            <span className="ops-ell">{product}{batch.orderItem ? <> <span className="hr-id">#{batch.orderItem.order.orderNumber}</span> · {batch.orderItem.order.customer.name}</> : <> · {t("stockBatchLabel")}</>}</span>
                          </td>
                          <td className="hr-hide-compact">{batch.greenBean?.serialNumber ? <span className="ops-serial">{batch.greenBean.serialNumber}</span> : <span className="hr-muted">—</span>}</td>
                          <td className="num"><span className="hr-num">{kg(batch.greenBeanQuantity, 2)}</span></td>
                          <td className="num m-end"><span className="hr-num hr-hide-mobile" style={batch.status === "Rejected" ? { textDecoration: "line-through", color: "var(--text-muted)" } : undefined}>{kg(batch.roastedBeanQuantity, 2)}</span><span className="ops-only-mobile"><Kg strong v={batch.roastedBeanQuantity} /></span></td>
                          <td className="num hr-hide-compact"><span className="hr-num" style={{ color: batch.status === "Rejected" ? "var(--status-danger)" : undefined }}>{loss.toFixed(1)}%</span></td>
                          <td><StatusDot map={stageMap} value={batch.status} /></td>
                          <td><span className="hr-num">{opsDate(batch.createdAt, lang, true)}</span></td>
                          <td className="ops-actions">
                            {canCancelBatch && (
                              <button type="button" className="hr-btn is-ghost is-sm" onClick={() => setCancelBatch(batch)} title={t("cancelBatchTitle")} aria-label={t("cancelBatchTitle")}>
                                <Trash2 size={15} aria-hidden="true" />
                              </button>
                            )}
                          </td>
                        </tr>
                        {open && extras.length > 0 ? (
                          <tr className="ops-detailrow"><td colSpan={9}><div className="ops-extras">{extras.map((x, i) => <span key={i} className="hr-caption">{x}</span>)}</div></td></tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
                {/* prd-overview totals: count · counted kg (rejected and blends excluded), in, out. */}
                <tfoot>
                  <tr>
                    <td colSpan={3}><span className="hr-num">{batches.length}</span> {t("opsBatchesWord")} · {t("opsCounted")} <Kg v={totals.countedKg} /></td>
                    <td className="num"><span className="hr-num">{kg(totals.green, 2)}</span></td>
                    <td className="num"><span className="hr-num">{kg(totals.roasted, 2)}</span></td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* prd-overview: what needs attention beside the roasting queue, then the roaster. */}
          <div className="ops-cols" style={{ marginTop: 16 }}>
            <section className="hr-stack" style={{ gap: 8 }} aria-label={t("opsAttention")}>
              <SecHead title={t("opsAttention")} />
              {rejectedBatches.length + lateQc.length + pendingPos.length === 0 ? <p className="hr-caption" style={{ margin: 0 }}>{t("opsNothingAttention")}</p> : (
                <ul className="ops-attn">
                  {rejectedBatches.slice(0, 3).map((b) => {
                    const lossPct = b.greenBeanQuantity > 0 ? (1 - b.roastedBeanQuantity / b.greenBeanQuantity) * 100 : 0;
                    return (
                      <li key={b.id}>
                        <div>
                          <Dot tone="danger">{t("opsBatchWord")} <span className="ops-serial">{b.batchNumber}</span> {t("opsRejectedLoss")} <span className="hr-num">{lossPct.toFixed(1)}%</span></Dot>
                          <span className="ops-attn-sub"><Kg v={b.roastedBeanQuantity} /> {t("opsAwaitingDecision")}</span>
                        </div>
                        <Link href="/dashboard/qc" className="hr-btn is-sm">{t("opsOpenQc")}</Link>
                      </li>
                    );
                  })}
                  {lateQc.slice(0, 3).map((b) => (
                    <li key={b.id}>
                      <div>
                        <Dot tone="warning">{t("opsBatchWord")} <span className="ops-serial">{b.batchNumber}</span> {t("opsAwaitingQcFor")} <span className="hr-num">{hoursSince(b.createdAt)}</span> {t("opsHoursShort")}</Dot>
                        {b.qcDeadline ? <span className="ops-attn-sub">{t("opsDeadlineCol")} {opsDate(b.qcDeadline, lang, true)}</span> : null}
                      </div>
                      <Link href="/dashboard/qc" className="hr-btn is-sm">{t("opsOpenQc")}</Link>
                    </li>
                  ))}
                  {pendingPos.slice(0, 3).map((p) => (
                    <li key={p.id}>
                      <div>
                        <Dot tone="warning"><span className="ops-serial">{p.productionNumber}</span> {t("opsAwaitingRelease")} <span className="hr-id">#{p.orderNumber}</span></Dot>
                        <span className="ops-attn-sub">{t("opsNoRoastBeforeRelease")}</span>
                      </div>
                      <Link href={`/dashboard/production-orders/${p.id}`} className="hr-btn is-sm">{t("opsOpenOrder")}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="hr-stack" style={{ gap: 8 }} aria-label={t("opsRoastQueue")}>
              <SecHead title={t("opsRoastQueue")} caption={t("opsRoastQueueCaption")} />
              {pendingItems.length === 0 ? <p className="hr-caption" style={{ margin: 0 }}>{t("noPendingItems")}</p> : (
                <ol className="ops-log">
                  {pendingItems.slice(0, 5).map((item: OrderItem) => {
                    const produced = item.roastingBatches.filter((b) => !b.isBlend && b.status !== "Rejected").reduce((s: number, b) => s + b.roastedBeanQuantity, 0);
                    return (
                      <li key={item.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                        <span className="ops-log-main">{item.beanTypeName} <span className="hr-id">#{item.order.orderNumber}</span> <span className="hr-muted">· {item.order.customer.name}</span></span>
                        <span className="ops-log-end"><Kg strong v={Math.max(0, item.quantityKg - produced)} /></span>
                      </li>
                    );
                  })}
                  {pendingItems.length > 5 ? <li style={{ gridTemplateColumns: "minmax(0, 1fr)" }}><button type="button" className="ops-link" style={{ background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer" }} onClick={() => setTab("pending")}>+{pendingItems.length - 5} · {t("opsTabSchedule")}</button></li> : null}
                </ol>
              )}
            </section>
          </div>
          {roasterBlock}
        </>
      )}
    </div>

    {/* prd-blend 321:2401 / 324:2581: blending is a pane beside the list at 1440, a drawer at
        1024 and a bottom sheet on the phone. Same selection rules and request as the dialog. */}
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
      const outKg = selectedBatches.reduce((s, b) => s + b.roastedBeanQuantity, 0);
      const owner = selectedBatches[0]?.orderItem ?? null;
      return (
        <OpsPane
          testId="blend-pane"
          label={t("blendBatches")}
          title={t("blendBatches")}
          sub={blendType ? (blendType === "Before QC" ? t("blendBeforeQc") : t("blendAfterQc")) : t("blendSelectHint")}
          busy={blending}
          onClose={() => setShowBlendForm(false)}
          footer={
            <>
              <Btn variant="primary" onClick={handleBlend} disabled={!canSubmit} busy={blending}>{t("blendBatches")} ({blendSelected.size})</Btn>
              <Btn onClick={() => setShowBlendForm(false)} disabled={blending}>{t("cancel")}</Btn>
            </>
          }
        >
          <div>
            <p className="ops-lbl">{t("opsSourcesCol")}</p>
            <ul className="ops-recs ops-blend-src">
              {blendableBatches.map((batch) => {
                const selected = blendSelected.has(batch.id);
                return (
                  <li key={batch.id}>
                    <label style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, cursor: "pointer" }}>
                      <input type="checkbox" checked={selected} onChange={() => toggleBlendBatch(batch.id)} aria-label={batch.batchNumber} />
                      <span style={{ minWidth: 0 }}>
                        <span className="ops-serial">{batch.batchNumber}</span> · {t("opsWholeBatch")}
                        <span className="ops-line">{batch.greenBean?.beanType || (batch.orderItem?.beanTypeName ?? "")} · {batch.orderItem ? <span className="hr-id">#{batch.orderItem.order.orderNumber}</span> : t("stockBatchLabel")}</span>
                      </span>
                    </label>
                    <StatusDot map={stageMap} value={batch.status} />
                    <Kg strong v={batch.roastedBeanQuantity} />
                  </li>
                );
              })}
            </ul>
          </div>

          {isMixed ? <Notice tone="danger">{t("cannotMixStatuses")}</Notice> : null}
          {mixesOwnership || mixesOrders ? <Notice tone="danger">{mixesOwnership ? t("cannotMixStockAndOrder") : t("cannotMixOrders")}</Notice> : null}

          <dl className="ops-props" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
            <dt>{t("opsBlendOutput")}</dt><dd style={{ textAlign: "end", fontWeight: 600 }}><Kg v={outKg} /></dd>
            <dt>{t("opsStatusCol")}</dt><dd style={{ textAlign: "end" }}>{blendType === "Before QC" ? t("statusPendingQc") : blendType === "After QC" ? t("statusPassed") : "—"}</dd>
            <dt>{t("opsBlendOwner")}</dt><dd style={{ textAlign: "end" }}>{selectedBatches.length === 0 ? "—" : owner ? <><span className="hr-id">#{owner.order.orderNumber}</span> · {owner.order.customer.name}</> : t("stockBatchLabel")}</dd>
            <dt>{t("opsBlendResultNo")}</dt><dd style={{ textAlign: "end" }} className="hr-muted">{t("opsAssignedOnSave")}</dd>
          </dl>
          <p className="ops-note">{blendType === "Before QC" ? t("blendNeedQc") : blendType === "After QC" ? t("blendToPackaging") : t("opsBlendNote")}</p>
        </OpsPane>
      );
    })()}
    </div>

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
                  <span className="font-bold text-amber-700">+<Kg v={formatKg(overproductionExcess)} /></span>
                  {". "}
                  {t("overprodWarnConfirm")}
                </p>
                <p className="text-xs text-brown/60 mt-2">
                  {t("requiredQtyLabel")}: <Kg v={selectedItem.quantityKg} /> — {t("totalProducedLabel")}: <Kg v={(+(
                    selectedItem.roastingBatches.filter((b) => !b.isBlend && b.status !== "Rejected").reduce((s, b) => s + b.roastedBeanQuantity, 0) +
                    roastForm.roastedBeanQuantity
                  )).toFixed(2)} />
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
      {/* Desktop: the approved centred dialog (305:1457). Phone: the 344:3458 bottom sheet
          (ops.css .ops-roast) — same form, same controls. */}
      {showRoastForm && (selectedItem || stockMode) && (
        <div className="ops-roast fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) closeRoastForm(); }}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg" role="dialog" aria-modal="true" aria-label={stockMode ? t("roastToStockTitle") : t("recordRoastTitle")}>
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
                  <Select value={roastForm.productId} onChange={(e) => setRoastForm({ ...roastForm, productId: e.target.value })}
                    className="w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required>
                    <option value="">{t("selectProduct")}</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{lang === "ar" ? (p.productNameAr ?? p.productNameEn) : p.productNameEn}</option>
                    ))}
                  </Select>
                  <p className="mt-1 text-xs text-brown/60">{t("roastToStockProductHint")}</p>
                </div>
              )}
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1">{t("greenBeanSource")}</label>
                <Select value={roastForm.greenBeanId} onChange={(e) => setRoastForm({ ...roastForm, greenBeanId: e.target.value })}
                  className="w-full px-3 py-2.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required>
                  <option value="">{t("selectBeanStock")}</option>
                  {beans.map((b) => (
                    <option key={b.id} value={b.id}>{b.beanType} ({b.serialNumber}) — {formatKg(b.quantityKg)} {t("opsKgUnit")}</option>
                  ))}
                </Select>
              </div>
              {!stockMode && livePosFor(selectedItem).length > 1 && (
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1">
                    Production order
                  </label>
                  <Select
                    value={poChoice}
                    onChange={(e) => setPoChoice(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
                  >
                    <option value="">Select which production order this roast is for…</option>
                    {livePosFor(selectedItem).map((p) => (
                      <option key={p.id} value={p.id}>{p.productionNumber} — {p.status}</option>
                    ))}
                  </Select>
                </div>
              )}
              {!stockMode && remainingFinishedKg > 0 && (
                <p className="text-sm text-brown/70">
                  {/* FINISHED kilograms still owed. Shown as context beside the green field,
                      never written into it: converting this to a green weight needs the
                      coffee's roast loss, which this screen does not hold. */}
                  {t("opsStillToProduce").replace("{kg}", formatKg(remainingFinishedKg))}
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1">{t("greenBeanQty")}</label>
                  <input type="number" step="0.01" value={roastForm.greenBeanQuantity}
                    onChange={(e) => setRoastForm({ ...roastForm, greenBeanQuantity: parseFloat(e.target.value) || 0 })} onBlur={() => setRoastTouched(true)}
                    className="w-full px-3 py-2.5 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required />
                </div>
                <div>
                  <label className="block text-sm font-bold text-charcoal mb-1">{t("roastedQty")}</label>
                  <input type="number" step="0.01" value={roastForm.roastedBeanQuantity}
                    onChange={(e) => setRoastForm({ ...roastForm, roastedBeanQuantity: parseFloat(e.target.value) || 0 })} onBlur={() => setRoastTouched(true)}
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
                    {roastTouched && greenQtyInvalid && (
                      <div className="text-sm font-bold px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700">
                        {t("opsGreenQtyRequired")}
                      </div>
                    )}
                    {roastTouched && roastedIsZero && (
                      <div className="text-sm font-bold px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700">
                        {t("opsRoastedQtyRequired")}
                      </div>
                    )}
                    {roastTouched && roastedExceeds && (
                      <div className="text-sm font-bold px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700">
                        {t("roastedExceedsGreen")}
                      </div>
                    )}
                    {roastTouched && insufficientStock && selectedBean && (
                      <div className="text-sm font-bold px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700">
                        {t("opsInsufficientAvail").replace("{kg}", formatKg(selectedBean.quantityKg))}
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
                  <RestockReason value={restockReason} onChange={setRestockReason} label={t("restockReasonLabel")} hint={t("restockReasonHint")} disabled={cancelling} />
                  <div className="flex gap-3">
                    <button onClick={() => handleCancelBatch(true)} disabled={cancelling || !restockReasonOk(restockReason)}
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
                    {hasBean && canOverrideInventory && <RestockReason value={restockReason} onChange={setRestockReason} label={t("restockReasonLabel")} hint={t("restockReasonHint")} disabled={cancelling} />}
                    {hasBean && (
                      <button onClick={() => handleCancelBatch(true)} disabled={cancelling || !canOverrideInventory || !restockReasonOk(restockReason)}
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
    </OpsRoot>
  );
}
