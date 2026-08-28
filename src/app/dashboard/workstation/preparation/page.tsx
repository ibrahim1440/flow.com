"use client";

import { useState, useEffect, useMemo } from "react";
import {
  PackageCheck, Clock, ChevronDown, ChevronUp, ClipboardList, MessageSquare,
  ShoppingCart, RefreshCw, PauseCircle, CheckCircle2,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { orderNeedsAttention } from "@/lib/order-operations-client";
import {
  OrderStatusBadge, NeedsAttentionBadge, ActivityTimeline, AddNoteForm,
  StatusActionsBar, PreparationReviewTable, OrderProgressStepper, type LifecycleActivity,
} from "@/components/OrderLifecyclePanel";

// Only these statuses represent orders currently relevant to Preparation/Production —
// approved but not yet finished, or paused. Waiting Approval, Rejected, Cancelled, and
// Completed are deliberately excluded (per S0 scope: this is a simplified operational
// view, not a full order list).
const VISIBLE_STATUSES = new Set(["Waiting Preparation Review", "Preparing", "Ready for Shipping", "On Hold"]);

// Deliberately lean: no pricing, discount, VAT, payment, or accounting fields exist on
// this type, and GET /api/orders never includes product/SKU pricing data in the first
// place — there is nothing financial to accidentally render on this screen.
type WorkstationOrderItem = {
  id: string;
  beanTypeName: string;
  quantityKg: number;
  preparationDecision: string | null;
  availableQuantity: number | null;
  productionRequiredQuantity: number | null;
};

type WorkstationOrder = {
  id: string;
  orderNumber: number;
  customer: { id: string; name: string };
  status: string;
  ownerId: string | null;
  createdAt: string;
  items: WorkstationOrderItem[];
  activities: LifecycleActivity[];
};

function lastActivityTime(order: WorkstationOrder): string {
  return order.activities.length > 0
    ? order.activities[order.activities.length - 1].createdAt
    : order.createdAt;
}

function isToday(isoDate: string): boolean {
  const d = new Date(isoDate);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export default function PreparationWorkstationPage() {
  const { t } = useI18n();
  const [orders, setOrders] = useState<WorkstationOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const res = await fetch("/api/orders");
      setOrders(res.ok ? await res.json() : []);
    } finally {
      setLoading(false);
    }
  }

  // Sort per S0 spec: (1) On Hold / Blocked first, (2) earliest delivery date — SKIPPED,
  // Order has no delivery-due-date field in this schema, so this tier cannot be applied;
  // (3) oldest last-activity-or-order-date first, so orders that have been sitting
  // longest without movement surface at the top.
  const visible = useMemo(() => {
    return orders
      .filter((o) => VISIBLE_STATUSES.has(o.status))
      .sort((a, b) => {
        const aAttn = orderNeedsAttention(a) ? 0 : 1;
        const bAttn = orderNeedsAttention(b) ? 0 : 1;
        if (aAttn !== bAttn) return aAttn - bAttn;
        return new Date(lastActivityTime(a)).getTime() - new Date(lastActivityTime(b)).getTime();
      });
  }, [orders]);

  // Empty-state summary — derived entirely from `orders`, the full, unfiltered
  // GET /api/orders response already held in state (NOT `visible`, which excludes
  // Completed and is scoped to the workstation's actionable-statuses subset). This
  // is why Completed Today can be non-zero even though Completed orders never
  // appear as cards on this page. No new queries, no fabricated numbers.
  //
  // "Created Today" — not "requested delivery date" — because the Order/OrderItem
  // schema has no requested-delivery-date field (only quotationSentDate,
  // approvalDate, createdAt). Labeled explicitly so it isn't read as something it
  // isn't.
  const summary = useMemo(() => {
    return {
      createdToday: orders.filter((o) => isToday(o.createdAt)).length,
      preparing: orders.filter((o) => o.status === "Preparing").length,
      readyForShipping: orders.filter((o) => o.status === "Ready for Shipping").length,
      onHold: orders.filter((o) => o.status === "On Hold").length,
      completedToday: orders.filter(
        (o) => o.status === "Completed" && o.activities.some((a) => a.type === "ORDER_COMPLETED" && isToday(a.createdAt))
      ).length,
    };
  }, [orders]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-charcoal flex items-center gap-2">
          <PackageCheck size={24} className="text-orange" /> {t("workstationPreparation")}
        </h1>
        <p className="text-brown text-sm font-medium">{t("workstationSubtitle")}</p>
      </div>

      {loading ? (
        <div className="text-center py-16">
          <div className="w-10 h-10 border-4 border-orange border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-brown text-sm font-medium">{t("loading")}</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              { label: t("summaryCreatedToday"), value: summary.createdToday, Icon: ShoppingCart },
              { label: t("summaryPreparing"), value: summary.preparing, Icon: RefreshCw },
              { label: t("summaryReadyForShipping"), value: summary.readyForShipping, Icon: PackageCheck },
              { label: t("summaryOnHold"), value: summary.onHold, Icon: PauseCircle },
              { label: t("summaryCompletedToday"), value: summary.completedToday, Icon: CheckCircle2 },
            ].map((card) => (
              <div key={card.label} className="bg-white rounded-xl border border-oo-border-default p-3 sm:p-3.5 flex flex-col items-center text-center gap-1">
                <card.Icon size={16} className="text-oo-text-secondary" aria-hidden="true" />
                <span className="text-xl font-extrabold text-oo-text-primary">{card.value}</span>
                <span className="text-[11px] font-semibold text-oo-text-muted">{card.label}</span>
              </div>
            ))}
          </div>
          <div className="text-center py-16 text-gray-400 bg-white rounded-2xl border">
            <PackageCheck size={40} className="mx-auto mb-2" />
            <p>{t("workstationEmpty")}</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visible.map((order) => {
            const attention = orderNeedsAttention(order);
            const isOpen = openId === order.id;
            return (
              <div
                key={order.id}
                className={`bg-white rounded-2xl border-2 shadow-sm overflow-hidden transition-colors ${
                  attention ? "border-red-300" : "border-border"
                } ${isOpen ? "xl:col-span-3 md:col-span-2" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : order.id)}
                  className="w-full text-start p-5 hover:bg-cream/50 active:bg-cream transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-lg font-extrabold text-charcoal">#{order.orderNumber}</p>
                      <p className="text-sm text-brown font-medium">{order.customer.name}</p>
                    </div>
                    {isOpen ? (
                      <ChevronUp size={22} className="text-brown/50 flex-shrink-0" />
                    ) : (
                      <ChevronDown size={22} className="text-brown/50 flex-shrink-0" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap mt-3">
                    <OrderStatusBadge status={order.status} />
                    {attention && <NeedsAttentionBadge />}
                  </div>
                  <div className="flex items-center justify-between mt-3 text-xs text-brown/60 font-medium">
                    <span>{order.items.length} {t("itemCountLabel")}</span>
                    <span className="flex items-center gap-1">
                      <Clock size={12} /> {formatDate(lastActivityTime(order))}
                    </span>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-border p-4 bg-cream space-y-3">
                    {/* Progress Stepper — lifecycle milestones, not the activity log */}
                    <div className="bg-white rounded-xl border border-border px-4 py-3">
                      <OrderProgressStepper status={order.status} items={order.items} />
                    </div>

                    {/* Desktop: two-column (main content + right rail). Tablet and below:
                        single column, timeline/status actions fall below preparation. */}
                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
                      <div className="xl:col-span-2 space-y-3">
                        <div className="bg-white rounded-xl border border-border p-3.5">
                          <p className="text-sm font-bold text-brown mb-2 flex items-center gap-1.5">
                            <ClipboardList size={16} /> {t("preparationReviewLabel")}
                          </p>
                          <PreparationReviewTable orderId={order.id} items={order.items} onSuccess={loadData} />
                        </div>

                        <div className="bg-white rounded-xl border border-border p-3.5">
                          <p className="text-sm font-bold text-brown mb-2 flex items-center gap-1.5">
                            <MessageSquare size={16} /> {t("addNoteLabel")}
                          </p>
                          <AddNoteForm orderId={order.id} onSuccess={loadData} />
                        </div>
                      </div>

                      <div className="xl:col-span-1 space-y-3">
                        <StatusActionsBar
                          orderId={order.id}
                          status={order.status}
                          ownerId={order.ownerId}
                          onSuccess={loadData}
                          large
                        />

                        <div className="bg-white rounded-xl border border-border p-3.5">
                          <p className="text-sm font-bold text-brown mb-2 flex items-center gap-1.5">
                            <Clock size={16} /> {t("activityTimelineLabel")}
                          </p>
                          <ActivityTimeline activities={order.activities} />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
