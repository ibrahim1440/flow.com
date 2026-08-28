"use client";

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import {
  AlertTriangle, Clock, ClipboardClock, MessageSquare, PauseCircle, RotateCcw, Ban, CheckCircle2,
  ClipboardList, UserCircle2, Loader2, Send, RefreshCw, PackageCheck, XCircle, Hammer,
  CircleDashed, CircleDotDashed, Check,
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

// Icon and color-token pairing per approved status — every status must be
// distinguishable by icon + label, never by color alone. Cancelled and
// Rejected deliberately use different icons AND different tokens (neutral
// gray vs. destructive red) — they must never share a visual treatment.
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
// NOT the Activity Timeline — this shows lifecycle *milestones* (Created → Approved
// → Preparation → Ready for Shipping → Completed), not a log of every event.

const STEPPER_STAGES = ["Created", "Approved", "Preparation", "Ready for Shipping", "Completed"] as const;
type StepperStage = typeof STEPPER_STAGES[number];
// "active"  — a stage with genuine work happening right now (Preparation while
//             Preparing, Ready while Ready for Shipping).
// "pending" — a yes/no gate that hasn't been decided yet (Approved while Waiting
//             Approval). Deliberately styled like an upcoming step, never like
//             "active" or "complete" — nothing is in progress on a gate that
//             hasn't been reached.
type StageState = "complete" | "active" | "pending" | "future" | "paused" | "negative";

const STAGE_LABEL_KEY: Record<StepperStage, TranslationKey> = {
  "Created": "stepperCreated",
  "Approved": "stepperApproved",
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

  // "Approved complete" is only ever asserted from one of two reliable signals:
  // the explicit approvalStatus field when the caller has it, or the state-machine
  // invariant that these statuses are unreachable without prior approval — never a
  // generic guess.
  const APPROVAL_IMPLIED_BY_STATUS = new Set([
    "Waiting Preparation Review", "Preparing", "Ready for Shipping", "Completed", "On Hold",
  ]);
  const isApproved = order.approvalStatus !== undefined
    ? order.approvalStatus === "Yes"
    : APPROVAL_IMPLIED_BY_STATUS.has(order.status);

  if (order.status === "Completed") {
    return { states: STEPPER_STAGES.map(() => "complete") };
  }
  if (order.status === "Rejected") {
    return {
      states: STEPPER_STAGES.map((_, i) => (i === 0 ? "complete" : i === 1 ? "negative" : "future")),
      negativeKind: "rejected",
    };
  }
  if (order.status === "Waiting Approval") {
    return { states: STEPPER_STAGES.map((_, i) => (i === 0 ? "complete" : i === 1 ? "pending" : "future")) };
  }
  if (order.status === "On Hold") {
    // Hold is only reachable from Waiting Preparation Review / Preparing / Ready for
    // Shipping — Approved is therefore always already complete (isApproved is
    // guaranteed true here regardless of which signal was available).
    const base = hasAnyDecision ? (allDecided ? 3 : 2) : 2;
    return { states: STEPPER_STAGES.map((_, i) => (i < base ? "complete" : i === base ? "paused" : "future")) };
  }
  if (order.status === "Cancelled") {
    // Cancel is allowed from almost any non-terminal status, so the "reached" stage
    // is genuinely ambiguous — infer the furthest confirmed milestone from existing
    // data (isApproved, item decisions) rather than fabricating precision.
    const base = hasAnyDecision ? (allDecided ? 3 : 2) : isApproved ? 2 : 1;
    return {
      states: STEPPER_STAGES.map((_, i) => (i < base ? "complete" : i === base ? "negative" : "future")),
      negativeKind: "cancelled",
    };
  }

  const STATUS_BASE: Record<string, number> = {
    "Waiting Preparation Review": 2,
    "Preparing": 2,
    "Ready for Shipping": 3,
  };
  const base = STATUS_BASE[order.status] ?? (hasAnyDecision ? (allDecided ? 3 : 2) : (isApproved ? 2 : 1));
  return { states: STEPPER_STAGES.map((_, i) => (i < base ? "complete" : i === base ? "active" : "future")) };
}

function stageVisual(state: StageState, negativeKind?: "cancelled" | "rejected") {
  switch (state) {
    case "complete":
      return { Icon: Check, fg: "text-oo-status-success", ring: "border-oo-status-success bg-oo-status-success-bg", line: "bg-oo-status-success/40" };
    case "paused":
      return { Icon: PauseCircle, fg: "text-oo-status-hold", ring: "border-oo-status-hold bg-oo-status-hold-bg", line: "bg-oo-border-default" };
    case "negative":
      return negativeKind === "rejected"
        ? { Icon: Ban, fg: "text-oo-status-rejected", ring: "border-oo-status-rejected bg-oo-status-rejected-bg", line: "bg-oo-border-default" }
        : { Icon: XCircle, fg: "text-oo-status-cancelled", ring: "border-oo-status-cancelled bg-oo-status-cancelled-bg", line: "bg-oo-border-default" };
    case "active":
      return { Icon: null, fg: "text-oo-action-primary", ring: "border-oo-action-primary bg-oo-bg-default", line: "bg-oo-border-default" };
    case "pending":
      // Deliberately identical to "future" (hollow, muted ring, no fill/icon) — this
      // is an undecided yes/no gate, not work in progress. Slightly less-muted text
      // than "future" so it still reads as "next up" without implying completion.
      return { Icon: null, fg: "text-oo-text-secondary", ring: "border-oo-border-default bg-oo-bg-subtle", line: "bg-oo-border-default" };
    default: // future
      return { Icon: null, fg: "text-oo-text-muted", ring: "border-oo-border-default bg-oo-bg-subtle", line: "bg-oo-border-default" };
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
  const { t } = useI18n();
  const { states, negativeKind } = computeProgressStages({ status, approvalStatus, items });

  return (
    <div className="flex items-start w-full" role="list" aria-label={t("orderStatusLabel")}>
      {STEPPER_STAGES.map((stage, i) => {
        const state = states[i];
        const visual = stageVisual(state, negativeKind);
        return (
          <div key={stage} role="listitem" className="flex-1 flex flex-col items-center min-w-0">
            <div className="flex items-center w-full">
              <div className={`flex-1 h-0.5 ${i === 0 ? "opacity-0" : visual.line}`} />
              <div className={`flex items-center justify-center w-6 h-6 rounded-full border-2 flex-shrink-0 ${visual.ring}`}>
                {visual.Icon ? (
                  <visual.Icon size={12} className={visual.fg} aria-hidden="true" />
                ) : (
                  <span className={`w-1.5 h-1.5 rounded-full ${state === "active" ? "bg-oo-action-primary" : ""}`} aria-hidden="true" />
                )}
              </div>
              <div className={`flex-1 h-0.5 ${i === STEPPER_STAGES.length - 1 ? "opacity-0" : visual.line}`} />
            </div>
            <span className={`mt-1 text-[11px] font-semibold text-center leading-tight px-0.5 ${visual.fg}`}>
              {t(STAGE_LABEL_KEY[stage])}
            </span>
          </div>
        );
      })}
    </div>
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
};

export function ActivityTimeline({ activities }: { activities: LifecycleActivity[] }) {
  const { t } = useI18n();

  if (activities.length === 0) {
    return <p className="text-xs text-brown/50 italic">{t("noActivityYet")}</p>;
  }

  return (
    <ol className="space-y-2">
      {activities.map((a) => {
        const Icon = ACTIVITY_ICON[a.type] ?? Clock;
        const label = ACTIVITY_LABEL_KEYS[a.type] ? t(ACTIVITY_LABEL_KEYS[a.type]) : a.type;
        return (
          <li key={a.id} className="flex gap-2.5 bg-white border border-border rounded-xl p-2.5">
            <div className="w-7 h-7 rounded-lg bg-cream flex items-center justify-center flex-shrink-0">
              <Icon size={14} className="text-brown" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold text-charcoal">{label}</span>
                {a.department && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-light text-brown font-semibold">
                    {a.department}
                  </span>
                )}
                <span className="text-[10px] text-brown/50 ltr:ml-auto rtl:mr-auto">
                  {a.authorName} — {formatDate(a.createdAt)}
                </span>
              </div>
              {/* Rendered as plain text only — never dangerouslySetInnerHTML. */}
              <p className="text-xs text-charcoal/80 mt-1 whitespace-pre-wrap break-words">{a.message}</p>
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
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold px-3 py-2 rounded-xl">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={department}
          onChange={(e) => setDepartment(e.target.value as OrderNoteDepartment)}
          className="sm:w-44 px-3 py-2 border-2 border-border rounded-xl text-sm bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
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
          className="flex-1 px-3 py-2 border-2 border-border rounded-xl text-sm focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors resize-none"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] font-semibold ${overLimit ? "text-red-600" : "text-brown/40"}`}>
          {message.length}/{NOTE_MAX_LENGTH}
        </span>
        <button
          type="submit"
          disabled={submitting || !message.trim() || overLimit}
          className="flex items-center gap-1.5 px-4 py-2 bg-orange text-white rounded-lg text-sm font-bold hover:bg-orange-dark disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all duration-200"
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
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold px-3 py-2 rounded-xl">
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

// Read-only decision-badge icon/token pairing (Phase A — visual only; the
// editable <select> below is untouched). "" represents Not Reviewed.
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

  const reviewedEntries = items
    .map((item) => ({ item, selection: draft[item.id] ?? ("" as Selection) }))
    .filter(({ selection }) => selection !== "");

  // Usability-only validation — the backend remains authoritative and re-validates
  // everything server-side regardless of what this allows through. The quantity checks
  // that used to live here are gone: the numbers are no longer typed, so they cannot
  // disagree with each other.
  const blockedWithoutNote = reviewedEntries.some(
    ({ selection }) => selection === "Blocked" && !note.trim()
  );
  // A row with no stock data renders as "Not Reviewed" but would still have been sent,
  // silently re-deciding an item the reviewer could not see. Refuse to submit instead.
  const missingStock = reviewedEntries.some(({ item }) => !stock[item.id]);
  const canSave =
    canEdit && reviewedEntries.length > 0 && !blockedWithoutNote && !stockLoading && !missingStock;

  async function handleSave() {
    if (submitting || !canSave) return;
    setSubmitting(true);
    setError(null);
    setSavedMsg(null);

    // Only Blocked is asserted. Every other item is sent bare so the server reserves
    // whatever the shelf can cover at the moment it runs — the preview shown here may
    // be seconds old, and another order may have taken the stock in between.
    const payloadItems: PreparationReviewItemInput[] = reviewedEntries.map(({ item, selection }) =>
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
        <p className="text-xs text-brown/50 italic">{t("readOnlyPrepNotice")}</p>
      )}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs font-semibold px-3 py-2 rounded-xl">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      {savedMsg && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-xs font-semibold px-3 py-2 rounded-xl">
          <CheckCircle2 size={13} /> {savedMsg}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-brown/60">
              <th className="text-start px-2 py-1 font-semibold">{t("beanType")}</th>
              <th className="text-end px-2 py-1 font-semibold">{t("requestedQtyLabel")}</th>
              <th className="text-end px-2 py-1 font-semibold">{t("onShelfFreeLabel")}</th>
              <th className="text-end px-2 py-1 font-semibold">{t("availableQuantityLabel")}</th>
              <th className="text-end px-2 py-1 font-semibold">{t("productionRequiredQuantityLabel")}</th>
              <th className="text-center px-2 py-1 font-semibold">{t("preparationReviewLabel")}</th>
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
                      <td className="px-2 py-1.5">{item.beanTypeName}</td>
                      <td className="px-2 py-1.5 text-end font-medium">{item.quantityKg}</td>
                      <td className="px-2 py-1.5 text-end tabular-nums">
                        {stockLoading && !s ? (
                          <span className="text-brown/40">…</span>
                        ) : s ? (
                          <span className={s.freeToPromiseQty > 0 ? "text-green-600 font-semibold" : "text-brown/40"}>
                            {s.freeToPromiseQty}
                          </span>
                        ) : (
                          <span className="text-brown/40">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-end tabular-nums">
                        <span className={isBlocked ? "text-brown/40" : undefined}>{isBlocked ? "0" : d.available || "0"}</span>
                      </td>
                      <td className="px-2 py-1.5 text-end tabular-nums">
                        <span>{d.required || "0"}</span>
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {canEdit ? (
                          <select
                            value={d.decision}
                            onChange={(e) => setItemDecision(item.id, e.target.value)}
                            className="px-2 py-1.5 border-2 border-border rounded-lg text-xs bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
                          >
                            {DECISION_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                            ))}
                          </select>
                        ) : (
                          <DecisionBadge decision={d.decision} />
                        )}
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
                                className={`w-full px-3 py-2 border-2 rounded-xl text-sm focus:ring-2 outline-none transition-colors resize-none ${
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
          {(stockError || missingStock) && (
            <p className="text-xs font-bold text-red-600">{t("stockPreviewUnavailable")}</p>
          )}
          <button
            onClick={handleSave}
            disabled={submitting || !canSave}
            className="flex items-center gap-1.5 px-4 py-2 bg-orange text-white rounded-lg text-sm font-bold hover:bg-orange-dark disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all duration-200"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <ClipboardList size={14} />}
            {t("savePreparationReview")}
          </button>
        </>
      )}
    </div>
  );
}

export function OwnerDisplay({ owner }: { owner: { name: string } | null }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-charcoal">
      <UserCircle2 size={15} className="text-brown/50" />
      {owner ? owner.name : <span className="text-brown/40 italic">{t("unassignedOwner")}</span>}
    </span>
  );
}
