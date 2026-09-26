"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, ArrowRight, Clock, ClipboardList, Hammer, MessageSquare, PackageCheck, ShieldAlert,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { orderNeedsAttention } from "@/lib/order-operations-client";
import {
  OrderStatusBadge, NeedsAttentionBadge, ActivityTimeline, AddNoteForm, OwnerDisplay,
  StatusActionsBar, PreparationReviewTable, OrderProgressStepper, type LifecycleActivity,
} from "@/components/OrderLifecyclePanel";
import { ProductionRequirementPanel } from "@/components/ProductionRequirementPanel";
import { useSetPageCrumb } from "../../../_components/page-crumb";

/**
 * Order Preparation — one order.
 *
 * FZ-B composes this as a single-column task: who the order is for, where it stands, what
 * committing will do to it, then the lines, then the action. The queue answers "what needs
 * preparation?"; this answers "what exactly do I do with this order?", and the two are not
 * the same question crammed into one screen.
 *
 * ── One implementation ──
 * Nothing about preparation is calculated here. The allocation preview, the derived
 * result, Block Item and Commit Allocation all live in PreparationReviewTable, which the
 * queue used before this route existed and which remains the single authority. This page
 * fetches an order and arranges components; the backend decides everything that matters.
 */

type PrepItem = {
  id: string;
  beanTypeName: string;
  quantityKg: number;
  preparationDecision: string | null;
  availableQuantity: number | null;
  productionRequiredQuantity: number | null;
};

type PrepOrder = {
  id: string;
  orderNumber: number;
  customer: { id: string; name: string };
  status: string;
  ownerId: string | null;
  owner?: { id: string; name: string; role: string } | null;
  createdAt: string;
  items: PrepItem[];
  activities: LifecycleActivity[];
};

type LoadState = "loading" | "ready" | "notFound" | "refused";

