"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  PackageCheck, Clock, ShoppingCart, RefreshCw, PauseCircle, CheckCircle2,
  ChevronRight as OpenLtr, ChevronLeft as OpenRtl,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { orderNeedsAttention } from "@/lib/order-operations-client";
import {
  OrderStatusBadge, NeedsAttentionBadge, type LifecycleActivity,
} from "@/components/OrderLifecyclePanel";

// Orders currently relevant to Preparation — live or paused, not finished.
//
// "Waiting Approval" is included, and it is not a leftover. Routine approval was removed
// from the normal path, so nothing new lands there, but orders created under the old
// workflow still sit in it and can now commit an allocation directly. Excluding them from
// this screen would strand exactly the orders the compatibility rule exists to rescue.
//
// Rejected, Cancelled and Completed stay excluded: this is a simplified operational view,
// not a full order list.
const VISIBLE_STATUSES = new Set([
  "Waiting Approval",
  "Waiting Preparation Review",
  "Preparing",
  "Ready for Shipping",
  "On Hold",
]);

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
  const { t, lang } = useI18n();
  const [orders, setOrders] = useState<WorkstationOrder[]>([]);
  const [loading, setLoading] = useState(true);
  // The affordance points the way the operator reads, into the order's own screen.
  const Open = lang === "ar" ? OpenRtl : OpenLtr;

  // Declared before the effect that runs it, and told when it has been abandoned, so a
  // response arriving after the operator has left cannot set state on an unmounted page.
  const loadData = useCallback(async (cancelled?: () => boolean) => {
    // No setLoading(true) here: `loading` already starts true, and this is the only
    // caller. Setting it synchronously would make the effect below dispatch during the
    // same render, which is the cascade the linter is warning about.
    try {
      const res = await fetch("/api/orders");
      const data = res.ok ? await res.json() : [];
      if (cancelled?.() === true) return;
      setOrders(data);
    } finally {
      if (cancelled?.() !== true) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let gone = false;
    void loadData(() => gone);
    return () => { gone = true; };
  }, [loadData]);

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
        <h1 className="text-2xl font-bold text-oo-text-primary flex items-center gap-2">
          <PackageCheck size={24} className="text-oo-action-primary" /> {t("workstationPreparation")}
        </h1>
        <p className="text-oo-text-secondary text-sm font-medium">{t("workstationSubtitle")}</p>
      </div>

      {loading ? (
        <div className="text-center py-16">
          <div className="w-10 h-10 border-4 border-oo-action-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-oo-text-secondary text-sm font-medium">{t("loading")}</p>
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
              <div key={card.label} className="bg-white rounded-oo-medium border border-oo-border-default p-3 sm:p-3.5 flex flex-col items-center text-center gap-1">
                <card.Icon size={16} className="text-oo-text-secondary" aria-hidden="true" />
                <span className="text-xl font-bold text-oo-text-primary">{card.value}</span>
                <span className="text-[11px] font-semibold text-oo-text-muted">{card.label}</span>
              </div>
            ))}
          </div>
          <div className="text-center py-16 text-gray-400 bg-oo-bg-default rounded-oo-large border">
            <PackageCheck size={40} className="mx-auto mb-2" />
            <p>{t("workstationEmpty")}</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visible.map((order) => {
            const attention = orderNeedsAttention(order);
            return (
              // A worklist entry, not a workspace. Preparing an order is a task with its
              // own screen; doing it inside a grid cell meant the operator read the lines
              // in a third of the width and the queue carried a second, parallel copy of
              // the whole workflow.
              <a
                key={order.id}
                href={`/dashboard/workstation/preparation/${order.id}`}
                data-testid={`ws-order-${order.orderNumber}`}
                className={`block rounded-oo-large border-2 p-5 bg-oo-bg-default transition-colors
                  hover:bg-oo-bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2
                  focus-visible:outline-oo-action-primary ${
                  attention ? "border-oo-status-blocked/40" : "border-oo-border-default"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-lg font-bold text-oo-text-primary">#{order.orderNumber}</p>
                    <p className="text-sm text-oo-text-secondary font-medium truncate">{order.customer.name}</p>
                  </div>
                  <Open size={18} className="text-oo-text-muted shrink-0 mt-1" aria-hidden="true" />
                </div>
                <div className="flex items-center gap-2 flex-wrap mt-3">
                  <OrderStatusBadge status={order.status} />
                  {attention && <NeedsAttentionBadge />}
                </div>
                <div className="flex items-center justify-between mt-3 text-xs text-oo-text-secondary font-medium">
                  <span>{order.items.length} {t("itemCountLabel")}</span>
                  <span className="flex items-center gap-1">
                    <Clock size={12} aria-hidden="true" /> {formatDate(lastActivityTime(order))}
                  </span>
                </div>
                <span className="sr-only">{t("prepOpenOrder")}</span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
