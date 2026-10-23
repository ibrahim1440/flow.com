/**
 * «إشعارات الحالات» — every place in the system a record has a status the owner may want a
 * WhatsApp message for, and how an automation event says "this record just entered status X".
 *
 * Pure and client-safe: the settings screen draws its groups, recipients and variable chips from
 * this file, the sync (sync.ts) asks it which statuses each source knows of in code, and the
 * dispatcher asks it which statuses an event carries. One definition, so the screen can never
 * offer a recipient or a variable the dispatcher cannot fill.
 *
 * ── Where the statuses come from ──
 * Some lists are owned by the database and change without a deployment: pipeline stages are
 * user-defined (PipelineStage), and order / batch statuses are free strings, so values written by
 * older builds or imports show up too (SELECT DISTINCT). The enum sources (quotation, production
 * order, deal outcome, collection, finance approval) are read from the database's own enum type
 * at sync time, so a value added by a later migration is picked up by the next «تحديث الحالات».
 * `known` below only supplies labels and the statuses that exist before any record does.
 *
 * ── A status that cannot fire ──
 * A status is listed whenever it exists, but a message can only be sent where an event reports a
 * record ENTERING it (`fires`). A quotation is never announced as DRAFT or SUPERSEDED, a
 * production order is only announced when it is raised (PENDING): those rows are listed and
 * marked «لا يُرسل لها» instead of being hidden, so the owner sees the whole list.
 */
import {
  APPROVAL_DECISION_OPTIONS, COLLECTION_STATUS_OPTIONS, DEAL_OUTCOME_OPTIONS, DELIVERY_TYPE_OPTIONS, EVENTS,
  ORDER_PROGRESS_OPTIONS, ORDER_STATUS_OPTIONS, QC_OUTCOME_OPTIONS, QUOTE_STATUS_OPTIONS, getEvent,
  type DynamicRecipient, type EnumOption, type EventDef, type Label, type VarDef,
} from "../catalog";
import { isResume, isSilentEventPayload } from "../order-progress";

/** Who a status notification may go to: the event's own people, or every admin («المالك»). */
export type StatusRecipient = DynamicRecipient | "admins";

export const STATUS_RECIPIENT_LABELS: Record<StatusRecipient, Label> = {
  customer: { ar: "العميل", en: "The customer" },
  order_owner: { ar: "مسؤول الطلب", en: "The order owner" },
  deal_owner: { ar: "المندوب المسؤول", en: "The assigned rep" },
  task_owner: { ar: "صاحب المهمة", en: "The task owner" },
  approver: { ar: "المعتمد", en: "The approver" },
  requester: { ar: "مقدم الطلب", en: "The requester" },
  actor: { ar: "من نفذ الإجراء", en: "Whoever did it" },
  admins: { ar: "المالك / المدير", en: "Owner / admins" },
};

export type StatusSourceKey =
  | "order"
  | "order_progress"
  | "order_delivery"
  | "roast_batch"
  | "production_order"
  | "quote"
  | "deal_stage"
  | "deal_outcome"
  | "collection"
  | "finance_approval";

/** How the sync reads the source's current statuses (sync.ts runs these). */
export type Collector =
  | { kind: "static" }
  | { kind: "distinct"; table: "Order" | "RoastingBatch" | "Delivery"; column: "status" | "deliveryType" }
  | { kind: "enum"; type: "QuoteStatus" | "ProductionOrderStatus" | "OpportunityOutcome" | "SalesCollectionStatus" | "FinApprovalStatus" }
  | { kind: "stages" };

export type StatusSource = Label & {
  key: StatusSourceKey;
  /** One line under the group title. */
  description: Label;
  /** Statuses known in code: their labels, and the ones that exist before any record does. */
  known: EnumOption[];
  collector: Collector;
  /** User-defined (pipeline stages): the list is expected to change from the screen. */
  userDefined: boolean;
  /** Events that can report a record entering one of this source's statuses. */
  events: string[];
  /** Status keys an event can actually report; undefined = every status of the source. */
  fires?: string[];
  recipients: StatusRecipient[];
  /** The message offered when a status is switched on without one. */
  defaultTemplate: string;
  /** A status's own suggested message, when it has one; otherwise `defaultTemplate`. */
  defaultTemplates?: Record<string, string>;
};

const s = (value: string, ar: string, en: string): EnumOption => ({ value, ar, en });

