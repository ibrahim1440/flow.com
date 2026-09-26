"use client";

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import {
  AlertTriangle, Clock, ClipboardClock, MessageSquare, PauseCircle, RotateCcw, Ban, CheckCircle2,
  ClipboardList, UserCircle2, Loader2, Send, RefreshCw, PackageCheck, XCircle, Hammer,
  CircleDashed, CircleDotDashed, Check, Flame, ChevronLeft, ChevronRight,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useUser } from "@/app/dashboard/user-context";
import { hasSubPrivilege, hasModuleAccess } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/translations";
import {
  describeApiError,
  submitOrderNote,
  submitOrderStatusAction,
  submitPreparationReview,
  canHold, canResume, canCancel, canComplete,
  fetchFulfillmentOptions,
  derivePreparationDecision,
  roundKg,
  type OrderStatusAction, type OrderNoteDepartment, type PreparationReviewItemInput,
  type FulfillmentOptions,
} from "@/lib/order-operations-client";

// ─── Shared types (structural — page-specific Order/OrderItem types satisfy these) ──

export type LifecycleActivity = {
  id: string;
  type: string;
  message: string;
  department: string | null;
  authorName: string;
  createdAt: string;
};

export type PreparationOrderItem = {
  id: string;
  beanTypeName: string;
  quantityKg: number;
  preparationDecision: string | null;
  availableQuantity: number | null;
  productionRequiredQuantity: number | null;
};

// ─── Small display helpers ───────────────────────────────────────────────────

const ORDER_STATUS_LABEL_KEYS: Record<string, TranslationKey> = {
  "Waiting Approval": "orderStatusWaitingApproval",
  "Waiting Preparation Review": "orderStatusWaitingPrepReview",
  "Preparing": "orderStatusPreparing",
  "Ready for Shipping": "orderStatusReadyForShipping",
  "Completed": "completed",
  "On Hold": "orderStatusOnHold",
  "Cancelled": "orderStatusCancelled",
  "Rejected": "orderStatusRejected",
};

// Icon and colour-token pairing per approved status — every status must be
// distinguishable by icon + label, never by colour alone.
//
// Cancelled vs Rejected is the distinction to protect: Cancelled is NEUTRAL grey
// (#3f3f46 on #f4f4f5, XCircle) because the order simply stopped; Rejected is
// DESTRUCTIVE red (#b91c1c on #fef2f2, Ban) because it failed the approval gate.
// They must never be merged.
//
// Rejected and Blocked intentionally share the red-50 background. That is not a
// bug to "fix": Blocked is an item-level decision at #dc2626 with AlertTriangle,
// Rejected is an order-level status one step darker at #b91c1c with Ban, so they
// stay separable by foreground, icon, label and level.
const ORDER_STATUS_ICON: Record<string, React.ElementType> = {
  "Waiting Approval": Clock,
  "Waiting Preparation Review": ClipboardClock,
  "Preparing": RefreshCw,
  "Ready for Shipping": PackageCheck,
  "Completed": CheckCircle2,
  "On Hold": PauseCircle,
  "Cancelled": XCircle,
  "Rejected": Ban,
};

const ORDER_STATUS_TOKEN: Record<string, { fg: string; bg: string; border: string }> = {
  "Waiting Approval":           { fg: "text-oo-status-waiting",   bg: "bg-oo-status-waiting-bg",   border: "border-oo-status-waiting/30" },
  "Waiting Preparation Review": { fg: "text-oo-status-waiting",   bg: "bg-oo-status-waiting-bg",   border: "border-oo-status-waiting/30" },
  "Preparing":                  { fg: "text-oo-status-preparing", bg: "bg-oo-status-preparing-bg", border: "border-oo-status-preparing/30" },
  "Ready for Shipping":         { fg: "text-oo-status-ready",     bg: "bg-oo-status-ready-bg",     border: "border-oo-status-ready/30" },
  "Completed":                  { fg: "text-oo-status-success",   bg: "bg-oo-status-success-bg",   border: "border-oo-status-success/30" },
  "On Hold":                    { fg: "text-oo-status-hold",      bg: "bg-oo-status-hold-bg",      border: "border-oo-status-hold/30" },
  "Cancelled":                  { fg: "text-oo-status-cancelled", bg: "bg-oo-status-cancelled-bg", border: "border-oo-status-cancelled/30" },
  "Rejected":                   { fg: "text-oo-status-rejected",  bg: "bg-oo-status-rejected-bg",  border: "border-oo-status-rejected/30" },
};