export default function PreparationDetailPage() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const params = useParams<{ orderId: string }>();
  const orderId = params?.orderId;

  const [order, setOrder] = useState<PrepOrder | null>(null);
  const [state, setState] = useState<LoadState>("loading");

  const Back = lang === "ar" ? ArrowRight : ArrowLeft;
  const QUEUE = "/dashboard/workstation/preparation";

  // "Order #10248" in the shell's breadcrumb. The registry can name the branch; only this
  // page knows the record.
  useSetPageCrumb(order ? `${t("orderLabel")} #${order.orderNumber}` : null);

  // Children ask for a refresh by bumping this; the effect below is the only thing that
  // fetches. Keeping the request inside the effect means nothing dispatches state during
  // the render that scheduled it, and there is still exactly one copy of the load.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (!orderId) return;
    let gone = false;
    (async () => {
      // The certified list endpoint already returns items, owner and activities, and
      // already applies the caller's permissions. A dedicated read endpoint would be a
      // second place for authorization to drift out of step, for no benefit this screen
      // can measure.
      const res = await fetch("/api/orders");
      if (gone) return;
      if (res.status === 401 || res.status === 403) { setState("refused"); return; }
      if (!res.ok) { setState("notFound"); return; }
      const all: PrepOrder[] = await res.json();
      if (gone) return;
      const found = all.find((o) => o.id === orderId);
      // An order the caller cannot see and an order that does not exist are reported
      // identically on purpose: distinguishing them would confirm the existence of a
      // record across a permission boundary.
      if (!found) { setState("notFound"); return; }
      setOrder(found);
      setState("ready");
    })();
    return () => { gone = true; };
  }, [orderId, reloadToken]);

  if (state === "loading") {
    return (
      <div className="text-center py-20">
        <div className="w-10 h-10 border-4 border-oo-action-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-oo-text-secondary text-sm font-medium">{t("loading")}</p>
      </div>
    );
  }

  if (state !== "ready" || !order) {
    return (
      <div className="max-w-md mx-auto mt-16 bg-oo-bg-default rounded-oo-large border border-oo-border-default p-8 text-center">
        <div className="w-12 h-12 rounded-oo-medium bg-oo-status-blocked-bg flex items-center justify-center mx-auto mb-4">
          <ShieldAlert size={22} className="text-oo-status-blocked" />
        </div>
        <h1 className="text-lg font-bold text-oo-text-primary">
          {state === "refused" ? t("accessDeniedTitle") : t("prepOrderNotFoundTitle")}
        </h1>
        <p className="text-sm text-oo-text-secondary mt-1.5">
          {state === "refused" ? t("accessDeniedBody") : t("prepOrderNotFoundBody")}
        </p>
        <a
          href={QUEUE}
          className="inline-block mt-5 px-4 py-2 bg-oo-action-primary text-white rounded-oo-small text-sm font-semibold hover:bg-oo-action-primary-hover transition-colors"
        >
          {t("prepBackToQueue")}
        </a>
      </div>
    );
  }

  const attention = orderNeedsAttention(order);

  return (
    // Single column, and deliberately bounded: a task read top to bottom does not get
    // easier on a 2560px monitor if the table stretches the whole way across it.
    <div className="max-w-5xl mx-auto space-y-4">
      <a
        href={QUEUE}
        className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-oo-text-secondary hover:text-oo-text-primary transition-colors"
      >
        <Back size={14} aria-hidden="true" />
        {t("prepBackToQueue")}
      </a>

      {/* ── Who and where ── */}
      <header className="bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-[21px] font-bold text-oo-text-primary flex items-center gap-2 flex-wrap">
              <PackageCheck size={20} className="text-oo-action-primary shrink-0" aria-hidden="true" />
              {t("orderLabel")} #{order.orderNumber} — {order.customer.name}
            </h1>
            <p className="text-[12.5px] text-oo-text-secondary mt-1">
              {order.items.length} {t("itemCountLabel")} · {formatDate(order.createdAt)}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {attention && <NeedsAttentionBadge />}
            <OrderStatusBadge status={order.status} />
            <OwnerDisplay owner={order.owner ?? null} />
          </div>
        </div>

        <OrderProgressStepper status={order.status} items={order.items} />
      </header>

      {/* ── What committing will do, then the lines, then the action.
             PreparationReviewTable owns that whole sequence. ── */}
      <section
        aria-labelledby="prep-review-heading"
        className="bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5 space-y-3"
      >
        <h2 id="prep-review-heading" className="text-[15px] font-semibold text-oo-text-primary flex items-center gap-2">
          <ClipboardList size={17} className="text-oo-text-muted" aria-hidden="true" />
          {t("preparationReviewLabel")}
        </h2>
        <PreparationReviewTable orderId={order.id} items={order.items} onSuccess={reload} />
      </section>

      {/* ── What the shelf could not cover ── */}
      <section
        aria-labelledby="prep-production-heading"
        className="bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5 space-y-3"
      >
        <h2 id="prep-production-heading" className="text-[15px] font-semibold text-oo-text-primary flex items-center gap-2">
          <Hammer size={17} className="text-oo-text-muted" aria-hidden="true" />
          {t("productionReqTitle")}
        </h2>
        <ProductionRequirementPanel itemIds={order.items.map((i) => i.id)} />
      </section>

      {/* ── Secondary actions: everything that is not Commit Allocation ── */}
      <section
        aria-labelledby="prep-actions-heading"
        className="bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5 space-y-3"
      >
        <h2 id="prep-actions-heading" className="text-[15px] font-semibold text-oo-text-primary">
          {t("orderStatusLabel")}
        </h2>
        <StatusActionsBar
          orderId={order.id}
          status={order.status}
          ownerId={order.ownerId}
          onSuccess={reload}
        />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section
          aria-labelledby="prep-note-heading"
          className="bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5 space-y-3"
        >
          <h2 id="prep-note-heading" className="text-[15px] font-semibold text-oo-text-primary flex items-center gap-2">
            <MessageSquare size={17} className="text-oo-text-muted" aria-hidden="true" />
            {t("addNoteLabel")}
          </h2>
          <AddNoteForm orderId={order.id} onSuccess={reload} />
        </section>

        <section
          aria-labelledby="prep-activity-heading"
          className="bg-oo-bg-default rounded-oo-large border border-oo-border-default p-5 space-y-3"
        >
          <h2 id="prep-activity-heading" className="text-[15px] font-semibold text-oo-text-primary flex items-center gap-2">
            <Clock size={17} className="text-oo-text-muted" aria-hidden="true" />
            {t("activityTimelineLabel")}
          </h2>
          <ActivityTimeline activities={order.activities} />
        </section>
      </div>

      <button
        type="button"
        onClick={() => router.push(QUEUE)}
        className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-oo-text-secondary hover:text-oo-text-primary transition-colors"
      >
        <Back size={14} aria-hidden="true" />
        {t("prepBackToQueue")}
      </button>
    </div>
  );
}