export const STATUS_SOURCES: StatusSource[] = [
  {
    key: "order",
    ar: "حالات الطلب",
    en: "Order statuses",
    description: { ar: "عند انتقال طلب العميل إلى الحالة.", en: "When a customer order moves into the status." },
    known: ORDER_STATUS_OPTIONS,
    collector: { kind: "distinct", table: "Order", column: "status" },
    userDefined: false,
    events: ["order.status_changed"],
    recipients: ["customer", "order_owner", "actor", "admins"],
    defaultTemplate: "مرحبًا {{customer.name}}، طلبكم رقم {{order.number}} أصبح «{{status.name}}».",
  },
  {
    // feat/wa-status-rules: the order-level states that are not a stored Order.status — the owner's
    // labels of 2026-10-22 — announced on the ORDER (never per line), plus the return from a hold.
    // «لم يُسلّم» is where every order starts: nothing enters it, so it is listed and cannot fire.
    key: "order_progress",
    ar: "تقدّم الطلب",
    en: "Order progress",
    description: {
      ar: "حالة الطلب كله في الإنتاج والتسليم، والاستئناف بعد التعليق. رسالة واحدة للطلب، لا لكل صنف.",
      en: "The whole order's production and delivery state, and resuming after a hold. One message per order, not per line.",
    },
    known: ORDER_PROGRESS_OPTIONS,
    collector: { kind: "static" },
    userDefined: false,
    events: ["order.progress_changed", "order.status_changed"],
    fires: ["pending_production", "part_delivered", "resumed"],
    recipients: ["customer", "order_owner", "actor", "admins"],
    defaultTemplate: "مرحبًا {{customer.name}}، طلبكم رقم {{order.number}}: {{status.name}}.",
    defaultTemplates: {
      pending_production: "مرحبًا {{customer.name}}، طلبكم رقم {{order.number}} بانتظار الإنتاج: نحمّص قهوتكم طازجة، وسنخبركم حين يجهز.",
      part_delivered: "مرحبًا {{customer.name}}، سُلِّم جزء من طلبكم رقم {{order.number}}، وسنخبركم عند تسليم الباقي.",
      resumed: "مرحبًا {{customer.name}}، استُؤنف العمل على طلبكم رقم {{order.number}} بعد تعليقه مؤقتاً، وسنخبركم بكل جديد.",
    },
  },
  {
    key: "order_delivery",
    ar: "التسليم",
    en: "Delivery",
    description: { ar: "عند تسجيل تسليم لصنف من الطلب، جزئيًا أو كاملًا.", en: "When a shipment against an order line is recorded." },
    known: DELIVERY_TYPE_OPTIONS,
    collector: { kind: "distinct", table: "Delivery", column: "deliveryType" },
    userDefined: false,
    events: ["delivery.recorded"],
    recipients: ["customer", "order_owner", "actor", "admins"],
    defaultTemplate: "مرحبًا {{customer.name}}، تم تسليم {{delivery.quantity}} من {{delivery.item}} من طلبكم رقم {{order.number}} ({{status.name}}).",
  },
  {
    key: "roast_batch",
    ar: "دفعات التحميص والجودة",
    en: "Roast batches & QC",
    description: { ar: "عند تسجيل دفعة تحميص، ثم نتيجة جودتها، ثم تغليفها.", en: "When a batch is roasted, passed or rejected by QC, then packaged." },
    known: [
      s("Pending QC", "بانتظار الجودة", "Pending QC"),
      ...QC_OUTCOME_OPTIONS,
      s("Packaged", "مغلّفة", "Packaged"),
    ],
    collector: { kind: "distinct", table: "RoastingBatch", column: "status" },
    userDefined: false,
    events: ["production.batch_roasted", "qc.batch_finalized", "packaging.completed"],
    fires: ["Pending QC", "Passed", "Rejected", "Packaged"],
    recipients: ["order_owner", "actor", "admins"],
    defaultTemplate: "الدفعة {{batch.number}} ({{batch.product}}) أصبحت «{{status.name}}».",
  },
  {
    key: "production_order",
    ar: "أوامر الإنتاج",
    en: "Production orders",
    description: { ar: "عند رفع أمر إنتاج لصنف في طلب.", en: "When a production order is raised for an order line." },
    known: [
      s("PENDING", "بانتظار الإنتاج", "Pending"),
      s("IN_PRODUCTION", "قيد الإنتاج", "In production"),
      s("COMPLETED", "مكتمل", "Completed"),
      s("CANCELLED", "ملغى", "Cancelled"),
    ],
    collector: { kind: "enum", type: "ProductionOrderStatus" },
    userDefined: false,
    events: ["production.order_created"],
    fires: ["PENDING"],
    recipients: ["order_owner", "actor", "admins"],
    defaultTemplate: "أمر إنتاج جديد {{production.number}}: {{production.units}} من {{production.sku}} لطلب {{order.number}}.",
  },
  {
    key: "quote",
    ar: "حالات عرض السعر",
    en: "Quotation statuses",
    description: { ar: "عند إصدار عرض السعر أو قبوله أو رفضه أو انتهائه.", en: "When a quotation is issued, accepted, rejected or expires." },
    known: [s("DRAFT", "مسودة", "Draft"), ...QUOTE_STATUS_OPTIONS, s("SUPERSEDED", "مستبدل", "Superseded")],
    collector: { kind: "enum", type: "QuoteStatus" },
    userDefined: false,
    events: ["sales.quote_status_changed"],
    fires: ["ISSUED", "ACCEPTED", "REJECTED", "EXPIRED"],
    recipients: ["customer", "deal_owner", "actor", "admins"],
    defaultTemplate: "مرحبًا {{customer.name}}، عرض السعر {{quote.number}} أصبح «{{status.name}}».",
  },
  {
    key: "deal_stage",
    ar: "مراحل خط المبيعات",
    en: "Pipeline stages",
    description: { ar: "عند نقل صفقة إلى المرحلة. المراحل تُدار من إعدادات المبيعات.", en: "When a deal moves into the stage. Stages are managed in sales settings." },
    known: [],
    collector: { kind: "stages" },
    userDefined: true,
    events: ["sales.deal_stage_changed"],
    recipients: ["customer", "deal_owner", "actor", "admins"],
    defaultTemplate: "الصفقة «{{deal.title}}» انتقلت إلى مرحلة «{{status.name}}».",
  },
  {
    key: "deal_outcome",
    ar: "نتيجة الصفقة",
    en: "Deal outcome",
    description: { ar: "عند كسب صفقة أو خسارتها أو إعادة فتحها.", en: "When a deal is won, lost or reopened." },
    known: DEAL_OUTCOME_OPTIONS,
    collector: { kind: "enum", type: "OpportunityOutcome" },
    userDefined: false,
    events: ["sales.deal_stage_changed"],
    recipients: ["customer", "deal_owner", "actor", "admins"],
    defaultTemplate: "الصفقة «{{deal.title}}» أصبحت «{{status.name}}».",
  },
  {
    key: "collection",
    ar: "التحصيل والدفعات",
    en: "Collections & payments",
    description: { ar: "عند تسجيل تحصيل من العميل، ثم اعتماده أو رفضه أو عكسه.", en: "When a customer payment is recorded, then approved, rejected or reversed." },
    known: COLLECTION_STATUS_OPTIONS,
    collector: { kind: "enum", type: "SalesCollectionStatus" },
    userDefined: false,
    events: ["sales.collection_status_changed"],
    recipients: ["customer", "deal_owner", "actor", "admins"],
    defaultTemplate: "مرحبًا {{customer.name}}، دفعتكم بمبلغ {{collection.amount}} أصبحت «{{status.name}}».",
  },
  {
    key: "finance_approval",
    ar: "طلبات الاعتماد المالي",
    en: "Finance approvals",
    description: { ar: "عند رفع طلب اعتماد مالي ثم صدور قرار عليه.", en: "When a finance request is raised, then decided." },
    known: [s("PENDING", "بانتظار القرار", "Pending"), ...APPROVAL_DECISION_OPTIONS],
    collector: { kind: "enum", type: "FinApprovalStatus" },
    userDefined: false,
    events: ["finance.approval_requested", "finance.approval_decided"],
    recipients: ["requester", "approver", "admins"],
    defaultTemplate: "طلب الاعتماد «{{approval.summary}}» أصبح «{{status.name}}».",
  },
];

