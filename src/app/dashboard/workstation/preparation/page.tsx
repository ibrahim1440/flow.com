"use client";

import { useState, useEffect, useMemo } from "react";
import { useI18n } from "@/lib/i18n/context";
import { orderNeedsAttention } from "@/lib/order-operations-client";
import {
  OrderStatusBadge, NeedsAttentionBadge, ActivityTimeline, AddNoteForm,
  StatusActionsBar, PreparationReviewTable, OrderProgressStepper, type LifecycleActivity,
} from "@/components/OrderLifecyclePanel";
import { ProductionRequirementPanel } from "@/components/ProductionRequirementPanel";
import { ITEM_FORMS, Metrics, ORDER_FORMS, OpsEmpty, OpsError, OpsLoading, OpsPane, OpsRoot, PageHeader, SecHead, countNoun, opsDate } from "@/components/ops/ui";

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
  // E7: master-data names, shown in the interface language by the review table.
  product?: { productNameEn: string; productNameAr: string | null } | null;
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
  // G-7: a failed list read is an error with retry, never «no orders».
  const [loadError, setLoadError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // N-03: 768+ pins the pane actions in its footer; the commit button is portalled into it.
  const [commitSlot, setCommitSlot] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const res = await fetch("/api/orders");
      if (!res.ok) { await res.text(); setLoadError(true); return; }
      setOrders(await res.json());
      setLoadError(false);
    } catch {
      setLoadError(true);
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

  const open = visible.find((o) => o.id === openId) ?? null;

  return (
    <OpsRoot>
      <div className={`hr-split${open ? " has-preview" : ""}`}>
      <div className="hr-page">
        <PageHeader title={t("workstationPreparation")}>
          <span>{t("workstationSubtitle")}</span>
        </PageHeader>

        <Metrics items={[
          [t("summaryCreatedToday"), <span key="a" className="hr-num">{summary.createdToday}</span>],
          [t("summaryPreparing"), <span key="b" className="hr-num">{summary.preparing}</span>],
          [t("summaryReadyForShipping"), <span key="c" className="hr-num">{summary.readyForShipping}</span>],
          [t("summaryOnHold"), <span key="d" className="hr-num">{summary.onHold}</span>],
          [t("summaryCompletedToday"), <span key="e" className="hr-num">{summary.completedToday}</span>],
        ]} />

        {loadError && !loading ? (
          <OpsError message={t("prepLoadFailed")} onRetry={loadData} />
        ) : loading ? (
          <OpsLoading rows={4} />
        ) : visible.length === 0 ? (
          <OpsEmpty title={t("workstationEmpty")} />
        ) : (
          <>
            {/* N-24 (OG-P1, G-10): one head string, «قائمة التجهيز · 5 طلبات». */}
            <SecHead title={<>{t("prepQueueTitle")} · {countNoun(visible.length, lang, ORDER_FORMS)}</>} />
            {/* OG-P1/P3/P5: the queue; a row opens the order in the pane (1440), the drawer
                (1024) or the full-height detail on the phone (P6). */}
            <ul className="ops-queue ops-prepq" aria-label={t("workstationPreparation")}>
              {visible.map((order) => {
                const attention = orderNeedsAttention(order);
                const isOpen = openId === order.id;
                return (
                  <li
                    key={order.id}
                    data-testid={`ws-row-${order.orderNumber}`}
                    className={`ops-qrow${isOpen ? " is-open" : ""}${attention ? " is-attn" : ""}`}
                  >
                    <button
                      type="button"
                      className="ops-qhead"
                      aria-expanded={isOpen}
                      onClick={() => setOpenId(isOpen ? null : order.id)}
                    >
                      <span className="ops-qmain">
                        <span className="ops-qtitle">{order.customer.name} · <span className="hr-id">#{order.orderNumber}</span></span>
                        <span className="ops-sub">
                          {countNoun(order.items.length, lang, ITEM_FORMS)} · {t("lastActivityLabel")} {opsDate(lastActivityTime(order), lang, true)}
                        </span>
                      </span>
                      <span className="ops-qend">
                        {attention && <NeedsAttentionBadge />}
                        <OrderStatusBadge status={order.status} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {open ? (
        <OpsPane
          testId={`ws-order-${open.orderNumber}`}
          phone="page"
          label={`#${open.orderNumber}`}
          title={<><span className="hr-id">#{open.orderNumber}</span> <span>{open.customer.name}</span></>}
          sub={<OrderStatusBadge status={open.status} />}
          onClose={() => setOpenId(null)}
          // N-05 (OG-P3, G-5): at 768–1279 the drawer leaves the queue visible and usable.
          drawer="open"
          // N-03 (OG-P1 / OG-P3): commit · hold · cancel pinned in the pane footer (768+). The
          // phone keeps the OG-P6 layout (hold / cancel in the body, the commit bar at the bottom).
          footer={wide ? (
            <div className="ops-prepfoot">
              <div className="ops-commitslot" ref={setCommitSlot} />
              <StatusActionsBar orderId={open.id} status={open.status} ownerId={open.ownerId} onSuccess={loadData} itemIds={open.items.map((i) => i.id)} large />
            </div>
          ) : undefined}
        >
          <OrderProgressStepper status={open.status} items={open.items} />
          <div className="ops-panel" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
            <h3>{t("preparationReviewLabel")}</h3>
            <PreparationReviewTable orderId={open.id} items={open.items} onSuccess={loadData} commitSlot={wide ? commitSlot : null} />
          </div>
          {/* What the shelf could not cover, and the button that turns exactly that into a
              production order. */}
          <div className="ops-panel">
            <h3>{t("productionReqTitle")}</h3>
            <ProductionRequirementPanel itemIds={open.items.map((i) => i.id)} />
          </div>
          {wide ? null : (
            <div className="ops-panel">
              <StatusActionsBar orderId={open.id} status={open.status} ownerId={open.ownerId} onSuccess={loadData} itemIds={open.items.map((i) => i.id)} large />
            </div>
          )}
          <div className="ops-panel">
            <h3>{t("addNoteLabel")}</h3>
            <AddNoteForm orderId={open.id} onSuccess={loadData} />
          </div>
          <div className="ops-panel">
            <h3>{t("activityTimelineLabel")}</h3>
            <ActivityTimeline activities={open.activities} />
          </div>
        </OpsPane>
      ) : null}
      </div>
    </OpsRoot>
  );
}
