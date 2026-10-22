"use client";

import { Select } from "@/components/ui/Select";
import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import { opsDate, countNoun, UNIT_FORMS, Kg } from "@/components/ops/ui";
import { activityTextAr } from "@/components/ops/activity-text";
import { createPortal } from "react-dom";
import { useUser } from "@/app/dashboard/user-context";
import { hasSubPrivilege, canEdit } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import { Dialog } from "@/components/hr/ui";
import type { TranslationKey } from "@/lib/i18n/translations";
import { LocalizedName } from "@/components/LocalizedName";
import {
  describeApiError,
  submitOrderNote,
  submitOrderStatusAction,
  submitOrderOwnerChange,
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
  /** The event's structured fields (GET /api/orders already returns them); N-04 reads them. */
  metadata?: unknown;
};

export type PreparationOrderItem = {
  id: string;
  beanTypeName: string;
  // E7: the coffee product from master data (GET /api/orders, additive). Absent or null on a
  // line without a product — that line keeps showing beanTypeName as stored.
  product?: { productNameEn: string; productNameAr: string | null } | null;
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
// Cancelled vs Rejected is the distinction to protect: Cancelled is NEUTRAL (the muted text
// tone) because the order simply stopped; Rejected is DESTRUCTIVE (status-danger) because it
// failed the approval gate. They must never be merged. Blocked (an item-level decision) shares
// the danger tone and is separated from Rejected by its label and level. Every tone is a
// Direction 2.1 token (components/shell/direction-2.1.css); no colour is written here.

// Direction 2.1 status dot tone per lifecycle status (the label always carries the meaning;
// the tone only reinforces it). Cancelled stays neutral and Rejected destructive, as above.
const ORDER_STATUS_TONE: Record<string, "neutral" | "success" | "info" | "warning" | "danger" | "cancelled"> = {
  "Waiting Approval": "warning",
  "Waiting Preparation Review": "warning",
  "Preparing": "info",
  "Ready for Shipping": "success",
  "Completed": "success",
  "On Hold": "warning",
  "Cancelled": "cancelled",
  "Rejected": "danger",
};


export function OrderStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const labelKey = ORDER_STATUS_LABEL_KEYS[status];
  const tone = ORDER_STATUS_TONE[status] ?? "neutral";
  return (
    <span className={`hr-dot tone-${tone}`} data-status={status}>
      <span>{labelKey ? t(labelKey) : status}</span>
    </span>
  );
}

