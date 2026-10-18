"use client";
import { useCreateRequest } from "@/components/shell/page-context";

import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, UserPlus, X, Pencil, Save } from "lucide-react";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/translations";
import { orderNeedsAttention } from "@/lib/order-operations-client";
import { LocalizedName } from "@/components/LocalizedName";
import {
  OrderStatusBadge, NeedsAttentionBadge, OwnerDisplay, ActivityTimeline, AddNoteForm,
  StatusActionsBar, PreparationReviewTable, OrderProgressStepper, type LifecycleActivity,
} from "@/components/OrderLifecyclePanel";
import { Btn, FilterChip, KV, OpsEmpty, OpsError, OpsLoading, OpsRoot, PageHeader, Tabs, kg, rowOpen, Kg, opsDate } from "@/components/ops/ui";

type OrdersTab = "all" | "review" | "preparing" | "ready" | "hold" | "done";

const COMPLETION_STATUSES = new Set(["Passed", "Partially Packaged", "Packaged", "Blended"]);

function itemCompletionTotal(item: OrderItem): number {
  return item.roastingBatches
    .filter((b) => COMPLETION_STATUSES.has(b.status) && !b.isBlend)
    .reduce((s, b) => s + (b.roastedBeanQuantity > 0 ? b.roastedBeanQuantity : b.greenBeanQuantity), 0);
}

type CatalogProduct = {
  id: string;
  skuCode: string;
  name: string;
  packSize: string;
  price: number;
  isActive: boolean;
  availableUnits: number;
  hasBom: boolean;
};

type FulfilmentPreview = {
  lines: {
    productSkuId: string;
    skuCode: string;
    name: string;
    orderedUnits: number;
    availableUnits: number;
    allocatedUnits: number;
    productionRequiredUnits: number;
    productionRequirement: { units: number; hasBom: boolean; blockedBy: string[] } | null;
  }[];
  totals: { orderedUnits: number; allocatedUnits: number; productionRequiredUnits: number };
};

type OrderItem = {
  id: string; beanTypeName: string; quantityKg: number; productionStatus: string;
  quantityUnits: number | null;
  productId: string | null; productSkuId: string | null;
  // E7: master-data names (GET /api/orders, additive); null on a line without a product.
  product?: { productNameEn: string; productNameAr: string | null } | null;
  deliveryStatus: string; deliveredQty: number; remainingQty: number;
  roastingBatches: { batchNumber: string; greenBeanQuantity: number; roastedBeanQuantity: number; status: string; isBlend: boolean }[];
  deliveries: { date: string; quantityKg: number; deliveryType: string }[];
  preparationDecision: string | null;
  availableQuantity: number | null;
  productionRequiredQuantity: number | null;
};

type Order = {
  id: string; orderNumber: number; customer: { id: string; name: string };
  quotationNumber: string | null; quotationSentDate: string | null;
  approvalStatus: string; paymentStatus: string; vatInvoiceStatus: string;
  notes: string | null; createdAt: string; items: OrderItem[];
  status: string;
  ownerId: string | null;
  owner: { id: string; name: string; role: string } | null;
  activities: LifecycleActivity[];
};

function lastActivityOf(order: Order): LifecycleActivity | null {
  return order.activities.length > 0 ? order.activities[order.activities.length - 1] : null;
}

type Customer = { id: string; name: string };
type GreenBean = { id: string; serialNumber: string; beanType: string; quantityKg: number };
type ProductSku = { id: string; skuCode: string; weightGrams: number; isBulk: boolean; price: number };
type ProductSummary = { id: string; productNameEn: string; productNameAr: string | null; productSkus: ProductSku[] };

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const cls =
    status === "Completed" || status === "Delivered" || status === "Paid" ? "status-completed" :
    status === "Pending" || status === "Partial Paid" ? "status-pending" :
    status === "In Production" ? "status-in-production" :
    status === "Partial Delivered" ? "status-partial" :
    status === "Not Paid" ? "status-not-paid" : "status-not-yet";
  const labelMap: Record<string, TranslationKey> = {
    "Completed":        "statusCompleted",
    "Delivered":        "statusDelivered",
    "Paid":             "statusPaid",
    "Pending":          "pending",
    "Partial Paid":     "statusPartialPaid",
    "In Production":    "statusInProd",
    "Partial Delivered":"statusPartDeliv",
    "Not Paid":         "statusNotPaid",
    "Not Yet":          "statusNotYet",
  };
  const label = labelMap[status] ? t(labelMap[status]) : status;
  return <span className={`status-badge ${cls}`}>{label}</span>;
}