export function OrderStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const labelKey = ORDER_STATUS_LABEL_KEYS[status];
  const token = ORDER_STATUS_TOKEN[status] ?? ORDER_STATUS_TOKEN["Waiting Approval"];
  const Icon = ORDER_STATUS_ICON[status] ?? Clock;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${token.fg} ${token.bg} ${token.border}`}>
      <Icon size={13} aria-hidden="true" />
      {labelKey ? t(labelKey) : status}
    </span>
  );
}

export function NeedsAttentionBadge() {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold text-oo-status-blocked bg-oo-status-blocked-bg border border-oo-status-blocked/30">
      <AlertTriangle size={11} aria-hidden="true" /> {t("needsAttention")}
    </span>
  );
}

export function orderOwnerDisplayName(owner: { name: string } | null): string | null {
  return owner?.name ?? null;
}

// ─── Progress Stepper ─────────────────────────────────────────────────────────
// NOT the Activity Timeline — this shows lifecycle *milestones*, not a log of every
// event.
//
// The displayed lifecycle is exactly four stages:
//
//     Created → Preparation → Ready for Shipping → Completed
//
// Approval is NOT one of them. Routine approval was removed from the normal path, so a
// stage for it would be permanently unreachable — an order now goes straight from Created
// into Preparation. Production is not one either: it is work that happens INSIDE
// Preparation, not a milestone an order passes through. Both are deliberate.
//
// The internal statuses are unchanged and remain more granular than this; the map below is
// a display projection of them, and nothing here writes or renames a status.
const STEPPER_STAGES = ["Created", "Preparation", "Ready for Shipping", "Completed"] as const;
type StepperStage = typeof STEPPER_STAGES[number];
// "active"  — a stage with genuine work happening right now (Preparation while
//             Preparing, Ready while Ready for Shipping).
// "pending" — retained for the stage treatments below; no normal-path stage uses it now
//             that the approval gate is gone.
type StageState = "complete" | "active" | "pending" | "future" | "paused" | "negative";

const STAGE_LABEL_KEY: Record<StepperStage, TranslationKey> = {
  "Created": "stepperCreated",
  "Preparation": "stepperPreparation",
  "Ready for Shipping": "stepperReadyForShipping",
  "Completed": "stepperCompleted",
};

// Derives stepper state from data that's already available on the order — no new
// fields, no backend changes. On Hold and Cancelled don't map to one clean linear
// stage, so this makes a best-effort inference from item decisions (and
// approvalStatus, when the caller has it) rather than guessing precisely; that
// limitation is intentional and documented rather than hidden.
function computeProgressStages(order: {
  status: string;
  approvalStatus?: string;
  items: { preparationDecision: string | null }[];
}): { states: StageState[]; negativeKind?: "cancelled" | "rejected" } {
  const hasAnyDecision = order.items.some((i) => i.preparationDecision);
  const allDecided = order.items.length > 0 && order.items.every((i) => i.preparationDecision);

  // Stage indices: 0 Created, 1 Preparation, 2 Ready for Shipping, 3 Completed.
  // "Created" is complete for every order that exists, which is every order this renders.
  const CREATED = 0, PREPARATION = 1, READY = 2;

  if (order.status === "Completed") {
    return { states: STEPPER_STAGES.map(() => "complete") };
  }
  if (order.status === "Rejected") {
    // Rejection is now only reachable through the exceptional approval route, which is off
    // the normal path. It still has to render honestly when it appears on historical data:
    // the order was created, and it stopped at Preparation.
    return {
      states: STEPPER_STAGES.map((_, i) =>
        i === CREATED ? "complete" : i === PREPARATION ? "negative" : "future"),
      negativeKind: "rejected",
    };
  }
  if (order.status === "On Hold") {
    // Hold is reachable from Waiting Preparation Review / Preparing / Ready for Shipping.
    const base = allDecided ? READY : PREPARATION;
    return { states: STEPPER_STAGES.map((_, i) => (i < base ? "complete" : i === base ? "paused" : "future")) };
  }
  if (order.status === "Cancelled") {
    // Cancel is allowed from almost any non-terminal status, so the reached stage is
    // genuinely ambiguous — infer the furthest confirmed milestone from the item decisions
    // rather than fabricating precision.
    const base = hasAnyDecision ? (allDecided ? READY : PREPARATION) : PREPARATION;
    return {
      states: STEPPER_STAGES.map((_, i) => (i < base ? "complete" : i === base ? "negative" : "future")),
      negativeKind: "cancelled",
    };
  }

  // The normal path. "Waiting Approval" is included because legacy orders are still in it
  // and they are, in displayed terms, simply waiting to be prepared — there is no approval
  // stage left for them to sit on.
  const STATUS_BASE: Record<string, number> = {
    "Waiting Approval": PREPARATION,
    "Waiting Preparation Review": PREPARATION,
    "Preparing": PREPARATION,
    "Ready for Shipping": READY,
  };
  const base = STATUS_BASE[order.status] ?? (allDecided ? READY : PREPARATION);
  return { states: STEPPER_STAGES.map((_, i) => (i < base ? "complete" : i === base ? "active" : "future")) };
}

// Screen-reader equivalent of the visual stage treatment. Without this the stepper
// announces five bare stage names with no indication of which one the order is at.
function stageStateLabelKey(state: StageState, negativeKind?: "cancelled" | "rejected"): TranslationKey {
  switch (state) {
    case "complete": return "stepperStateComplete";
    case "active":   return "stepperStateActive";
    case "pending":  return "stepperStatePending";
    case "paused":   return "stepperStatePaused";
    case "negative": return negativeKind === "rejected" ? "stepperStateRejected" : "stepperStateCancelled";
    default:         return "stepperStateUpcoming";
  }
}

/**
 * How a stage is drawn.
 *
 * FZ-B draws each stage as a labelled box rather than a dot on a rail, and the reason is
 * legibility rather than taste: the box carries the stage name AND its state on two lines
 * at a readable size, where a dot has to push both underneath a 6px circle. `box` is the
 * container treatment; `fg` colours the stage name.
 */
function stageVisual(state: StageState, negativeKind?: "cancelled" | "rejected") {
  switch (state) {
    case "complete":
      return { Icon: Check, fg: "text-oo-status-success", box: "border-oo-status-success/40 bg-oo-status-success-bg" };
    case "paused":
      return { Icon: PauseCircle, fg: "text-oo-status-hold", box: "border-oo-status-hold bg-oo-status-hold-bg" };
    case "negative":
      return negativeKind === "rejected"
        ? { Icon: Ban, fg: "text-oo-status-rejected", box: "border-oo-status-rejected bg-oo-status-rejected-bg" }
        : { Icon: XCircle, fg: "text-oo-status-cancelled", box: "border-oo-status-cancelled bg-oo-status-cancelled-bg" };
    case "active":
      // The one stage the order is actually at, and the only one with a heavier border.
      return { Icon: null, fg: "text-oo-status-preparing", box: "border-[1.5px] border-oo-status-preparing bg-oo-status-preparing-bg" };
    case "pending":
      // Deliberately identical to "future" — this is an undecided yes/no gate, not work in
      // progress. Slightly less-muted text so it still reads as "next up".
      return { Icon: null, fg: "text-oo-text-secondary", box: "border-oo-border-default bg-oo-bg-default" };
    default: // future
      return { Icon: null, fg: "text-oo-text-muted", box: "border-oo-border-default bg-oo-bg-default" };
  }
}

export function OrderProgressStepper({
  status,
  approvalStatus,
  items,
}: {
  status: string;
  approvalStatus?: string;
  items: { preparationDecision: string | null }[];
}) {
  const { t, lang } = useI18n();
  const { states, negativeKind } = computeProgressStages({ status, approvalStatus, items });

  // The arrow points along the reading direction, so progress runs the way the language
  // does rather than being mirrored by hand.
  const Arrow = lang === "ar" ? ChevronLeft : ChevronRight;

  return (
    <ol className="flex items-stretch w-full gap-1" aria-label={t("stepperLabel")}>
      {STEPPER_STAGES.map((stage, i) => {
        const state = states[i];
        const visual = stageVisual(state, negativeKind);
        // The stage the order is actually sitting at — "active" while work is in
        // progress, "paused" while held. A terminal/negative stage is where the
        // order stopped, so it is the current step too.
        const isCurrent = state === "active" || state === "paused" || state === "negative";
        return (
          <li
            key={stage}
            {...(isCurrent ? { "aria-current": "step" as const } : {})}
            className="flex-1 min-w-0 flex items-center gap-1"
          >
            {i > 0 && (
              <Arrow size={13} className="shrink-0 text-oo-text-muted" aria-hidden="true" />
            )}
            <div
              className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5
                rounded-oo-medium border px-2 py-2 text-center ${visual.box}`}
            >
              <span className={`flex items-center gap-1 text-[12px] font-semibold leading-tight truncate max-w-full ${visual.fg}`}>
                {visual.Icon && <visual.Icon size={11} className="shrink-0" aria-hidden="true" />}
                {t(STAGE_LABEL_KEY[stage])}
              </span>
              {/* The state, shown rather than hidden. It was sr-only, which meant a sighted
                  operator had to infer "not started" from a pale border. */}
              <span className="text-[9.5px] leading-tight text-oo-text-muted truncate max-w-full">
                {t(stageStateLabelKey(state, negativeKind))}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ─── Activity Timeline ────────────────────────────────────────────────────────