export function NeedsAttentionBadge() {
  const { t } = useI18n();
  return (
    <span className="hr-flag tone-danger"><span>{t("needsAttention")}</span></span>
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


export function OrderProgressStepper({
  status,
  approvalStatus,
  items,
  where,
}: {
  status: string;
  approvalStatus?: string;
  items: { preparationDecision: string | null }[];
  /**
   * fix/order-progress-ui (owner, 2026-10-22): the stepper is the pane's ONE progress indicator.
   * Under its current step, one small line says where the order is («التجهيز · بانتظار التعبئة»),
   * from the shared status-precedence rule (lib/order-stage orderProgress) — the caller passes it.
   */
  where?: { text: string; tone: "warn" | "danger" | "ok" | "info"; muted?: boolean } | null;
}) {
  const { t } = useI18n();
  const { states, negativeKind } = computeProgressStages({ status, approvalStatus, items });
  const current = states.findIndex((st) => st === "active" || st === "paused" || st === "negative");

  const steps = (
    <ol className="ops-steps" aria-label={t("stepperLabel")}>
      {STEPPER_STAGES.map((stage, i) => {
        const state = states[i];
        // The stage the order is actually sitting at — "active" while work is in
        // progress, "paused" while held. A terminal/negative stage is where the
        // order stopped, so it is the current step too.
        const isCurrent = state === "active" || state === "paused" || state === "negative";
        const cls = state === "complete" ? "is-done" : state === "paused" ? "is-paused" : state === "negative" ? "is-negative" : "";
        return (
          <li key={stage} className={cls} {...(isCurrent ? { "aria-current": "step" as const } : {})}>
            {t(STAGE_LABEL_KEY[stage])}
            <span className="hr-sr">{t(stageStateLabelKey(state, negativeKind))}</span>
          </li>
        );
      })}
    </ol>
  );
  if (!where || current < 0) return steps;
  return (
    <div className="ops-stepwrap" data-testid="order-progress">
      {steps}
      <p className={`ops-steps-where tone-${where.tone}${where.muted ? " is-muted" : ""}`} style={{ gridColumn: `${current + 1} / -1` }} data-testid="order-progress-where">
        {t(STAGE_LABEL_KEY[STEPPER_STAGES[current]])} · {where.text}
      </p>
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
  OWNER_CHANGED: "activityOwnerChanged",
  PRODUCTION_ORDER_CREATED: "activityProductionOrderCreated",
  PRODUCTION_ORDER_RELEASED: "activityProductionOrderReleased",
  PRODUCTION_ORDER_COMPLETED: "activityProductionOrderCompleted",
  PRODUCTION_ORDER_CANCELLED: "activityProductionOrderCancelled",
  PRODUCTION_BATCH_LINKED: "activityProductionBatchLinked",
  PRODUCTION_BATCH_UNLINKED: "activityProductionBatchUnlinked",
  PRODUCTION_SURPLUS_OVERRIDDEN: "activityProductionSurplusOverridden",
  STOCK_RESERVED_FROM_PACKAGING: "activityStockReservedFromPackaging",
  ORDER_ITEMS_EDITED: "activityOrderItemsEdited",
};


/** The department a note or event was filed under, in the viewer's language (stored as its English value). */
function departmentLabel(dept: string, t: (k: TranslationKey) => string): string {
  const opt = DEPARTMENT_OPTIONS.find((o) => o.value === dept);
  return opt ? t(opt.labelKey) : dept;
}

export function ActivityTimeline({ activities }: { activities: LifecycleActivity[] }) {
  const { t, lang } = useI18n();

  if (activities.length === 0) {
    return <p className="hr-caption" style={{ margin: 0 }}>{t("noActivityYet")}</p>;
  }

  const statusLabel = (s: string) => (ORDER_STATUS_LABEL_KEYS[s] ? t(ORDER_STATUS_LABEL_KEYS[s]) : s);
  return (
    <ol className="ops-list ops-activity">
      {activities.map((a) => {
        const label = ACTIVITY_LABEL_KEYS[a.type] ? t(ACTIVITY_LABEL_KEYS[a.type]) : a.type;
        // N-04 (OG-P1 «الجدول الزمني للنشاط»): in Arabic the English server sentence is replaced
        // by the event's details in Arabic, from its structured fields; typed text stays as typed.
        const ar = lang === "ar" ? activityTextAr(a, statusLabel) : null;
        return (
          <li key={a.id} data-activity={a.type}>
            <span style={{ minWidth: 0 }}>
              <strong style={{ fontWeight: 500 }}>
                {label}
                {ar?.ref ? <> <bdi className="ops-serial">{ar.ref}</bdi></> : null}
              </strong>
              {a.department ? <span className="hr-caption"> · {departmentLabel(a.department, t)}</span> : null}
              {/* Rendered as plain text only — never dangerouslySetInnerHTML. */}
              {ar ? (
                ar.userText ? <span className="ops-sub" dir="auto" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{ar.userText}</span> : null
              ) : a.message ? <span className="ops-sub" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{a.message}</span> : null}
              <span className="ops-sub">{ar?.detail ? <>{ar.detail} · </> : null}{a.authorName} · {opsDate(a.createdAt, lang, true)}</span>
            </span>
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

/** Who may add a note to an order: edit access to orders, the same rule as the server. */
export function canAddOrderNote(permissions: Parameters<typeof canEdit>[0]): boolean {
  return canEdit(permissions, "orders");
}

export function AddNoteForm({ orderId, onSuccess }: { orderId: string; onSuccess: () => void }) {
  const { t } = useI18n();
  const user = useUser();
  // DEF-02: POST /api/orders/:id/activities is requireEdit("orders") — a note is a write to the
  // order's permanent history. Module access alone ("view") used to show the form, and the
  // server then refused it with 403. The form follows the server's rule.
  const canPost = canAddOrderNote(user?.permissions ?? {});

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
        <div className="hr-notice tone-danger" role="alert">{error}</div>
      )}
      {/* G-10: visible field labels «القسم» / «الملاحظة» (OG-P1). */}
      <div className="hr-stack" style={{ gap: 8 }}>
        <label className="hr-field" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="hr-label">{t("departmentLabel")}</span>
          <Select
            value={department}
            onChange={(e) => setDepartment(e.target.value as OrderNoteDepartment)}
            className="hr-input"
          >
            {DEPARTMENT_OPTIONS.map((d) => (
              <option key={d.value} value={d.value}>{t(d.labelKey)}</option>
            ))}
          </Select>
        </label>
        <label className="hr-field" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="hr-label">{t("noteFieldLabel")}</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("notePlaceholder")}
            rows={2}
            className="hr-input hr-textarea"
          />
        </label>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span className="hr-caption" style={overLimit ? { color: "var(--status-danger)" } : undefined}>
          {message.length}/{NOTE_MAX_LENGTH}
        </span>
        <button
          type="submit"
          disabled={submitting || !message.trim() || overLimit}
          className="hr-btn is-sm ops-note-submit"
          aria-busy={submitting || undefined}
        >
          {submitting ? "…" : null}
          {t("submitNoteBtn")}
        </button>
      </div>
    </form>
  );
}

// ─── Status Actions ─────────────────────────────────────────────────────────

type ViewerLike = { id: string; role: string; permissions: Parameters<typeof hasSubPrivilege>[0] } | null | undefined;

/** The screen's copy of statusActionAccess (owner-access.ts): the owner, a manager, or the admin role. */
export function canActOnOrderStatus(user: ViewerLike, ownerId: string | null): boolean {
  if (!user) return false;
  if (ownerId !== null && ownerId === user.id && canEdit(user.permissions, "orders")) return true;
  return hasSubPrivilege(user.permissions, "orders", "manage_status") || user.role === "admin";
}

/** The screen's copy of ownerChangeAccess: a manager or the admin role (never the owner alone). */
export function canChangeOrderOwner(user: ViewerLike): boolean {
  return !!user && (hasSubPrivilege(user.permissions, "orders", "manage_status") || user.role === "admin");
}

/**
 * «المسؤول» on the order pane: the owner's name (or «غير معيّن») and, for a manager / the admin
 * role on an open order, «تغيير المسؤول» — a dialog listing the active employees (GET
 * /api/employees, the roster anyone signed in may read). The server decides (PUT
 * /api/orders/[id]/owner); a refusal stays in the dialog with its message.
 */
export function OwnerControl({ orderId, owner, status, onSuccess }: {
  orderId: string;
  owner: { id: string; name: string } | null;
  status: string;
  onSuccess: () => void;
}) {
  const { t } = useI18n();
  const user = useUser();
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<{ id: string; name: string }[] | null>(null);
  const [choice, setChoice] = useState<string>(owner?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminal = status === "Completed" || status === "Cancelled" || status === "Rejected";
  const offer = canChangeOrderOwner(user) && !terminal;

  async function openDialog() {
    setChoice(owner?.id ?? ""); setError(null); setOpen(true);
    if (people) return;
    try {
      const r = await fetch("/api/employees", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const rows = (await r.json()) as { id: string; name: string; active?: boolean }[];
      setPeople(rows.filter((p) => p.active !== false).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      setPeople([]);
    }
  }

  async function save() {
    if (busy) return;
    setBusy(true); setError(null);
    const result = await submitOrderOwnerChange(orderId, choice || null);
    setBusy(false);
    if (!result.ok) { setError(describeApiError(result.error)); return; }
    setOpen(false);
    onSuccess();
  }

  const unchanged = (choice || "") === (owner?.id ?? "");
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} data-testid="order-owner">
      <OwnerDisplay owner={owner} />
      {offer ? (
        <button type="button" className="hr-btn is-sm" onClick={openDialog} data-testid="order-owner-change">{t("changeOwnerBtn")}</button>
      ) : null}
      <Dialog
        open={open}
        title={t("changeOwnerTitle")}
        onClose={() => { if (!busy) setOpen(false); }}
        testId="order-owner-dialog"
        actions={<>
          <button type="button" className="hr-btn is-primary" disabled={busy || unchanged} onClick={save} data-testid="order-owner-save">{t("changeOwnerSave")}</button>
          <button type="button" className="hr-btn" disabled={busy} onClick={() => setOpen(false)}>{t("backBtn")}</button>
        </>}
      >
        {error ? <div className="hr-notice tone-danger" role="alert">{error}</div> : null}
        <p className="hr-caption" style={{ margin: 0 }}>{t("changeOwnerExplain")}</p>
        <label className="hr-field" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="hr-label">{t("changeOwnerLabel")}</span>
          <Select className="hr-select" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={people === null} data-testid="order-owner-select">
            <option value="">{t("changeOwnerNone")}</option>
            {owner && people && !people.some((p) => p.id === owner.id) ? <option value={owner.id}>{owner.name}</option> : null}
            {(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </label>
      </Dialog>
    </span>
  );
}

export function StatusActionsBar({
  orderId,
  status,
  ownerId,
  onSuccess,
  large = false,
  itemIds,
}: {
  orderId: string;
  status: string;
  ownerId: string | null;
  onSuccess: () => void;
  /** Larger touch targets — used on the Preparation Workstation page. */
  large?: boolean;
  /** The order's lines, so the cancel dialog can state the reserved units it releases (G-6). */
  itemIds?: string[];
}) {
  const { t, lang } = useI18n();
  const user = useUser();
  // The server's matrix (services/orders/owner-access.ts), mirrored only to hide what it would
  // refuse: the owner of this order (orders at edit), an orders manager, or the admin role.
  const allowed = canActOnOrderStatus(user, ownerId);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // G-6: hold and cancel ask for their reason in an in-page dialog (no window.prompt/confirm).
  const [ask, setAsk] = useState<null | "hold" | "cancel">(null);
  const [reason, setReason] = useState("");
  const [reserved, setReserved] = useState<number | null>(null);

  if (!allowed) return null;
  if (!canHold(status) && !canResume(status) && !canCancel(status) && !canComplete(status)) return null;

  async function run(action: OrderStatusAction, reason?: string): Promise<boolean> {
    if (submitting) return false; // prevent double submission
    setSubmitting(true);
    setError(null);
    const result = await submitOrderStatusAction(orderId, action, reason);
    setSubmitting(false);
    if (!result.ok) {
      setError(describeApiError(result.error));
      // 409 means our view of the order is stale — refresh so the UI self-heals.
      if (result.error.status === 409) onSuccess();
      return false;
    }
    onSuccess();
    return true;
  }

  function handleHold() { setReason(""); setError(null); setAsk("hold"); }

  async function handleCancel() {
    setReason(""); setError(null); setReserved(null); setAsk("cancel");
    // The reserved units this cancellation releases, read from the line requirements the
    // preparation screen already uses. If any read fails no number is shown (never a guess).
    if (!itemIds || itemIds.length === 0) return;
    try {
      const rows = await Promise.all(itemIds.map(async (id) => {
        const r = await fetch(`/api/order-items/${id}/production-requirement`);
        if (!r.ok) throw new Error("unavailable");
        return (await r.json()) as { reservedUnits?: number };
      }));
      setReserved(rows.reduce((s, x) => s + (x.reservedUnits ?? 0), 0));
    } catch { setReserved(null); }
  }

  async function confirmAsk() {
    const r = reason.trim();
    if (!ask || !r) return;
    // The dialog stays open on a refusal, with the server's message and the reason kept.
    if (await run(ask, r)) setAsk(null);
  }

  return (
    <div className="hr-stack" style={{ gap: 8 }}>
      {error && !ask && (
        <div className="hr-notice tone-danger" role="alert">{error}</div>
      )}
      <Dialog
        open={ask !== null}
        title={ask === "cancel" ? t("cancelOrderTitle") : t("holdOrderTitle")}
        onClose={() => { if (!submitting) setAsk(null); }}
        actions={<>
          <button type="button" className={`hr-btn ${ask === "cancel" ? "is-danger" : "is-primary"}`} disabled={submitting || !reason.trim()} onClick={confirmAsk}>
            {ask === "cancel" ? t("cancelOrderBtnLong") : t("holdOrderBtn")}
          </button>
          <button type="button" className="hr-btn" disabled={submitting} onClick={() => setAsk(null)}>{t("backBtn")}</button>
        </>}
      >
        {error ? <div className="hr-notice tone-danger" role="alert">{error}</div> : null}
        <p className="hr-caption" style={{ margin: 0 }}>
          {ask === "cancel"
            ? <>{t("cancelOrderCantUndo")} {reserved !== null && reserved > 0 ? t("cancelOrderReleases").replace("{units}", countNoun(reserved, lang, UNIT_FORMS)) : t("reasonGoesToTimeline")}</>
            : t("holdOrderExplain")}
        </p>
        <label className="hr-field" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="hr-label">{ask === "cancel" ? t("cancelReasonLabel") : t("holdReasonLabel")} *</span>
          <textarea className="hr-textarea" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-required="true" />
        </label>
      </Dialog>
      <div className="ops-statusbar" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {canHold(status) && (
          <button disabled={submitting} onClick={handleHold}
            className={`hr-btn${large ? "" : " is-sm"}`}>
            {t("holdOrderBtn")}
          </button>
        )}
        {canResume(status) && (
          <button disabled={submitting} onClick={() => run("resume")}
            className={`hr-btn${large ? "" : " is-sm"}`}>
            {t("resumeOrderBtn")}
          </button>
        )}
        {canCancel(status) && (
          <button disabled={submitting} onClick={handleCancel}
            className={`hr-btn is-danger${large ? "" : " is-sm"}`}>
            {t("cancelOrderBtnLong")}
          </button>
        )}
        {canComplete(status) && (
          <button disabled={submitting} onClick={() => run("complete")}
            className={`hr-btn${large ? "" : " is-sm"}`}>
            {submitting ? "…" : null}{t("completeOrderBtn")}
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


const DECISION_TONE: Record<string, "neutral" | "success" | "info" | "warning" | "danger"> = {
  "": "neutral",
  "Available on Shelf": "success",
  "Needs Production": "warning",
  "Partially Available": "info",
  "Blocked": "danger",
};

function DecisionBadge({ decision }: { decision: string }) {
  const { t } = useI18n();
  const key = decision || "";
  const label = t(DECISION_OPTIONS.find((o) => o.value === key)?.labelKey ?? "prepDecisionNotReviewed");
  return (
    <span className={`hr-dot tone-${DECISION_TONE[key] ?? "neutral"}`} data-decision={key || "none"}>
      <span>{label}</span>
    </span>
  );
}

export function PreparationReviewTable({
  orderId,
  items,
  onSuccess,
  commitSlot,
}: {
  orderId: string;
  items: PreparationOrderItem[];
  onSuccess: () => void;
  /** N-03 (OG-P1 / OG-P3): where «تثبيت التخصيص» goes — the preparation pane's pinned footer.
   *  Without it the button stays under the summary (the Orders screen, the phone view). */
  commitSlot?: HTMLElement | null;
}) {
  const { t, lang } = useI18n();
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

  /**
   * N-03: the same four figures in whole units for a SKU line («40 وحدة»), from the unit fields
   * the fulfillment-options route already sends. The arithmetic mirrors viewFor exactly (it is
   * the same picture counted in units instead of its kilogram projection). null = a legacy
   * kilogram line, or the stock picture has not loaded: the kilogram figures are shown.
   */
  function unitViewFor(itemId: string): { required: number; available: number; toAllocate: number; production: number } | null {
    const s = stock[itemId];
    if (!s || !s.isUnitLine) return null;
    const reserved = s.reservedUnits ?? 0, outstanding = s.outstandingUnits ?? 0, coverable = s.coverableFromShelfUnits ?? 0;
    const selection = draft[itemId] ?? "";
    const base = { required: s.orderedUnits ?? reserved + outstanding, available: s.freeToPromiseUnits ?? 0 };
    if (selection === "") return { ...base, toAllocate: 0, production: 0 };
    if (selection === "Blocked") return { ...base, toAllocate: 0, production: reserved + outstanding };
    return { ...base, toAllocate: reserved + coverable, production: Math.max(0, outstanding - coverable) };
  }
  // QA P3: built like <Kg> — the number isolated, the unit beside it — so it reads «24 وحدة» as the frame.
  const unitsText = (n: number) => <span className="ops-kg"><span className="hr-num">{n}</span> {t("unitsLabel")}</span>;

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
    // N-03: the same two totals in units when every counted line is a SKU line («23 وحدة»).
    let unitsToReserve = 0, unitsProduction = 0, allUnits = true;
    for (const item of items) {
      const selection = draft[item.id] ?? "";
      if (selection === "") continue;
      const v = viewFor(item.id);
      if (v.decision === "Blocked") { blocked++; continue; }
      toReserve += Number(v.available || 0);
      productionNeeded += Number(v.required || 0);
      if (v.decision === "Available on Shelf") fullyCovered++;
      const u = unitViewFor(item.id);
      if (u) { unitsToReserve += u.toAllocate; unitsProduction += u.production; } else allUnits = false;
    }
    return {
      units: allUnits ? { toReserve: unitsToReserve, production: unitsProduction } : null,
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
    <div className="hr-stack" style={{ gap: 10 }}>
      {!canEdit && (
        <p className="hr-caption" style={{ margin: 0 }}>{t("readOnlyPrepNotice")}</p>
      )}
      {error && (
        <div className="hr-notice tone-danger" role="alert">{error}</div>
      )}
      {savedMsg && (
        <div className="hr-notice tone-success">{savedMsg}</div>
      )}

      <div className="hr-tablewrap">
        <table className="hr-table is-compact ops-prep">
          <thead>
            <tr>
              <th>{t("beanType")}</th>
              <th className="num">{t("prepColRequired")}</th>
              <th className="num">{t("prepColAvailableNow")}</th>
              {/* Flips once every line has been committed: before the commit this column is
                  an intention ("To Allocate"), after it the quantity genuinely belongs to
                  this order ("Allocated to this Order"). Committed stock is never called
                  "available" — that word is reserved for the shared pool in the column to
                  its left. */}
              <th className="num">
                {allCommitted ? t("allocatedToThisOrder") : t("prepColToAllocate")}
              </th>
              <th className="num">{t("prepColRequiredForProduction")}</th>
              <th>{t("prepColDerivedResult")}</th>
            </tr>
          </thead>
          <tbody>
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
                // N-03: a SKU line counts in units («40 وحدة»); a kilogram line in kg, 2 dp.
                const u = unitViewFor(item.id);
                return (
                  <Fragment key={item.id}>
                    <tr>
                      <td data-label={t("beanType")} data-testid={`prep-product-${item.id}`}>
                        {/* E7: the product's master-data name in the interface language
                            (pickLocalizedName); a line without a product keeps its stored name. */}
                        {item.product ? (
                          <LocalizedName lang={lang} en={item.product.productNameEn} ar={item.product.productNameAr} lastResort={item.beanTypeName} />
                        ) : (
                          <bdi>{item.beanTypeName}</bdi>
                        )}
                      </td>
                      <td className="num" data-label={t("prepColRequired")}>{u ? unitsText(u.required) : <Kg v={item.quantityKg} />}</td>
                      <td className="num" data-label={t("prepColAvailableNow")}>
                        {stockLoading && !s ? (
                          <span className="hr-muted">…</span>
                        ) : s ? (
                          <span className="hr-num" style={s.freeToPromiseQty > 0 ? { color: "var(--status-success)" } : { color: "var(--text-muted)" }}>
                            {u ? u.available : roundKg(s.freeToPromiseQty).toFixed(2)}
                          </span>
                        ) : (
                          <span className="hr-muted">—</span>
                        )}
                      </td>
                      {/* A committed, unblocked line shows stock this order actually holds,
                          so it is styled as owned rather than as a projection. */}
                      <td className="num" data-label={allCommitted ? t("allocatedToThisOrder") : t("prepColToAllocate")}>
                        <span
                          style={
                            isBlocked
                              ? { color: "var(--text-muted)" }
                              : item.preparationDecision
                                ? { color: "var(--status-success)", fontWeight: 600 }
                                : undefined
                          }
                          title={!isBlocked && item.preparationDecision ? t("allocatedToThisOrder") : undefined}
                        >
                          {u ? u.toAllocate : isBlocked ? "0.00" : Number(d.available || 0).toFixed(2)}
                        </span>
                      </td>
                      <td className="num" data-label={t("prepColRequiredForProduction")}>
                        <span className="hr-num">{u ? u.production : Number(d.required || 0).toFixed(2)}</span>
                      </td>
                      {/* Derived Result is read-only: Available / Partially Available /
                          Needs Production are computed by the server from what the shelf can
                          actually cover, never chosen by the operator. The one human
                          exception is blocking the item, which is a button, not an option in
                          a list of outcomes. */}
                      <td data-label={t("prepColDerivedResult")}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <DecisionBadge decision={d.decision} />
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => setItemDecision(item.id, isBlocked ? "auto" : "Blocked")}
                              aria-pressed={isBlocked}
                              className={`hr-btn is-sm${isBlocked ? "" : " is-danger"}`}
                            >
                              {isBlocked ? t("prepUnblockItem") : t("prepBlockItem")}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {canEdit && isBlocked && item.id === noteAnchorId && (
                      <tr>
                        <td colSpan={6}>
                          <div>
                            <div className="hr-field">
                              <label htmlFor={`blocked-reason-${orderId}`} className="hr-label">
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
                                className="hr-input hr-textarea"
                                aria-invalid={blockedWithoutNote || undefined}
                              />
                              {blockedWithoutNote && (
                                <span className="hr-err">{t("prepNoteRequiredForBlocked")}</span>
                              )}
                              {blockedIds.length > 1 && (
                                <span className="hr-help">{t("prepBlockedReasonAppliesAll")}</span>
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
            <p className="hr-err" style={{ margin: 0 }}>{t("stockPreviewUnavailable")}</p>
          )}
          {/* Order-level summary of what committing will do. Everything above is a PREVIEW
              read from the shelf a moment ago: nothing is reserved until this button is
              pressed, and another order may take the stock in between. */}
          <div className="hr-stack" style={{ gap: 6 }}>
            <p className="hr-label" style={{ margin: 0 }}>{t("prepSummaryTitle")}</p>
            <dl className="hr-kv">
              <div><dt>{t("prepSummaryToReserve")}</dt><dd>{commitSummary.units ? unitsText(commitSummary.units.toReserve) : <Kg v={commitSummary.toReserve} />}</dd></div>
              <div><dt>{t("prepSummaryProductionNeeded")}</dt><dd>{commitSummary.units ? unitsText(commitSummary.units.production) : <Kg v={commitSummary.productionNeeded} />}</dd></div>
              <div><dt>{t("prepSummaryFullyCovered")}</dt><dd className="hr-num">{commitSummary.fullyCovered}</dd></div>
              <div><dt>{t("prepSummaryBlocked")}</dt><dd className="hr-num" style={commitSummary.blocked > 0 ? { color: "var(--status-danger)" } : undefined}>{commitSummary.blocked}</dd></div>
              <div><dt>{t("prepSummaryExpectedState")}</dt><dd>{commitSummary.expectedReady ? t("orderStatusReadyForShipping") : t("orderStatusPreparing")}</dd></div>
            </dl>
            <p className="hr-caption" style={{ margin: 0 }}>{t("prepPreviewNotReserved")}</p>
          </div>

          {/* OG-P6: on the phone the commit is a sticky 44 px bar while the review is in view.
              N-03 (OG-P1 / OG-P3): in the 768+ preparation pane it sits in the pinned footer. */}
          {(() => {
            const commit = (
              <div className="ops-commit">
                <button
                  onClick={handleSave}
                  disabled={submitting || !canSave}
                  className="hr-btn is-primary"
                  aria-busy={submitting || undefined}
                >
                  {submitting ? "…" : null}
                  {t("commitAllocation")}
                </button>
              </div>
            );
            return commitSlot ? createPortal(commit, commitSlot) : commit;
          })()}
        </>
      )}
    </div>
  );
}

export function OwnerDisplay({ owner }: { owner: { name: string } | null }) {
  const { t } = useI18n();
  return (
    <span>{owner ? owner.name : <span className="hr-muted">{t("unassignedOwner")}</span>}</span>
  );
}