const BY_KEY = new Map(STATUS_SOURCES.map((x) => [x.key, x]));

export function getStatusSource(key: string): StatusSource | undefined {
  return BY_KEY.get(key as StatusSourceKey);
}

/** The message the editor suggests for a status switched on without one. */
export function defaultTemplateOf(source: StatusSource, statusKey: string): string {
  return source.defaultTemplates?.[statusKey] ?? source.defaultTemplate;
}

/** Whether an event can ever announce this status. */
export function statusCanFire(source: StatusSource, statusKey: string): boolean {
  return !source.fires || source.fires.includes(statusKey);
}

/** The status's name as the source labels it in code; the key itself when code does not know it. */
export function knownLabel(source: StatusSource, statusKey: string): Label {
  const k = source.known.find((o) => o.value === statusKey);
  return k ? { ar: k.ar, en: k.en } : { ar: statusKey, en: statusKey };
}

// ─── Variables ─────────────────────────────────────────────────────────────────

/** Every status message can name the status it announces. */
export const STATUS_NAME_VAR: VarDef = { key: "status.name", ar: "اسم الحالة", en: "Status name", kind: "text", sample: "جاهز للشحن" };

/**
 * The variables a source's template may use: those EVERY one of its events fills (a roast-batch
 * template must render whether the batch was roasted, judged or packaged), plus «اسم الحالة».
 */