const ACTIVITY_LABEL_KEYS: Record<string, TranslationKey> = {
  ORDER_CREATED: "activityOrderCreated",
  ORDER_APPROVED: "activityOrderApproved",
  ORDER_REJECTED: "activityOrderRejected",
  PREPARATION_REVIEWED: "activityPreparationReviewed",
  STATUS_CHANGED: "activityStatusChanged",
  MANUAL_NOTE: "activityManualNote",
  ORDER_HELD: "activityOrderHeld",
  ORDER_RESUMED: "activityOrderResumed",
  ORDER_CANCELLED: "activityOrderCancelled",
  ORDER_COMPLETED: "activityOrderCompleted",
  PRODUCTION_ORDER_CREATED: "activityProductionOrderCreated",
  PRODUCTION_ORDER_RELEASED: "activityProductionOrderReleased",
  PRODUCTION_ORDER_COMPLETED: "activityProductionOrderCompleted",
  PRODUCTION_ORDER_CANCELLED: "activityProductionOrderCancelled",
  PRODUCTION_BATCH_LINKED: "activityProductionBatchLinked",
  PRODUCTION_BATCH_UNLINKED: "activityProductionBatchUnlinked",
};

const ACTIVITY_ICON: Record<string, React.ElementType> = {
  ORDER_APPROVED: CheckCircle2,
  ORDER_REJECTED: Ban,
  PREPARATION_REVIEWED: ClipboardList,
  MANUAL_NOTE: MessageSquare,
  ORDER_HELD: PauseCircle,
  ORDER_RESUMED: RotateCcw,
  ORDER_CANCELLED: Ban,
  ORDER_COMPLETED: CheckCircle2,
  PRODUCTION_ORDER_CREATED: Hammer,
  PRODUCTION_ORDER_RELEASED: Hammer,
  PRODUCTION_ORDER_COMPLETED: CheckCircle2,
  PRODUCTION_ORDER_CANCELLED: Ban,
  PRODUCTION_BATCH_LINKED: Flame,
  PRODUCTION_BATCH_UNLINKED: Flame,
};