// ApprovalBadge removed with the routine approval UI: approval is no longer part of the
// normal order path, so the row shows the lifecycle status instead. The approval API and
// its historical data are untouched.

export default function OrdersPage() {
  const user = useUser();
  const { t, lang } = useI18n();
  const canCreate = hasSubPrivilege(user?.permissions ?? {}, "orders", "create");
  const canEditOrder = hasSubPrivilege(user?.permissions ?? {}, "orders", "edit");
  const canDelete = hasSubPrivilege(user?.permissions ?? {}, "orders", "delete");
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [beans, setBeans] = useState<GreenBean[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  // «جديد» from the shell (A-3): `?new=1` opens the same form as «طلب جديد».
  useCreateRequest("order", () => setShowForm(true), canCreate);
  // In-flight guard for the create-order write, so the button cannot be pressed twice.
  //
  // Two flags on purpose. The state drives the disabled attribute; the ref is what
  // actually stops a second submit, because setState does not apply within the same tick —
  // two clicks dispatched before React re-renders both saw creating === false and both
  // sent the order. A ref changes immediately, so the second call returns at the door.
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab] = useState<OrdersTab>("all");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // ── SKU-based order entry ────────────────────────────────────────────────
  // A new order line is a finished product and a quantity of whole units. The coffee,
  // origin, pack size, price and BOM all follow from the SKU, so none of them is asked
  // for — that is the point of the redesign. Legacy bean-based lines on existing orders
  // stay readable further down this page; they simply cannot be created any more.
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [preview, setPreview] = useState<FulfilmentPreview | null>(null);
  const [form, setForm] = useState<{
    customerId: string;
    quotationNumber: string;
    approvalStatus: string;
    items: { productSkuId: string; quantityUnits: number }[];
  }>({ customerId: "", quotationNumber: "", approvalStatus: "Pending", items: [{ productSkuId: "", quantityUnits: 0 }] });
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: "", nameAr: "", phone: "", email: "", address: "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    quotationNumber: string; approvalStatus: string; paymentStatus: string; vatInvoiceStatus: string; notes: string;
    items: { id?: string; beanTypeName: string; quantityKg: number; greenBeanId: string; productId: string; productSkuId: string }[];
  }>({ quotationNumber: "", approvalStatus: "", paymentStatus: "", vatInvoiceStatus: "", notes: "", items: [] });

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const [ordersRes, custRes, beansRes, productsRes, catalogRes] = await Promise.all([
      fetch("/api/orders"), fetch("/api/customers"), fetch("/api/green-beans"),
      fetch("/api/coffee-products/summary"),
      // The sellable catalog: one entry per finished SKU, with its free unit count.
      // The raw finished-goods-lots fetch is gone — free stock is per SKU and in units
      // now, and /api/products already reports it; summing lot kilograms here would have
      // been a second, disagreeing implementation of availability.
      fetch("/api/products"),
    ]);
    // A refused or failed list must not replace the data with an error object (the edit
    // form calls beans.find on it); each list is only taken from a successful response. A
    // refused response is still read to the end: an unread body keeps the connection open,
    // and the page never reaches "network idle" (green beans are refused to a dispatch-only
    // login, which is a normal state of this screen).
    const take = async (r: Response) => (r.ok ? r.json() : (await r.text(), null));
    const [ordersJ, custJ, beansJ, productsJ, catalogJ] = await Promise.all([ordersRes, custRes, beansRes, productsRes, catalogRes].map(take));
    if (ordersJ === null) { setLoadError(true); setLoaded(true); return; }
    setLoadError(false);
    setOrders(ordersJ);
    if (custJ) setCustomers(custJ);
    if (beansJ) setBeans(beansJ);
    if (productsJ) setProducts(productsJ);
    if (catalogJ) setCatalog(catalogJ);
    setLoaded(true);
  }

  // Live fulfilment check for the lines currently typed into the create form.
  //
  // Asks the server rather than recomputing here: it draws the free pool down across
  // lines and explodes the shortfall through each SKU's BOM, and duplicating that in the
  // browser would be a second implementation to keep in step. Nothing is reserved — the
  // binding reservation happens at preparation review and can come out lower if someone
  // else buys the same stock in between.
  useEffect(() => {
    const lines = form.items
      .filter((i) => i.productSkuId && i.quantityUnits > 0)
      .map((i) => ({ productSkuId: i.productSkuId, quantityUnits: i.quantityUnits }));

    // Ignore a response that arrives after the inputs have moved on. Every setPreview
    // below runs inside the timer callback rather than in the effect body, so this never
    // sets state synchronously during render.
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (lines.length === 0) {
        setPreview(null);
        return;
      }
      const res = await fetch("/api/orders/fulfillment-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      });
      if (cancelled) return;
      setPreview(res.ok ? await res.json() : null);
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form.items]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Without this guard a double click sent the order twice and the customer got two of
    // them. The button is disabled below for the same reason; this is the guard that holds
    // when the click arrives before React has re-rendered.
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const body = await res.json();
        alert(body.error + (body.details ? "\n" + body.details.join("\n") : ""));
        return;
      }
      setShowForm(false);
      setForm({ customerId: "", quotationNumber: "", approvalStatus: "Pending", items: [{ productSkuId: "", quantityUnits: 0 }] });
      setPreview(null);
      loadData();
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  async function updateOrder(id: string, data: Record<string, string>) {
    await fetch(`/api/orders/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    loadData();
  }

  async function deleteOrder(id: string) {
    if (!confirm(t("confirmDeleteOrder"))) return;
    await fetch(`/api/orders/${id}`, { method: "DELETE" });
    setExpanded(null);
    loadData();
  }

  function startEdit(order: Order) {
    setEditingId(order.id);
    setEditForm({
      quotationNumber: order.quotationNumber || "",
      approvalStatus: order.approvalStatus,
      paymentStatus: order.paymentStatus,
      vatInvoiceStatus: order.vatInvoiceStatus,
      notes: order.notes || "",
      items: order.items.map((i) => ({
        id:          i.id,
        beanTypeName: i.beanTypeName,
        quantityKg:  i.quantityKg,
        greenBeanId: beans.find((b) => b.beanType === i.beanTypeName)?.id || "",
        productId:   i.productId   || "",
        productSkuId: i.productSkuId || "",
      })),
    });
  }

  function updateEditItem(idx: number, field: string, value: string | number) {
    const newItems = [...editForm.items];
    (newItems[idx] as Record<string, string | number | undefined>)[field] = value;
    setEditForm({ ...editForm, items: newItems });
  }

  function getEditStockWarnings() {
    const demandMap = new Map<string, number>();
    for (const item of editForm.items) {
      if (!item.greenBeanId || !item.quantityKg) continue;
      demandMap.set(item.greenBeanId, (demandMap.get(item.greenBeanId) || 0) + item.quantityKg);
    }
    return editForm.items.map((item) => {
      if (!item.greenBeanId || !item.quantityKg) return null;
      const bean = beans.find((b) => b.id === item.greenBeanId);
      if (!bean) return null;
      const totalDemand = demandMap.get(item.greenBeanId) || 0;
      if (totalDemand > bean.quantityKg) {
        return `${t("insufficientStock")} ${bean.quantityKg} ${t("opsKgUnit")} · ${t("opsTotalOrdered")}: ${totalDemand} ${t("opsKgUnit")}`;
      }
      return null;
    });
  }

  async function handleEditSave() {
    if (!editingId) return;
    // approvalStatus/paymentStatus/vatInvoiceStatus are not editable through this
    // generic route — they are owned by POST /api/orders/[id]/approve.
    const { items, quotationNumber, notes } = editForm;
    const res = await fetch(`/api/orders/${editingId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quotationNumber, notes, items }),
    });
    if (!res.ok) {
      const body = await res.json();
      alert(body.error + (body.details ? "\n" + body.details.join("\n") : ""));
      return;
    }
    setEditingId(null);
    loadData();
  }

  // submitApprovalDecision removed with the routine approval UI. POST
  // /api/orders/[id]/approve still exists for exceptional policy work; it simply has no
  // entry point on the normal operator path any more.

  async function createCustomer() {
    if (!newCustomer.name.trim()) return;
    const res = await fetch("/api/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newCustomer),
    });
    const created = await res.json();
    setCustomers((prev) => [created, ...prev]);
    setForm({ ...form, customerId: created.id });
    setNewCustomer({ name: "", nameAr: "", phone: "", email: "", address: "" });
    setShowNewCustomer(false);
  }

  function addItem() {
    setForm({ ...form, items: [...form.items, { productSkuId: "", quantityUnits: 0 }] });
  }

  function updateItem(idx: number, field: "productSkuId" | "quantityUnits", value: string | number) {
    setForm({
      ...form,
      items: form.items.map((it, i) =>
        i === idx
          ? field === "quantityUnits"
            ? { ...it, quantityUnits: Number(value) || 0 }
            : { ...it, productSkuId: String(value) }
          : it
      ),
    });
  }

  const TAB_STATUSES: Record<OrdersTab, string[] | null> = {
    all: null,
    review: ["Waiting Approval", "Waiting Preparation Review"],
    preparing: ["Preparing"],
    ready: ["Ready for Shipping"],
    hold: ["On Hold"],
    done: ["Completed"],
  };
  const inTab = (o: Order, k: OrdersTab) => !TAB_STATUSES[k] || TAB_STATUSES[k]!.includes(o.status);
  const filtered = orders.filter((o) => {
    if (!inTab(o, tab)) return false;
    const matchSearch = `${o.orderNumber} ${o.customer.name} ${o.quotationNumber || ""}`.toLowerCase().includes(search.toLowerCase());
    if (statusFilter === "all") return matchSearch;
    return matchSearch && o.items.some((i) => i.productionStatus === statusFilter);
  });
  const open = orders.find((o) => o.id === expanded) ?? null;
  const productionStatusOf = (order: Order) =>
    order.items.every((i) => i.productionStatus === "Completed") ? "Completed" : order.items.some((i) => i.productionStatus === "In Production") ? "In Production" : "Pending";
  const totalKg = (order: Order) => order.items.reduce((s, i) => s + i.quantityKg, 0);

  return (
    <OpsRoot>
      <div className={`hr-split${open ? " has-preview" : ""}`}>
        <div className="hr-page">
          <PageHeader
            title={t("orders")}
            actions={canCreate ? (
              <Btn variant="primary" onClick={() => setShowForm(true)}>
                <Plus size={16} aria-hidden="true" /> {t("newOrder")}
              </Btn>
            ) : null}
          >
            <span><span className="hr-num">{orders.length}</span> {t("totalOrdersCount")}</span>
          </PageHeader>

          <Tabs
            label={t("orders")}
            value={tab}
            onChange={(k) => setTab(k)}
            items={([
              ["all", t("opsAll")],
              ["review", t("opsWaitingReview")],
              ["preparing", t("orderStatusPreparing")],
              ["ready", t("orderStatusReadyForShipping")],
              ["hold", t("orderStatusOnHold")],
              ["done", t("completed")],
            ] as [OrdersTab, string][]).map(([key, label]) => ({ key, label, count: orders.filter((o) => inTab(o, key)).length, danger: key === "hold" && orders.some((o) => o.status === "On Hold") }))}
          />

          <div className="hr-filterbar">
            <input className="hr-input hr-search" type="search" placeholder={t("searchOrders")} aria-label={t("searchOrders")} value={search} onChange={(e) => setSearch(e.target.value)} />
            <FilterChip
              label={t("opsProductionFilter")}
              value={statusFilter === "all" ? "" : statusFilter}
              onChange={(v) => setStatusFilter(v || "all")}
              allLabel={t("allStatuses")}
              clearLabel={`${t("clearFilters")}: ${t("opsProductionFilter")}`}
              options={[
                { value: "Pending", label: t("pending") },
                { value: "In Production", label: t("statusInProd") },
                { value: "Completed", label: t("statusCompleted") },
              ]}
            />
          </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-charcoal mb-4">{t("newOrder")}</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("customer")}</label>
                <div className="flex gap-2">
                  <select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}
                    className="flex-1 px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required>
                    <option value="">{t("selectCustomer")}</option>
                    {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button type="button" onClick={() => setShowNewCustomer(!showNewCustomer)}
                    className={`p-2 rounded-lg border ${showNewCustomer ? "bg-red-50 border-red-200 text-red-600" : "bg-cream border-border text-brown"} hover:opacity-80`}
                    title={showNewCustomer ? t("cancel") : t("addNewCustomer")}>
                    {showNewCustomer ? <X size={18} /> : <UserPlus size={18} />}
                  </button>
                </div>
                {showNewCustomer && (
                  <div className="mt-2 p-3 bg-cream border border-border rounded-lg space-y-2">
                    <p className="text-xs font-semibold text-brown">{t("newCustomerLabel")}</p>
                    <input type="text" placeholder={t("nameEnglish") + " *"} value={newCustomer.name}
                      onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })}
                      className="w-full px-3 py-1.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
                    <input type="text" placeholder={t("nameArabic")} dir="rtl" value={newCustomer.nameAr}
                      onChange={(e) => setNewCustomer({ ...newCustomer, nameAr: e.target.value })}
                      className="w-full px-3 py-1.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
                    <input type="tel" placeholder={t("phone")} value={newCustomer.phone}
                      onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                      className="w-full px-3 py-1.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
                    <input type="email" placeholder={t("emailLabel")} value={newCustomer.email}
                      onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })}
                      className="w-full px-3 py-1.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
                    <input type="text" placeholder={t("address")} value={newCustomer.address}
                      onChange={(e) => setNewCustomer({ ...newCustomer, address: e.target.value })}
                      className="w-full px-3 py-1.5 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
                    <button type="button" onClick={createCustomer} disabled={!newCustomer.name.trim()}
                      className="w-full py-1.5 bg-orange text-white rounded-lg text-sm hover:bg-orange-dark disabled:opacity-50 shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200 font-bold">
                      {t("addCustomer")}
                    </button>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("quotationNumber")}</label>
                <input type="text" value={form.quotationNumber} onChange={(e) => setForm({ ...form, quotationNumber: e.target.value })}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
              </div>
              {(() => {
                // Section 8: one search box, then a quantity. No bean picker, no product
                // picker, no SKU field — the SKU is the line.
                const previewBySku = new Map((preview?.lines ?? []).map((l) => [l.productSkuId, l]));
                const blocked = creating || form.items.some((i) => !i.productSkuId || i.quantityUnits <= 0);
                return (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">{t("orderItemsLabel")}</label>
                      {form.items.map((item, idx) => {
                        const sku = catalog.find((c) => c.id === item.productSkuId);
                        const row = item.productSkuId ? previewBySku.get(item.productSkuId) : undefined;
                        return (
                          <div key={idx} className="mb-2 border-2 border-border rounded-xl p-2.5">
                            <div className="flex gap-2 items-start">
                              <div className="flex-1">
                                <input
                                  list={`sku-list-${idx}`}
                                  defaultValue=""
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    const chosen = catalog.find(
                                      (c) => `${c.name} — ${c.skuCode}` === v || c.skuCode === v
                                    );
                                    updateItem(idx, "productSkuId", chosen ? chosen.id : "");
                                  }}
                                  placeholder={t("searchProductLabel")}
                                  className="w-full px-3 py-2 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
                                />
                                <datalist id={`sku-list-${idx}`}>
                                  {catalog
                                    .filter((c) => c.isActive)
                                    .map((c) => (
                                      <option key={c.id} value={`${c.name} — ${c.skuCode}`}>
                                        {`${t("availableLabel")}: ${c.availableUnits}`}
                                      </option>
                                    ))}
                                </datalist>
                              </div>
                              <input
                                type="number"
                                min={1}
                                step={1}
                                placeholder={t("quantityUnitsLabel")}
                                value={item.quantityUnits || ""}
                                onChange={(e) => updateItem(idx, "quantityUnits", parseInt(e.target.value, 10) || 0)}
                                className="w-24 px-3 py-2 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
                                required
                              />
                              {form.items.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => setForm({ ...form, items: form.items.filter((_, i) => i !== idx) })}
                                  className="px-2 py-2 text-brown/60 hover:text-red-600"
                                  aria-label="Remove line"
                                >
                                  <X size={16} />
                                </button>
                              )}
                            </div>

                            {sku ? (
                              <p className="mt-1.5 text-xs text-brown/70 font-medium">
                                {sku.skuCode} · {sku.packSize} · {sku.price.toFixed(2)} · {t("availableLabel")}:{" "}
                                <span className="font-bold text-charcoal">{sku.availableUnits}</span>
                                {!sku.hasBom && <span className="text-red-600 font-bold"> · {t("noBomWarning")}</span>}
                              </p>
                            ) : (
                              <p className="mt-1.5 text-xs text-brown/50 font-medium">{t("noProductSelected")}</p>
                            )}

                            {/* Section 5: what the shelf covers, and what has to be produced. */}
                            {row && row.orderedUnits > 0 && (
                              <div className="mt-1.5 flex items-center gap-3 text-xs font-semibold flex-wrap">
                                <span className="text-green-700">
                                  {t("fromShelfLabel")}: {row.allocatedUnits}
                                </span>
                                {row.productionRequiredUnits > 0 && (
                                  <span className="text-amber-700">
                                    {t("toProduceUnitsLabel")}: {row.productionRequiredUnits}
                                  </span>
                                )}
                                {row.productionRequirement && !row.productionRequirement.hasBom && (
                                  <span className="text-red-600">{t("noBomWarning")}</span>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <button type="button" onClick={addItem} className="text-sm text-brown hover:underline">
                        {t("addItem")}
                      </button>
                    </div>

                    {preview && preview.totals.orderedUnits > 0 && (
                      <div className="rounded-xl bg-cream border border-border px-3 py-2 text-xs font-semibold text-brown flex gap-4 flex-wrap">
                        <span>{t("fulfilmentCheckTitle")}</span>
                        <span className="text-green-700">
                          {t("fromShelfLabel")}: {preview.totals.allocatedUnits}
                        </span>
                        <span className="text-amber-700">
                          {t("toProduceUnitsLabel")}: {preview.totals.productionRequiredUnits}
                        </span>
                      </div>
                    )}

                    <div className="flex gap-3 pt-2">
                      <button
                        type="submit"
                        disabled={blocked}
                        className={`flex-1 py-2 rounded-lg font-bold shadow-md active:scale-[0.98] transition-all duration-200 ${blocked ? "bg-gray-300 text-gray-500 cursor-not-allowed shadow-none" : "bg-orange text-white hover:bg-orange-dark shadow-orange/20 hover:shadow-orange/35"}`}
                      >
                        {t("createOrder")}
                      </button>
                      <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-2 border border-gray-300 rounded-lg hover:bg-gray-50">
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

          {loadError ? (
            <OpsError message={t("opsLoadFailed")} onRetry={loadData} />
          ) : !loaded ? (
            <OpsLoading />
          ) : filtered.length === 0 ? (
            <OpsEmpty title={t("noOrdersFound")} />
          ) : (
            <>
              <div className="hr-tablewrap">
                <table className="hr-table is-mrow" aria-label={t("orders")}>
                  <thead>
                    <tr>
                      <th>{t("opsOrderCol")}</th>
                      <th>{t("customer")}</th>
                      <th className="num hr-hide-preview">{t("opsItemsCol")}</th>
                      <th className="num">{t("qtyKg")}</th>
                      <th className="hr-hide-preview">{t("opsCreatedCol")}</th>
                      <th>{t("opsPrepCol")}</th>
                      <th className="hr-hide-preview">{t("production")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((order) => (
                      <tr
                        key={order.id}
                        data-testid={`order-row-${order.orderNumber}`}
                        aria-selected={expanded === order.id}
                        {...rowOpen(() => setExpanded(expanded === order.id ? null : order.id))}
                      >
                        <td className="hr-id">#{order.orderNumber}</td>
                        <td className="m-title strong">
                          {order.customer.name}
                          {orderNeedsAttention(order) ? <> <NeedsAttentionBadge /></> : null}
                          <span className="hr-msub">
                            <span className="hr-id">#{order.orderNumber}</span> · <span className="hr-num">{order.items.length}</span> {t("itemsTotal")} · <Kg v={totalKg(order)} />
                          </span>
                        </td>
                        <td className="num hr-hide-preview">{order.items.length}</td>
                        <td className="num">{kg(totalKg(order))}</td>
                        <td className="hr-hide-preview">{opsDate(order.createdAt, lang)}</td>
                        <td className="m-end"><OrderStatusBadge status={order.status} /></td>
                        <td className="hr-hide-preview"><StatusBadge status={productionStatusOf(order)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="hr-tablefoot">
                <span><span className="hr-num">{filtered.length}</span> {t("opsOrdersShown")} · <Kg v={filtered.reduce((s, o) => s + totalKg(o), 0)} /></span>
              </div>
            </>
          )}
        </div>

        {open ? (
          <aside className="hr-preview" aria-label={t("opsOrderDetail")} data-testid={`order-card-${open.orderNumber}`}>
            <div className="hr-preview-head">
              <span className="hr-id">#{open.orderNumber}</span>
              <Btn variant="ghost" size="sm" aria-label={t("opsCloseDetail")} onClick={() => setExpanded(null)}>✕</Btn>
            </div>
            <div className="hr-preview-body">
              {(() => { const order = open; return (
              <>
                <div>
                  <h2 className="hr-section" style={{ fontSize: 22, lineHeight: "28.6px", margin: 0 }}>{order.customer.name}</h2>
                  <div className="hr-meta" style={{ marginTop: 6 }}>
                    <OrderStatusBadge status={order.status} />
                    {orderNeedsAttention(order) ? <NeedsAttentionBadge /> : null}
                    <StatusBadge status={productionStatusOf(order)} />
                  </div>
                </div>

                <OrderProgressStepper status={order.status} approvalStatus={order.approvalStatus} items={order.items} />

                <KV rows={[
                  [t("quotationNumber"), order.quotationNumber || <span className="hr-muted">{t("noQuotation")}</span>],
                  [t("opsCreatedAt"), opsDate(order.createdAt, lang)],
                  [t("orderOwnerLabel"), <OwnerDisplay key="o" owner={order.owner} />],
                  [t("lastActivityLabel"), lastActivityOf(order) ? opsDate(lastActivityOf(order)!.createdAt, lang) : "—"],
                  [t("opsPaymentCol"), <StatusBadge key="p" status={order.paymentStatus} />],
                ]} />

                <section>
                  <h3 className="hr-label" style={{ margin: "0 0 4px" }}>{t("orderItemsLabel")}</h3>
                  <ul className="ops-list">
                    {order.items.map((item) => {
                      const completionTotal = itemCompletionTotal(item);
                      const surplus = +(completionTotal - item.quantityKg).toFixed(2);
                      const isOverproduced = surplus > 1;
                      return (
                        <li key={item.id} data-testid={`order-item-${item.id}`}>
                          <span style={{ minWidth: 0 }}>
                            {/* E7: the same rule as the preparation review below it. */}
                            {item.product ? (
                              <LocalizedName lang={lang} en={item.product.productNameEn} ar={item.product.productNameAr} lastResort={item.beanTypeName} />
                            ) : (
                              <bdi>{item.beanTypeName}</bdi>
                            )}
                            <span className="ops-sub">
                              {t("deliveredCol")} <span className="hr-num">{item.deliveredQty}</span> · {t("remainingCol")}{" "}
                              {isOverproduced ? (
                                <span style={{ color: "var(--status-warning)" }}>+<Kg v={surplus} /> · {t("surplusToInventory")} ({t("totalProducedLabel")} <Kg v={completionTotal} /> — {t("requiredQtyLabel")} <Kg v={item.quantityKg} />)</span>
                              ) : <span className="hr-num">{item.remainingQty}</span>}
                            </span>
                            <span className="ops-sub" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                              <StatusBadge status={item.productionStatus} />
                              <StatusBadge status={item.deliveryStatus} />
                              {isOverproduced ? <span className="hr-flag tone-warning"><span>{t("overproduced")}</span></span> : null}
                            </span>
                          </span>
                          <span style={{ whiteSpace: "nowrap" }}><Kg v={item.quantityKg} /></span>
                        </li>
                      );
                    })}
                  </ul>
                  {order.items.some((i) => i.roastingBatches.length > 0) && (
                    <p className="hr-caption" style={{ margin: "8px 0 0" }}>
                      {t("linkedBatches")}{" "}
                      {order.items.flatMap((i) => i.roastingBatches).map((b, i) => (
                        <span key={b.batchNumber}>{i ? " · " : ""}<span className="ops-serial">{b.batchNumber}</span> (<bdi dir="ltr"><span className="hr-num">{kg(b.greenBeanQuantity, 2)}</span> → <span className="hr-num">{kg(b.roastedBeanQuantity, 2)}</span></bdi> {t("opsKgUnit")})</span>
                      ))}
                    </p>
                  )}
                </section>

                {editingId === order.id && (() => {
                  const editWarnings = getEditStockWarnings();
                  const hasEditStockError = editWarnings.some((w) => w !== null);
                  return (
                    <div className="ops-panel" style={{ marginTop: 0 }}>
                      <div>
                        <label className="block text-xs font-semibold text-brown mb-2">{t("orderItemsLabel")}</label>
                        {editForm.items.map((item, idx) => (
                          <div key={idx} className="mb-2">
                            <div className="flex gap-2 items-center">
                              <select value={item.greenBeanId} onChange={(e) => {
                                const bean = beans.find((b) => b.id === e.target.value);
                                updateEditItem(idx, "greenBeanId", e.target.value);
                                if (bean) updateEditItem(idx, "beanTypeName", bean.beanType);
                              }} className="flex-1 px-3 py-1.5 border-2 border-border rounded-lg text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors">
                                <option value="">{t("selectBean")}</option>
                                {beans.map((b) => <option key={b.id} value={b.id}>{b.beanType} ({b.quantityKg} {t("opsKgUnit")})</option>)}
                              </select>
                              <input type="number" placeholder="kg" value={item.quantityKg || ""} onChange={(e) => updateEditItem(idx, "quantityKg", parseFloat(e.target.value) || 0)}
                                className="w-24 px-3 py-1.5 border-2 border-border rounded-lg text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
                              {editForm.items.length > 1 && (
                                <button type="button" onClick={() => setEditForm({ ...editForm, items: editForm.items.filter((_, i) => i !== idx) })}
                                  className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={14} /></button>
                              )}
                            </div>
                            <div className="flex gap-2 mt-1">
                              <select value={item.productId} onChange={(e) => {
                                updateEditItem(idx, "productId", e.target.value);
                                updateEditItem(idx, "productSkuId", "");
                              }} className="flex-1 px-3 py-1.5 border-2 border-border rounded-lg text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors">
                                <option value="">No product</option>
                                {products.map((p) => <option key={p.id} value={p.id}>{p.productNameEn}</option>)}
                              </select>
                              {item.productId && (
                                <select value={item.productSkuId} onChange={(e) => updateEditItem(idx, "productSkuId", e.target.value)}
                                  className="flex-1 px-3 py-1.5 border-2 border-border rounded-lg text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors">
                                  <option value="">No SKU</option>
                                  {(products.find((p) => p.id === item.productId)?.productSkus ?? []).map((s) => (
                                    <option key={s.id} value={s.id}>{s.skuCode} ({s.weightGrams}g)</option>
                                  ))}
                                </select>
                              )}
                            </div>
                            {editWarnings[idx] && (
                              <p className="text-xs font-bold text-red-600 mt-1 px-1">{editWarnings[idx]}</p>
                            )}
                          </div>
                        ))}
                        <button type="button" onClick={() => setEditForm({ ...editForm, items: [...editForm.items, { beanTypeName: "", quantityKg: 0, greenBeanId: "", productId: "", productSkuId: "" }] })}
                          className="text-sm text-brown hover:underline">{t("addItem")}</button>
                      </div>
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setEditingId(null)}
                          className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">{t("cancel")}</button>
                        <button onClick={handleEditSave} disabled={hasEditStockError}
                          className={`flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-lg font-bold shadow-md ${hasEditStockError ? "bg-gray-300 text-gray-500 cursor-not-allowed shadow-none" : "bg-orange text-white hover:bg-orange-dark shadow-orange/20"}`}>
                          <Save size={14} /> {t("saveChanges")}
                        </button>
                      </div>
                    </div>
                  );
                })()}

                <div className="ops-panel">
                  <h3>{t("preparationReviewLabel")}</h3>
                  <PreparationReviewTable orderId={order.id} items={order.items} onSuccess={loadData} />
                </div>

                <StatusActionsBar orderId={order.id} status={order.status} ownerId={order.ownerId} onSuccess={loadData} />

                <div className="ops-panel">
                  <h3>{t("addNoteLabel")}</h3>
                  <AddNoteForm orderId={order.id} onSuccess={loadData} />
                </div>

                <div className="ops-panel">
                  <h3>{t("activityTimelineLabel")}</h3>
                  <ActivityTimeline activities={order.activities} />
                </div>
              </>
              ); })()}
            </div>
            {(canEditOrder && editingId !== open.id) || canDelete ? (
              <div className="hr-preview-foot">
                {canEditOrder && editingId !== open.id ? (
                  <Btn onClick={() => startEdit(open)}><Pencil size={14} aria-hidden="true" /> {t("editOrder")}</Btn>
                ) : null}
                {canDelete ? (
                  <Btn variant="danger" onClick={() => deleteOrder(open.id)}><Trash2 size={14} aria-hidden="true" /> {t("deleteOrder")}</Btn>
                ) : null}
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
    </OpsRoot>
  );
}