export function sourceVariables(source: StatusSource): VarDef[] {
  const defs = source.events.map((k) => getEvent(k)).filter((e): e is EventDef => !!e);
  if (defs.length === 0) return [STATUS_NAME_VAR];
  const shared = defs[0].variables.filter((v) => defs.every((d) => d.variables.some((x) => x.key === v.key)));
  return [STATUS_NAME_VAR, ...shared];
}

/** The source as an event definition, for template validation and rendering (template.ts). */
export function sourceEventDef(source: StatusSource): EventDef {
  return {
    key: `status:${source.key}`,
    group: "orders",
    ar: source.ar,
    en: source.en,
    description: source.description,
    variables: sourceVariables(source),
    recipients: source.recipients.filter((r): r is DynamicRecipient => r !== "admins"),
  };
}

// ─── Events → statuses ─────────────────────────────────────────────────────────

export type StatusHit = { source: StatusSourceKey; statusKey: string };

const str = (x: unknown) => (typeof x === "string" ? x : x === null || x === undefined ? "" : String(x));

/**
 * The statuses a stored automation event reports a record entering. Pure: reads the event's
 * type and payload only (the payload is written at the hook point, in the same transaction).
 */
export function statusesOfEvent(eventType: string, payload: unknown): StatusHit[] {
  // The one-time recompute corrects statuses that were already true: never a message.
  if (isSilentEventPayload(payload)) return [];
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const hit = (source: StatusSourceKey, key: unknown): StatusHit[] => (str(key) ? [{ source, statusKey: str(key) }] : []);
  switch (eventType) {
    case "order.status_changed":
      if (str(p.from) === str(p.to)) return [];
      return [...hit("order", p.to), ...(isResume(p.from, p.to) ? hit("order_progress", "resumed") : [])];
    case "order.progress_changed":
      return str(p.from) === str(p.to) ? [] : hit("order_progress", p.to);
    case "delivery.recorded":
      return hit("order_delivery", p.deliveryType);
    case "production.batch_roasted":
      return hit("roast_batch", "Pending QC");
    case "qc.batch_finalized":
      return hit("roast_batch", p.outcome);
    case "packaging.completed":
      return hit("roast_batch", "Packaged");
    case "production.order_created":
      return hit("production_order", "PENDING");
    case "sales.quote_status_changed":
      return hit("quote", p.to);
    case "sales.deal_stage_changed": {
      const out: StatusHit[] = [];
      if (str(p.toStageCode) && str(p.fromStageId) !== str(p.toStageId)) out.push(...hit("deal_stage", p.toStageCode));
      if (str(p.toOutcome) && str(p.fromOutcome) !== str(p.toOutcome)) out.push(...hit("deal_outcome", p.toOutcome));
      return out;
    }
    case "sales.collection_status_changed":
      return hit("collection", p.to);
    case "finance.approval_requested":
      return hit("finance_approval", "PENDING");
    case "finance.approval_decided":
      return hit("finance_approval", p.decision);
    default:
      return [];
  }
}

/** The automation events that must be written while any rule of these sources is switched on. */
export function eventTypesOfSources(sources: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const k of sources) for (const e of getStatusSource(k)?.events ?? []) out.add(e);
  return [...out];
}

/** Every catalogued event a source names exists (tests/automation/status-rules.test.ts). */
export const SOURCE_EVENT_KEYS: readonly string[] = [...new Set(STATUS_SOURCES.flatMap((x) => x.events))];
export const CATALOGUE_EVENT_KEYS: readonly string[] = EVENTS.map((e) => e.key);