export function ActivityTimeline({ activities }: { activities: LifecycleActivity[] }) {
  const { t } = useI18n();

  if (activities.length === 0) {
    return <p className="text-xs text-oo-text-muted italic">{t("noActivityYet")}</p>;
  }

  return (
    <ol className="space-y-2">
      {activities.map((a) => {
        const Icon = ACTIVITY_ICON[a.type] ?? Clock;
        const label = ACTIVITY_LABEL_KEYS[a.type] ? t(ACTIVITY_LABEL_KEYS[a.type]) : a.type;
        return (
          <li key={a.id} className="flex gap-2.5 bg-white border border-oo-border-default rounded-oo-medium p-2.5">
            <div className="w-7 h-7 rounded-lg bg-oo-bg-subtle flex items-center justify-center flex-shrink-0">
              <Icon size={14} className="text-oo-text-secondary" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold text-oo-text-primary">{label}</span>
                {a.department && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-oo-action-primary-light text-oo-text-secondary font-semibold">
                    {a.department}
                  </span>
                )}
                <span className="text-[10px] text-oo-text-muted ltr:ml-auto rtl:mr-auto">
                  {a.authorName} — {formatDate(a.createdAt)}
                </span>
              </div>
              {/* Rendered as plain text only — never dangerouslySetInnerHTML. */}
              <p className="text-xs text-oo-text-primary/80 mt-1 whitespace-pre-wrap break-words">{a.message}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ─── Add Note ─────────────────────────────────────────────────────────────────

const NOTE_MAX_LENGTH = 2000;
const DEPARTMENT_OPTIONS: { value: OrderNoteDepartment; labelKey: TranslationKey }[] = [
  { value: "Sales", labelKey: "deptSales" },
  { value: "Online", labelKey: "deptOnline" },
  { value: "Preparation", labelKey: "deptPreparation" },
  { value: "Production", labelKey: "production" },
  { value: "Operations", labelKey: "deptOperations" },
  { value: "Shipping", labelKey: "deptShipping" },
];

export function AddNoteForm({ orderId, onSuccess }: { orderId: string; onSuccess: () => void }) {
  const { t } = useI18n();
  const user = useUser();
  const canPost = hasModuleAccess(user?.permissions ?? {}, "orders");

  const [department, setDepartment] = useState<OrderNoteDepartment>("Operations");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canPost) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // prevent double submission
    const trimmed = message.trim();
    if (!trimmed || trimmed.length > NOTE_MAX_LENGTH) return;

    setSubmitting(true);
    setError(null);
    const result = await submitOrderNote(orderId, department, trimmed);
    setSubmitting(false);
    if (!result.ok) {
      setError(describeApiError(result.error));
      return;
    }
    setMessage("");
    onSuccess();
  }

  const overLimit = message.length > NOTE_MAX_LENGTH;

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold px-3 py-2 rounded-oo-medium">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={department}
          onChange={(e) => setDepartment(e.target.value as OrderNoteDepartment)}
          className="sm:w-44 px-3 py-2 border-2 border-oo-border-default rounded-oo-medium text-sm bg-white focus:border-oo-action-primary focus:ring-2 focus:ring-oo-action-primary/20 outline-none transition-colors"
        >
          {DEPARTMENT_OPTIONS.map((d) => (
            <option key={d.value} value={d.value}>{t(d.labelKey)}</option>
          ))}
        </select>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t("notePlaceholder")}
          rows={2}
          className="flex-1 px-3 py-2 border-2 border-oo-border-default rounded-oo-medium text-sm focus:border-oo-action-primary focus:ring-2 focus:ring-oo-action-primary/20 outline-none transition-colors resize-none"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] font-semibold ${overLimit ? "text-red-600" : "text-oo-text-muted"}`}>
          {message.length}/{NOTE_MAX_LENGTH}
        </span>
        <button
          type="submit"
          disabled={submitting || !message.trim() || overLimit}
          className="flex items-center gap-1.5 px-4 py-2 bg-oo-action-primary text-white rounded-lg text-sm font-bold hover:bg-oo-action-primary-dark disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all duration-200"
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          {t("submitNoteBtn")}
        </button>
      </div>
    </form>
  );
}

// ─── Status Actions ─────────────────────────────────────────────────────────

export function StatusActionsBar({
  orderId,
  status,
  ownerId,
  onSuccess,
  large = false,
}: {
  orderId: string;
  status: string;
  ownerId: string | null;
  onSuccess: () => void;
  /** Larger touch targets — used on the Preparation Workstation page. */
  large?: boolean;
}) {
  const { t } = useI18n();
  const user = useUser();
  const canManageStatus = hasSubPrivilege(user?.permissions ?? {}, "orders", "manage_status");
  const isOwnerOrAdmin = !!user && (user.role === "admin" || (ownerId !== null && ownerId === user.id));

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canManageStatus || !isOwnerOrAdmin) return null;
  if (!canHold(status) && !canResume(status) && !canCancel(status) && !canComplete(status)) return null;

  async function run(action: OrderStatusAction, reason?: string) {
    if (submitting) return; // prevent double submission
    setSubmitting(true);
    setError(null);
    const result = await submitOrderStatusAction(orderId, action, reason);
    setSubmitting(false);
    if (!result.ok) {
      setError(describeApiError(result.error));
      // 409 means our view of the order is stale — refresh so the UI self-heals.
      if (result.error.status === 409) onSuccess();
      return;
    }
    onSuccess();
  }

  function handleHold() {
    const reason = window.prompt(t("holdReasonPrompt"))?.trim();
    if (!reason) {
      if (reason === "") setError(t("reasonRequiredGeneric"));
      return;
    }
    run("hold", reason);
  }

  function handleCancel() {
    if (!window.confirm(t("confirmCancelOrder"))) return;
    const reason = window.prompt(t("cancelReasonPrompt"))?.trim();
    if (!reason) {
      if (reason === "") setError(t("reasonRequiredGeneric"));
      return;
    }
    run("cancel", reason);
  }

  return (
    <div className="space-y-2">
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold px-3 py-2 rounded-oo-medium">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      <div className={`flex gap-2 flex-wrap ${large ? "gap-3" : ""}`}>
        {canHold(status) && (
          <button disabled={submitting} onClick={handleHold}
            className={`flex items-center gap-1.5 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 disabled:opacity-50 active:scale-[0.98] transition-all ${large ? "px-5 py-3.5 text-base font-bold flex-1 min-w-[130px] justify-center" : "px-3 py-2 text-sm"}`}>
            <PauseCircle size={large ? 20 : 15} /> {t("holdOrderBtn")}
          </button>
        )}
        {canResume(status) && (
          <button disabled={submitting} onClick={() => run("resume")}
            className={`flex items-center gap-1.5 text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 active:scale-[0.98] transition-all ${large ? "px-5 py-3.5 text-base font-bold flex-1 min-w-[130px] justify-center" : "px-3 py-2 text-sm"}`}>
            <RotateCcw size={large ? 20 : 15} /> {t("resumeOrderBtn")}
          </button>
        )}
        {canCancel(status) && (
          <button disabled={submitting} onClick={handleCancel}
            className={`flex items-center gap-1.5 text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50 active:scale-[0.98] transition-all ${large ? "px-5 py-3.5 text-base font-bold flex-1 min-w-[130px] justify-center" : "px-3 py-2 text-sm"}`}>
            <Ban size={large ? 20 : 15} /> {t("cancelOrderBtn")}
          </button>
        )}
        {canComplete(status) && (
          <button disabled={submitting} onClick={() => run("complete")}
            className={`flex items-center gap-1.5 text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 disabled:opacity-50 active:scale-[0.98] transition-all ${large ? "px-5 py-3.5 text-base font-bold flex-1 min-w-[130px] justify-center" : "px-3 py-2 text-sm"}`}>
            {submitting ? <Loader2 size={large ? 20 : 15} className="animate-spin" /> : <CheckCircle2 size={large ? 20 : 15} />} {t("completeOrderBtn")}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Preparation Review ───────────────────────────────────────────────────────

// What the reviewer chose, not what the stock says. "" = leave this item out of the
// submission, "auto" = include it and let the shelf decide the split, "Blocked" = the
// one call that is genuinely a human's. The displayed decision and quantities are
// derived from live stock at render time, so they can never drift out of sync.
type Selection = "" | "auto" | "Blocked";
type Draft = Record<string, Selection>;

function buildInitialDraft(items: PreparationOrderItem[]): Draft {
  const draft: Draft = {};
  for (const item of items) {
    draft[item.id] =
      item.preparationDecision === "Blocked" ? "Blocked" : item.preparationDecision ? "auto" : "";
  }
  return draft;
}

const DECISION_OPTIONS: { value: string; labelKey: TranslationKey }[] = [
  { value: "", labelKey: "prepDecisionNotReviewed" },
  { value: "Available on Shelf", labelKey: "prepDecisionShelf" },
  { value: "Needs Production", labelKey: "prepDecisionNeedsProduction" },
  { value: "Partially Available", labelKey: "prepDecisionPartial" },
  { value: "Blocked", labelKey: "prepDecisionBlocked" },
];

// Read-only decision-badge icon/token pairing. The editable <select> this once sat
// beside is gone: the outcome is derived by the server and the only manual exception is
// the Block toggle. "" represents Not Reviewed.
const DECISION_ICON: Record<string, React.ElementType> = {
  "": CircleDashed,
  "Available on Shelf": CheckCircle2,
  "Needs Production": Hammer,
  "Partially Available": CircleDotDashed,
  "Blocked": AlertTriangle,
};

const DECISION_TOKEN: Record<string, { fg: string; bg: string; border: string }> = {
  "":                    { fg: "text-oo-text-muted",       bg: "bg-oo-bg-subtle",           border: "border-oo-border-default" },
  "Available on Shelf":  { fg: "text-oo-status-success",   bg: "bg-oo-status-success-bg",   border: "border-oo-status-success/30" },
  "Needs Production":    { fg: "text-oo-status-waiting",   bg: "bg-oo-status-waiting-bg",   border: "border-oo-status-waiting/30" },
  "Partially Available": { fg: "text-oo-status-preparing", bg: "bg-oo-status-preparing-bg", border: "border-oo-status-preparing/30" },
  "Blocked":             { fg: "text-oo-status-blocked",   bg: "bg-oo-status-blocked-bg",   border: "border-oo-status-blocked/30" },
};

function DecisionBadge({ decision }: { decision: string }) {
  const { t } = useI18n();
  const key = decision || "";
  const Icon = DECISION_ICON[key] ?? CircleDashed;
  const token = DECISION_TOKEN[key] ?? DECISION_TOKEN[""];
  const label = t(DECISION_OPTIONS.find((o) => o.value === key)?.labelKey ?? "prepDecisionNotReviewed");
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${token.fg} ${token.bg} ${token.border}`}>
      <Icon size={13} aria-hidden="true" />
      {label}
    </span>
  );
}

export function PreparationReviewTable({
  orderId,
  items,
  onSuccess,
}: {
  orderId: string;
  items: PreparationOrderItem[];
  onSuccess: () => void;
}) {
  const { t } = useI18n();
  const user = useUser();
  const canEdit = hasSubPrivilege(user?.permissions ?? {}, "orders", "prepare_review");

  // Lazy initializer: runs once per mount. This component is only mounted while its
  // order is expanded/open, so re-fetches triggered by unrelated actions (adding a
  // note, a status change elsewhere) never wipe an in-progress, unsaved review.
  const [draft, setDraft] = useState<Draft>(() => buildInitialDraft(items));
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Live stock picture, one entry per order item. The split between shelf and production
  // is no longer typed by hand — it is read from the server, which is also the only
  // place that can reserve it.
  const [stock, setStock] = useState<Record<string, FulfillmentOptions>>({});
  const [stockLoading, setStockLoading] = useState(true);
  const [stockError, setStockError] = useState<string | null>(null);

  const itemIds = useMemo(() => items.map((i) => i.id).join(","), [items]);

  const loadStock = useCallback(async () => {
    setStockLoading(true);
    const results = await Promise.all(itemIds.split(",").filter(Boolean).map(fetchFulfillmentOptions));
    const next: Record<string, FulfillmentOptions> = {};
    let failed = false;
    for (const r of results) {
      if (r.ok) next[r.data.orderItemId] = r.data;
      else failed = true;
    }
    setStock(next);
    setStockError(failed ? "stock" : null);
    setStockLoading(false);
  }, [itemIds]);

  // Plain fetch-on-mount. The rule fires on every data-loading effect in this codebase
  // (see dashboard/inventory/page.tsx and dashboard/page.tsx); there is no data-fetching
  // library here to move it into, and the state it sets is the fetch result itself.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadStock(); }, [loadStock]);

  function setItemDecision(itemId: string, value: string) {
    setSavedMsg(null);
    // Every non-Blocked, non-empty choice collapses to "auto": the reviewer is saying
    // "include this item", and the shelf works out the split.
    const selection: Selection = value === "Blocked" ? "Blocked" : value === "" ? "" : "auto";
    setDraft((prev) => ({ ...prev, [itemId]: selection }));
  }

  /** The decision and quantities to display for one item, derived from live stock. */
  function viewFor(itemId: string): { decision: string; available: string; required: string } {
    const selection = draft[itemId] ?? "";
    if (selection === "") return { decision: "", available: "", required: "" };
    const s = stock[itemId];
    if (selection === "Blocked") {
      // Blocked releases the shelf and leaves the whole outstanding demand to be produced —
      // which is what the server stores, so show that rather than a misleading zero.
      const demand = s ? roundKg(s.reservedQty + s.outstandingQty) : 0;
      return { decision: "Blocked", available: "0", required: String(demand) };
    }
    if (!s) return { decision: "", available: "", required: "" };
    return {
      decision: derivePreparationDecision(s.outstandingQty, s.coverableFromShelfQty, s.reservedQty),
      available: String(roundKg(s.reservedQty + s.coverableFromShelfQty)),
      required: String(roundKg(s.outstandingQty - s.coverableFromShelfQty)),
    };
  }

  // Every line already carries a stored decision, i.e. this order has been committed at
  // least once. Drives the third column's heading: intention before, ownership after.
  const allCommitted = items.length > 0 && items.every((i) => i.preparationDecision !== null);

  // Every line on the order is in scope. The draft records only the EXCEPTION — a line the
  // reviewer has blocked — because the outcome itself is derived by the server from what
  // the shelf can cover, and there is nothing else for the reviewer to choose.
  //
  // This used to filter to lines carrying a draft selection, which was right when a
  // <select> per row was the thing that populated the draft. That control is gone, so the
  // filter matched nothing on a new order: Commit Allocation could never enable, and had it
  // enabled it would have posted an empty item list. The scope is the order, not the draft.
  const entries = items.map((item) => ({ item, selection: draft[item.id] ?? ("" as Selection) }));

  // Usability-only validation — the backend remains authoritative and re-validates
  // everything server-side regardless of what this allows through. The quantity checks
  // that used to live here are gone: the numbers are no longer typed, so they cannot
  // disagree with each other.
  const blockedWithoutNote = entries.some(
    ({ selection }) => selection === "Blocked" && !note.trim()
  );
  // Refuse to commit an allocation the reviewer cannot see. A row whose stock preview did
  // not load shows no numbers, and committing it would reserve against figures nobody read.
  const missingStock = entries.some(({ item }) => !stock[item.id]);
  const canSave =
    canEdit && entries.length > 0 && !blockedWithoutNote && !stockLoading && !missingStock;

  // What pressing Commit Allocation is expected to do, summarised at order level from the
  // same derived per-item view the table shows. A PREVIEW: these figures are read from the
  // shelf as it was a moment ago and reserve nothing. The server recomputes everything when
  // the commit runs, so the outcome can legitimately differ if another order took stock in
  // between — which is exactly why the caption below says so.
  const commitSummary = useMemo(() => {
    let toReserve = 0, productionNeeded = 0, fullyCovered = 0, blocked = 0;
    for (const item of items) {
      const selection = draft[item.id] ?? "";
      if (selection === "") continue;
      const v = viewFor(item.id);
      if (v.decision === "Blocked") { blocked++; continue; }
      toReserve += Number(v.available || 0);
      productionNeeded += Number(v.required || 0);
      if (v.decision === "Available on Shelf") fullyCovered++;
    }
    return {
      toReserve: roundKg(toReserve),
      productionNeeded: roundKg(productionNeeded),
      fullyCovered,
      blocked,
      // Ready for Shipping only when nothing is blocked and nothing needs producing.
      expectedReady: blocked === 0 && productionNeeded === 0 && fullyCovered > 0,
    };
    // viewFor closes over draft and stock, which are both in the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, draft, stock]);

  async function handleSave() {
    if (submitting || !canSave) return;
    setSubmitting(true);
    setError(null);
    setSavedMsg(null);

    // Only Blocked is asserted. Every other item is sent bare so the server reserves
    // whatever the shelf can cover at the moment it runs — the preview shown here may
    // be seconds old, and another order may have taken the stock in between.
    const payloadItems: PreparationReviewItemInput[] = entries.map(({ item, selection }) =>
      selection === "Blocked"
        ? { orderItemId: item.id, decision: "Blocked" as const }
        : { orderItemId: item.id }
    );

    const result = await submitPreparationReview(orderId, payloadItems, note.trim() || undefined);
    setSubmitting(false);

    if (!result.ok) {
      setError(describeApiError(result.error));
      if (result.error.status === 409) { void loadStock(); onSuccess(); }
      return;
    }

    // Re-sync the reviewer's selection to what the server actually recorded. The
    // quantities need no syncing — they are derived from the stock reload below.
    const byId = new Map(result.data.items.map((i) => [i.id, i]));
    setDraft((prev) => {
      const next: Draft = { ...prev };
      for (const item of items) {
        const fresh = byId.get(item.id);
        if (!fresh) continue;
        next[item.id] =
          fresh.preparationDecision === "Blocked" ? "Blocked" : fresh.preparationDecision ? "auto" : "";
      }
      return next;
    });
    setNote("");
    setSavedMsg(t("prepReviewSaved"));
    void loadStock();
    onSuccess();
  }

  return (
    <div className="space-y-3">
      {!canEdit && (
        <p className="text-xs text-oo-text-muted italic">{t("readOnlyPrepNotice")}</p>
      )}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold px-3 py-2 rounded-oo-medium">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      {savedMsg && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-xs font-semibold px-3 py-2 rounded-oo-medium">
          <CheckCircle2 size={13} /> {savedMsg}
        </div>
      )}

      {/* Order-level outcome BEFORE the lines, per FZ-B: the operator should know what
          pressing Commit will do to the order as a whole before reading every row.
          Everything here is a PREVIEW read from the shelf a moment ago — nothing is
          reserved until the button is pressed, and another order may take the stock in
          between. The two predicted quantities carry dashed borders to say so; the two
          counts are facts about this order and are drawn solid. */}
      {canEdit && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-oo-text-muted uppercase tracking-wide">
              {t("prepSummaryTitle")}
            </span>
            <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-oo-bg-subtle border border-oo-border-default text-oo-text-secondary">
              {t("prepPreviewNotReserved")}
            </span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            {[
              { label: t("prepSummaryToReserve"), value: commitSummary.toReserve,
                tone: "text-oo-action-primary", box: "border-dashed border-oo-action-primary bg-oo-action-primary-subtle" },
              { label: t("prepSummaryProductionNeeded"), value: commitSummary.productionNeeded,
                tone: "text-oo-status-waiting", box: "border-dashed border-oo-status-waiting bg-oo-status-waiting-bg" },
              // Blocked before fully-covered, matching FZ-B: the exception is read before
              // the reassurance.
              { label: t("prepSummaryBlocked"), value: commitSummary.blocked,
                tone: commitSummary.blocked > 0 ? "text-oo-status-blocked" : "text-oo-text-muted",
                box: commitSummary.blocked > 0
                  ? "border-oo-status-blocked bg-oo-status-blocked-bg"
                  : "border-oo-border-default bg-oo-bg-default" },
              { label: t("prepSummaryFullyCovered"), value: commitSummary.fullyCovered,
                tone: "text-oo-status-success", box: "border-oo-status-success bg-oo-status-success-bg" },
            ].map((s) => (
              <div key={s.label} className={`rounded-oo-medium border-2 px-3.5 py-3 flex flex-col gap-1 ${s.box}`}>
                <span className={`text-[11px] font-semibold ${s.tone}`}>{s.label}</span>
                <span className={`text-2xl font-bold tabular-nums leading-none ${s.tone}`}>{s.value}</span>
              </div>
            ))}
          </div>
          <div className="rounded-oo-medium border-[1.5px] border-oo-status-preparing/40 bg-oo-status-preparing-bg px-3.5 py-2.5">
            <p className="text-[13px] font-semibold text-oo-status-preparing">
              {t("prepSummaryExpectedState")}:{" "}
              {commitSummary.expectedReady ? t("orderStatusReadyForShipping") : t("orderStatusPreparing")}
            </p>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm stack-table">
          <thead>
            <tr className="text-xs text-oo-text-secondary">
              <th className="text-start px-2 py-1 font-semibold">{t("beanType")}</th>
              <th className="text-end px-2 py-1 font-semibold">{t("prepColRequired")}</th>
              <th className="text-end px-2 py-1 font-semibold">{t("prepColAvailableNow")}</th>
              {/* Flips once every line has been committed: before the commit this column is
                  an intention ("To Allocate"), after it the quantity genuinely belongs to
                  this order ("Allocated to this Order"). Committed stock is never called
                  "available" — that word is reserved for the shared pool in the column to
                  its left. */}
              <th className="text-end px-2 py-1 font-semibold">
                {allCommitted ? t("allocatedToThisOrder") : t("prepColToAllocate")}
              </th>
              <th className="text-end px-2 py-1 font-semibold">{t("prepColRequiredForProduction")}</th>
              <th className="text-center px-2 py-1 font-semibold">{t("prepColDerivedResult")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {(() => {
              // Backend only stores one note per submission (not per item), so when
              // multiple items are Blocked they all share the single inline field —
              // anchored under the first blocked row, with a caption on the others.
              const blockedIds = items
                .filter((it) => (draft[it.id] ?? "") === "Blocked")
                .map((it) => it.id);
              const noteAnchorId = blockedIds[0] ?? null;

              return items.map((item) => {
                const d = viewFor(item.id);
                const isBlocked = d.decision === "Blocked";
                const s = stock[item.id];
                return (
                  <Fragment key={item.id}>
                    <tr>
                      <td className="px-2 py-1.5" data-label={t("beanType")}>{item.beanTypeName}</td>
                      <td className="px-2 py-1.5 text-end font-medium" data-label={t("prepColRequired")}>{item.quantityKg}</td>
                      <td className="px-2 py-1.5 text-end tabular-nums" data-label={t("prepColAvailableNow")}>
                        {stockLoading && !s ? (
                          <span className="text-oo-text-muted">…</span>
                        ) : s ? (
                          <span className={s.freeToPromiseQty > 0 ? "text-green-600 font-semibold" : "text-oo-text-muted"}>
                            {s.freeToPromiseQty}
                          </span>
                        ) : (
                          <span className="text-oo-text-muted">—</span>
                        )}
                      </td>
                      {/* A committed, unblocked line shows stock this order actually holds,
                          so it is styled as owned rather than as a projection. */}
                      <td className="px-2 py-1.5 text-end tabular-nums" data-label={allCommitted ? t("allocatedToThisOrder") : t("prepColToAllocate")}>
                        <span
                          className={
                            isBlocked
                              ? "text-oo-text-muted"
                              : item.preparationDecision
                                ? "font-bold text-oo-status-ready"
                                : undefined
                          }
                          title={!isBlocked && item.preparationDecision ? t("allocatedToThisOrder") : undefined}
                        >
                          {isBlocked ? "0" : d.available || "0"}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-end tabular-nums" data-label={t("prepColRequiredForProduction")}>
                        <span>{d.required || "0"}</span>
                      </td>
                      {/* Derived Result is read-only: Available / Partially Available /
                          Needs Production are computed by the server from what the shelf can
                          actually cover, never chosen by the operator. The one human
                          exception is blocking the item, which is a button, not an option in
                          a list of outcomes. */}
                      <td className="px-2 py-1.5 text-center stack-action" data-label={t("prepColDerivedResult")}>
                        <div className="flex items-center justify-center gap-2 flex-wrap">
                          <DecisionBadge decision={d.decision} />
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => setItemDecision(item.id, isBlocked ? "auto" : "Blocked")}
                              aria-pressed={isBlocked}
                              className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                                isBlocked
                                  ? "text-oo-text-muted bg-white border-oo-border-default hover:bg-oo-bg-subtle"
                                  : "text-oo-status-blocked bg-oo-status-blocked-bg border-oo-status-blocked/30 hover:bg-oo-status-blocked/10"
                              }`}
                            >
                              {isBlocked ? t("prepUnblockItem") : t("prepBlockItem")}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {canEdit && isBlocked && item.id === noteAnchorId && (
                      <tr>
                        <td colSpan={6} className="px-2 pb-2.5 pt-0.5 bg-oo-status-blocked-bg/40">
                          <div className="flex items-start gap-2">
                            <AlertTriangle size={14} className="text-oo-status-blocked mt-2 flex-shrink-0" aria-hidden="true" />
                            <div className="flex-1 min-w-0">
                              <label htmlFor={`blocked-reason-${orderId}`} className="block text-xs font-bold text-oo-status-blocked mb-1">
                                {t("prepBlockedReasonLabel")} <span aria-hidden="true">*</span>
                              </label>
                              <textarea
                                id={`blocked-reason-${orderId}`}
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder={t("prepBlockedReasonPlaceholder")}
                                rows={2}
                                required
                                aria-required="true"
                                className={`w-full px-3 py-2 border-2 rounded-oo-medium text-sm focus:ring-2 outline-none transition-colors resize-none ${
                                  blockedWithoutNote
                                    ? "border-oo-status-blocked focus:border-oo-status-blocked focus:ring-oo-status-blocked/20"
                                    : "border-oo-border-default focus:border-oo-action-primary focus:ring-oo-action-primary/20"
                                }`}
                              />
                              {blockedWithoutNote && (
                                <p className="text-xs font-bold text-oo-status-blocked mt-1">{t("prepNoteRequiredForBlocked")}</p>
                              )}
                              {blockedIds.length > 1 && (
                                <p className="text-[11px] text-oo-text-muted mt-1">{t("prepBlockedReasonAppliesAll")}</p>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              });
            })()}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <>
          {/* Not while the fetch is still in flight. `missingStock` is trivially true
              before the first response lands, so without this guard every open of an
              already-reviewed order flashes a red "could not load stock" that is simply
              describing the loading state. */}
          {!stockLoading && (stockError || missingStock) && (
            <p className="text-xs font-bold text-red-600">{t("stockPreviewUnavailable")}</p>
          )}
          {/* The summary that used to sit here now renders BEFORE the table, which is
              where FZ-B puts it. Only the action remains below the lines. */}
          <button
            onClick={handleSave}
            disabled={submitting || !canSave}
            className="w-full xl:w-auto flex items-center justify-center gap-1.5 px-4 py-2.5 bg-oo-action-primary text-white rounded-lg text-sm font-bold hover:bg-oo-action-primary-dark disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all duration-200"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <ClipboardList size={14} />}
            {t("commitAllocation")}
          </button>
        </>
      )}
    </div>
  );
}

export function OwnerDisplay({ owner }: { owner: { name: string } | null }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-oo-text-primary">
      <UserCircle2 size={15} className="text-oo-text-muted" />
      {owner ? owner.name : <span className="text-oo-text-muted italic">{t("unassignedOwner")}</span>}
    </span>
  );
}
