/**
 * The automation event catalogue — every event a rule can start from, what it knows, and
 * who it can message.
 *
 * Pure and client-safe: the rule editor reads it to draw the event picker, the variable
 * chips and the condition builder, and the server reads the same object to validate a rule
 * and to render a message. One definition, so the editor can never offer a variable the
 * dispatcher does not fill.
 *
 * ── Adding an event ──
 *   1. Describe it here.
 *   2. Call emitAutomationEvent() in the same transaction as the change it describes.
 *   3. Teach src/lib/automation/context.ts to read its variables and recipients.
 * The catalogue test (tests/automation/catalog.test.ts) refuses an event whose variables
 * or recipients are not resolved.
 */

export type Lang = "ar" | "en";
export type Label = { ar: string; en: string };

export type EnumOption = Label & { value: string };

export type VarKind = "text" | "number" | "enum";

export type VarDef = Label & {
  /** What goes between the braces: {{order.number}}. */
  key: string;
  kind: VarKind;
  /** Shown in the editor's live preview. */
  sample: string;
  /** For enums: the stored code is compared in conditions, the label is written in messages. */
  options?: EnumOption[];
};

/** Recipients an event can resolve on its own. "employee" and "phone" are always offered. */
export type DynamicRecipient =
  | "customer"
  | "order_owner"
  | "deal_owner"
  | "task_owner"
  | "approver"
  | "requester"
  | "actor";

export type RecipientKind = DynamicRecipient | "employee" | "phone";

export type EventGroup = "orders" | "operations" | "sales" | "finance";

export type EventDef = Label & {
  key: string;
  group: EventGroup;
  description: Label;
  variables: VarDef[];
  recipients: DynamicRecipient[];
};

// ─── Enumerations ──────────────────────────────────────────────────────────────

export const ORDER_STATUS_OPTIONS: EnumOption[] = [
  { value: "Waiting Approval", ar: "بانتظار الموافقة", en: "Waiting Approval" },
  { value: "Waiting Preparation Review", ar: "بانتظار مراجعة التجهيز", en: "Waiting Preparation Review" },
  { value: "Preparing", ar: "قيد التجهيز", en: "Preparing" },
  { value: "Ready for Shipping", ar: "جاهز للشحن", en: "Ready for Shipping" },
  { value: "Completed", ar: "مكتمل", en: "Completed" },
  { value: "On Hold", ar: "معلّق مؤقتاً", en: "On Hold" },
  { value: "Cancelled", ar: "ملغى", en: "Cancelled" },
  { value: "Rejected", ar: "مرفوض", en: "Rejected" },
];

const YES_NO: EnumOption[] = [
  { value: "yes", ar: "نعم", en: "Yes" },
  { value: "no", ar: "لا", en: "No" },
];

export const DELIVERY_TYPE_OPTIONS: EnumOption[] = [
  { value: "full", ar: "كامل", en: "Full" },
  { value: "partial", ar: "جزئي", en: "Partial" },
];

/**
 * Where an order stands as a whole, beyond its stored status (feat/wa-status-rules): the order-level
 * production and delivery states the owner named (fix/status-labels, 2026-10-22) and the return
 * from a hold. Announced on the ORDER, never per line, by `order.progress_changed` (and, for
 * «استُؤنف», by `order.status_changed` leaving «معلّق مؤقتاً»).
 */
export const ORDER_PROGRESS_OPTIONS: EnumOption[] = [
  { value: "pending_production", ar: "بانتظار الإنتاج", en: "Awaiting production" },
  { value: "not_delivered", ar: "لم يُسلّم", en: "Not delivered" },
  { value: "part_delivered", ar: "سُلِّم جزئياً", en: "Partially delivered" },
  { value: "resumed", ar: "استُؤنف الطلب", en: "Resumed" },
];

export const QC_OUTCOME_OPTIONS: EnumOption[] = [
  { value: "Passed", ar: "ناجح", en: "Passed" },
  { value: "Rejected", ar: "مرفوض", en: "Rejected" },
];

export const QUOTE_STATUS_OPTIONS: EnumOption[] = [
  { value: "ISSUED", ar: "صدر", en: "Issued" },
  { value: "ACCEPTED", ar: "مقبول", en: "Accepted" },
  { value: "REJECTED", ar: "مرفوض", en: "Rejected" },
  { value: "EXPIRED", ar: "منتهي", en: "Expired" },
];

export const DEAL_OUTCOME_OPTIONS: EnumOption[] = [
  { value: "OPEN", ar: "مفتوحة", en: "Open" },
  { value: "WON", ar: "مكسوبة", en: "Won" },
  { value: "LOST", ar: "خاسرة", en: "Lost" },
];

export const COLLECTION_STATUS_OPTIONS: EnumOption[] = [
  { value: "PENDING_VERIFICATION", ar: "بانتظار التحقق", en: "Awaiting verification" },
  { value: "APPROVED", ar: "معتمد", en: "Approved" },
  { value: "REJECTED", ar: "مرفوض", en: "Rejected" },
  { value: "REVERSED", ar: "معكوس", en: "Reversed" },
];

/** Sales invoicing A2: the document kinds an «invoice issued» event names. */
export const INVOICE_KIND_OPTIONS: EnumOption[] = [
  { value: "INVOICE", ar: "فاتورة ضريبية", en: "Tax invoice" },
  { value: "CREDIT_NOTE", ar: "إشعار دائن", en: "Credit note" },
  { value: "DEBIT_NOTE", ar: "إشعار مدين", en: "Debit note" },
];

const APPROVAL_TYPE_OPTIONS: EnumOption[] = [
  { value: "BUDGET_APPROVAL", ar: "اعتماد ميزانية", en: "Budget approval" },
  { value: "ALLOCATION_RULES", ar: "قواعد التوزيع", en: "Allocation rules" },
  { value: "CATEGORY_TRANSFER", ar: "تحويل بين البنود", en: "Category transfer" },
  { value: "SPEND_OVERRIDE", ar: "تجاوز حد الصرف", en: "Spend override" },
  { value: "PERIOD_REOPEN", ar: "إعادة فتح فترة", en: "Period reopen" },
];

export const APPROVAL_DECISION_OPTIONS: EnumOption[] = [
  { value: "APPROVED", ar: "معتمد", en: "Approved" },
  { value: "REJECTED", ar: "مرفوض", en: "Rejected" },
  { value: "CANCELLED", ar: "مسحوب", en: "Withdrawn" },
];

// ─── Variable sets ─────────────────────────────────────────────────────────────

const v = (key: string, ar: string, en: string, sample: string, kind: VarKind = "text", options?: EnumOption[]): VarDef =>
  ({ key, ar, en, sample, kind, ...(options ? { options } : {}) });

const COMMON_VARS: VarDef[] = [
  v("event.time", "وقت الحدث", "Event time", "2026-10-06 14:30"),
  v("actor.name", "من نفذ الإجراء", "Done by", "مشرف الفرع"),
];

const ORDER_VARS: VarDef[] = [
  v("order.number", "رقم الطلب", "Order number", "1042", "number"),
  v("order.status", "حالة الطلب الحالية", "Current order status", "Ready for Shipping", "enum", ORDER_STATUS_OPTIONS),
  v("order.items", "أصناف الطلب", "Order items", "2 × إثيوبيا 250g، 1 × كولومبيا 1kg"),
  v("order.itemCount", "عدد الأصناف", "Number of lines", "2", "number"),
  v("customer.name", "اسم العميل", "Customer name", "مقهى الركن"),
  v("customer.phone", "جوال العميل", "Customer phone", "966500000000"),
  v("owner.name", "مسؤول الطلب", "Order owner", "مسؤول الطلبات"),
];

const BATCH_VARS: VarDef[] = [
  v("batch.number", "رقم الدفعة", "Batch number", "2026100601"),
  v("batch.product", "المنتج", "Product", "إثيوبيا يرغاتشيفي"),
  v("batch.greenKg", "البن الأخضر (كغ)", "Green coffee (kg)", "12", "number"),
  v("batch.toStock", "تحميص للمخزون", "Roasted to stock", "no", "enum", YES_NO),
  v("order.number", "رقم الطلب", "Order number", "1042", "number"),
  v("customer.name", "اسم العميل", "Customer name", "مقهى الركن"),
  v("owner.name", "مسؤول الطلب", "Order owner", "مسؤول الطلبات"),
];

// ─── The catalogue ─────────────────────────────────────────────────────────────

export const EVENTS: EventDef[] = [
  // ── Orders and delivery ──
  {
    key: "order.created",
    group: "orders",
    ar: "إنشاء طلب جديد",
    en: "Order created",
    description: { ar: "عند تسجيل طلب جديد لعميل.", en: "When a new customer order is recorded." },
    variables: [...ORDER_VARS, ...COMMON_VARS],
    recipients: ["customer", "actor"],
  },
  {
    key: "order.status_changed",
    group: "orders",
    ar: "تغيرت حالة الطلب",
    en: "Order status changed",
    description: {
      ar: "عند انتقال الطلب لحالة جديدة: قيد التجهيز، جاهز للشحن، معلّق مؤقتاً، ملغى، مكتمل... استعمل الشرط لتحديد الحالة.",
      en: "When an order moves to a new status. Use a condition to pick which status.",
    },
    variables: [
      v("status.from", "الحالة السابقة", "Previous status", "Preparing", "enum", ORDER_STATUS_OPTIONS),
      v("status.to", "الحالة الجديدة", "New status", "Ready for Shipping", "enum", ORDER_STATUS_OPTIONS),
      v("status.reason", "السبب", "Reason", "طلب العميل التأجيل"),
      ...ORDER_VARS,
      ...COMMON_VARS,
    ],
    recipients: ["customer", "order_owner", "actor"],
  },
  {
    key: "order.progress_changed",
    group: "orders",
    ar: "تقدّم الطلب",
    en: "Order progress",
    description: {
      ar: "عند انتقال الطلب كله إلى «بانتظار الإنتاج» أو «سُلِّم جزئياً»، مرة لكل انتقال وليس لكل صنف.",
      en: "When the whole order becomes «awaiting production» or «partially delivered»: once per transition, not per line.",
    },
    variables: [
      v("progress.from", "الحالة السابقة", "Previous state", "not_delivered", "enum", ORDER_PROGRESS_OPTIONS),
      v("progress.to", "الحالة الجديدة", "New state", "part_delivered", "enum", ORDER_PROGRESS_OPTIONS),
      ...ORDER_VARS,
      ...COMMON_VARS,
    ],
    recipients: ["customer", "order_owner", "actor"],
  },
  {
    key: "delivery.recorded",
    group: "orders",
    ar: "تسجيل تسليم",
    en: "Delivery recorded",
    description: { ar: "عند تسجيل شحنة أو تسليم لصنف من الطلب، جزئيا أو كاملا.", en: "When a shipment against an order line is recorded." },
    variables: [
      v("delivery.item", "الصنف المسلم", "Item delivered", "إثيوبيا 250g"),
      v("delivery.quantity", "الكمية المسلمة", "Quantity delivered", "10 وحدات"),
      v("delivery.type", "نوع التسليم", "Delivery type", "partial", "enum", DELIVERY_TYPE_OPTIONS),
      v("delivery.notes", "ملاحظات التسليم", "Delivery notes", ""),
      // Phase D (additive): the lots the server drew the delivery from, by batch number.
      v("delivery.lots", "لوتات التسليم", "Lots delivered", "R-2610-03، R-2610-05"),
      v("order.fullyDelivered", "اكتمل تسليم الطلب كله", "Whole order delivered", "no", "enum", YES_NO),
      ...ORDER_VARS,
      ...COMMON_VARS,
    ],
    recipients: ["customer", "order_owner", "actor"],
  },

  // ── Internal operations ──
  {
    key: "production.batch_roasted",
    group: "operations",
    ar: "تحميص دفعة",
    en: "Batch roasted",
    description: { ar: "عند تسجيل دفعة تحميص جديدة، لطلب أو للمخزون.", en: "When a roasting batch is recorded, for an order or for stock." },
    variables: [...BATCH_VARS, ...COMMON_VARS],
    recipients: ["order_owner", "actor"],
  },
  {
    key: "qc.batch_finalized",
    group: "operations",
    ar: "نتيجة الجودة",
    en: "QC decision",
    description: { ar: "عند اعتماد نتيجة الجودة لدفعة: ناجحة أو مرفوضة.", en: "When a batch is passed or rejected by QC." },
    variables: [
      v("qc.outcome", "النتيجة", "Outcome", "Passed", "enum", QC_OUTCOME_OPTIONS),
      v("qc.reason", "سبب القرار", "Decision reason", ""),
      ...BATCH_VARS,
      ...COMMON_VARS,
    ],
    recipients: ["order_owner", "actor"],
  },
  {
    key: "qc.guest_invited",
    group: "operations",
    ar: "دعوة مقيّم ضيف",
    en: "Guest evaluator invited",
    description: { ar: "عند دعوة مقيّم من خارج العمل لتقييم دفعة، حاضرًا أو برابط.", en: "When a guest evaluator is invited to a batch's QC panel, present or by link." },
    variables: [
      v("guest.name", "اسم الضيف", "Guest name", "أبو فهد"),
      v("guest.channel", "طريقة الدعوة", "Invitation", "LINK", "enum", [
        { value: "PRESENT", ar: "حاضر", en: "Present" },
        { value: "LINK", ar: "برابط", en: "By link" },
      ]),
      ...BATCH_VARS,
      ...COMMON_VARS,
    ],
    recipients: ["actor"],
  },
  {
    key: "packaging.completed",
    group: "operations",
    ar: "تغليف دفعة",
    en: "Batch packaged",
    description: { ar: "عند تسجيل عملية تغليف من دفعة.", en: "When packages are filled from a batch." },
    variables: [
      v("pack.units", "عدد العبوات الكاملة", "Complete packages", "40", "number"),
      v("pack.partialUnits", "عدد العبوات الناقصة", "Partial packages", "1", "number"),
      v("pack.reservedUnits", "المحجوز للطلب", "Reserved to the order", "40", "number"),
      ...BATCH_VARS,
      ...COMMON_VARS,
    ],
    recipients: ["order_owner", "actor"],
  },
  {
    key: "production.order_created",
    group: "operations",
    ar: "أمر إنتاج جديد",
    en: "Production order raised",
    description: { ar: "عند رفع أمر إنتاج لصنف في طلب.", en: "When a production order is raised for an order line." },
    variables: [
      v("production.number", "رقم أمر الإنتاج", "Production number", "PRD-2026-0042"),
      v("production.sku", "الصنف", "SKU", "ETH-250"),
      v("production.units", "عدد الوحدات", "Units", "40", "number"),
      v("production.greenKg", "البن الأخضر المتوقع (كغ)", "Expected green coffee (kg)", "12", "number"),
      v("order.number", "رقم الطلب", "Order number", "1042", "number"),
      v("customer.name", "اسم العميل", "Customer name", "مقهى الركن"),
      v("owner.name", "مسؤول الطلب", "Order owner", "مسؤول الطلبات"),
      ...COMMON_VARS,
    ],
    recipients: ["order_owner", "actor"],
  },

  // ── Sales ──
  {
    key: "sales.quote_status_changed",
    group: "sales",
    ar: "تغيرت حالة عرض السعر",
    en: "Quotation status changed",
    description: { ar: "عند إصدار عرض سعر، أو قبوله، أو رفضه، أو انتهائه.", en: "When a quotation is issued, accepted, rejected or expires." },
    variables: [
      v("quote.number", "رقم العرض", "Quotation number", "Q-202610-0007"),
      v("quote.status", "حالة العرض", "Quotation status", "ISSUED", "enum", QUOTE_STATUS_OPTIONS),
      v("quote.total", "إجمالي العرض", "Quotation total", "1,552.50 SAR"),
      v("quote.validUntil", "صالح حتى", "Valid until", "2026-10-20"),
      v("quote.reason", "سبب الرفض", "Rejection reason", ""),
      v("deal.title", "الصفقة", "Deal", "توريد شهري"),
      v("customer.name", "اسم العميل", "Customer name", "مقهى الركن"),
      v("owner.name", "مسؤول الصفقة", "Deal owner", "مندوب المبيعات"),
      ...COMMON_VARS,
    ],
    recipients: ["customer", "deal_owner", "actor"],
  },
  {
    key: "sales.deal_stage_changed",
    group: "sales",
    ar: "انتقلت الصفقة لمرحلة",
    en: "Deal moved",
    description: {
      ar: "عند نقل صفقة إلى مرحلة أخرى في خط المبيعات، أو كسبها، أو خسارتها، أو إعادة فتحها.",
      en: "When a deal moves to another pipeline stage, or is won, lost or reopened.",
    },
    variables: [
      v("deal.title", "الصفقة", "Deal", "توريد شهري"),
      v("stage.from", "المرحلة السابقة", "Previous stage", "تأهيل"),
      v("stage.to", "المرحلة الجديدة", "New stage", "عرض سعر"),
      v("deal.outcome", "نتيجة الصفقة", "Deal outcome", "OPEN", "enum", DEAL_OUTCOME_OPTIONS),
      v("deal.value", "قيمة الصفقة", "Deal value", "12,500.00 SAR"),
      v("customer.name", "اسم العميل", "Customer name", "مقهى الركن"),
      v("owner.name", "مسؤول الصفقة", "Deal owner", "مندوب المبيعات"),
      ...COMMON_VARS,
    ],
    recipients: ["customer", "deal_owner", "actor"],
  },
  {
    key: "sales.collection_status_changed",
    group: "sales",
    ar: "تغيرت حالة التحصيل",
    en: "Collection status changed",
    description: {
      ar: "عند تسجيل تحصيل جديد بانتظار التحقق، أو اعتماده، أو رفضه، أو عكسه.",
      en: "When a collection is recorded for verification, approved, rejected or reversed.",
    },
    variables: [
      v("collection.status", "حالة التحصيل", "Collection status", "APPROVED", "enum", COLLECTION_STATUS_OPTIONS),
      v("collection.amount", "المبلغ المحصل", "Amount collected", "5,000.00 SAR"),
      v("collection.reference", "رقم المرجع", "Reference", "TRX-0042"),
      v("deal.title", "الصفقة", "Deal", "توريد شهري"),
      v("customer.name", "اسم العميل", "Customer name", "مقهى الركن"),
      v("owner.name", "مسؤول الصفقة", "Deal owner", "مندوب المبيعات"),
      ...COMMON_VARS,
    ],
    recipients: ["customer", "deal_owner", "actor"],
  },
  {
    // Sales invoicing A2 (20261103090000_sales_invoicing): a tax invoice / credit / debit note was issued.
    key: "sales.invoice_status_changed",
    group: "sales",
    ar: "صدرت فاتورة",
    en: "Invoice issued",
    description: {
      ar: "عند إصدار فاتورة ضريبية أو إشعار دائن أو مدين لعميل.",
      en: "When a tax invoice, credit note or debit note is issued to a customer.",
    },
    variables: [
      v("invoice.number", "رقم المستند", "Document number", "INV-000123"),
      v("invoice.kind", "نوع المستند", "Document kind", "INVOICE", "enum", INVOICE_KIND_OPTIONS),
      v("invoice.total", "الإجمالي شامل الضريبة", "Total incl. VAT", "22,862.00 SAR"),
      v("invoice.dueDate", "تاريخ الاستحقاق", "Due date", "2026-11-30"),
      v("order.number", "رقم الطلب", "Order number", "1042"),
      v("customer.name", "اسم العميل", "Customer name", "مقهى الركن"),
      ...COMMON_VARS,
    ],
    recipients: ["customer", "order_owner", "actor"],
  },
  {
    key: "sales.task_due",
    group: "sales",
    ar: "حان موعد مهمة متابعة",
    en: "Follow-up task due",
    description: { ar: "عند حلول موعد مهمة متابعة لم تنجز بعد.", en: "When an open follow-up task falls due." },
    variables: [
      v("task.subject", "المهمة", "Task", "الاتصال لتأكيد الطلبية"),
      v("task.dueAt", "موعد المهمة", "Due at", "2026-10-06 10:00"),
      v("task.related", "مرتبطة بـ", "Related to", "مقهى الركن"),
      v("owner.name", "صاحب المهمة", "Task owner", "مندوب المبيعات"),
      v("event.time", "وقت الحدث", "Event time", "2026-10-06 10:00"),
    ],
    recipients: ["task_owner"],
  },

  // ── Finance ──
  {
    key: "finance.approval_requested",
    group: "finance",
    ar: "طلب اعتماد جديد",
    en: "Approval requested",
    description: { ar: "عند رفع طلب اعتماد مالي ينتظر قرارا.", en: "When a finance request is raised for approval." },
    variables: [
      v("approval.type", "نوع الطلب", "Request type", "SPEND_OVERRIDE", "enum", APPROVAL_TYPE_OPTIONS),
      v("approval.summary", "ملخص الطلب", "Summary", "صرف 5,000 من بند التسويق"),
      v("approval.reason", "سبب الطلب", "Reason", ""),
      v("approval.requester", "مقدم الطلب", "Requested by", "محاسب الفرع"),
      ...COMMON_VARS,
    ],
    recipients: ["approver", "requester"],
  },
  {
    key: "finance.approval_decided",
    group: "finance",
    ar: "صدر قرار على طلب اعتماد",
    en: "Approval decided",
    description: { ar: "عند اعتماد طلب مالي، أو رفضه، أو سحبه.", en: "When a finance request is approved, rejected or withdrawn." },
    variables: [
      v("approval.type", "نوع الطلب", "Request type", "SPEND_OVERRIDE", "enum", APPROVAL_TYPE_OPTIONS),
      v("approval.summary", "ملخص الطلب", "Summary", "صرف 5,000 من بند التسويق"),
      v("approval.decision", "القرار", "Decision", "APPROVED", "enum", APPROVAL_DECISION_OPTIONS),
      v("approval.note", "ملاحظة القرار", "Decision note", ""),
      v("approval.requester", "مقدم الطلب", "Requested by", "محاسب الفرع"),
      ...COMMON_VARS,
    ],
    recipients: ["requester", "approver"],
  },
];

export const EVENT_GROUPS: (Label & { key: EventGroup })[] = [
  { key: "orders", ar: "الطلبات والتسليم", en: "Orders & delivery" },
  { key: "operations", ar: "التشغيل الداخلي", en: "Operations" },
  { key: "sales", ar: "المبيعات", en: "Sales" },
  { key: "finance", ar: "المالية", en: "Finance" },
];

export const RECIPIENT_LABELS: Record<RecipientKind, Label> = {
  customer: { ar: "العميل", en: "The customer" },
  order_owner: { ar: "مسؤول الطلب", en: "The order owner" },
  deal_owner: { ar: "مسؤول الصفقة", en: "The deal owner" },
  task_owner: { ar: "صاحب المهمة", en: "The task owner" },
  approver: { ar: "المعتمد", en: "The approver" },
  requester: { ar: "مقدم الطلب", en: "The requester" },
  actor: { ar: "من نفذ الإجراء", en: "Whoever did it" },
  employee: { ar: "موظف محدد", en: "A specific employee" },
  phone: { ar: "رقم ثابت", en: "A fixed number" },
};

const BY_KEY = new Map(EVENTS.map((e) => [e.key, e]));

export function getEvent(key: string): EventDef | undefined {
  return BY_KEY.get(key);
}

export function isEventType(key: unknown): key is string {
  return typeof key === "string" && BY_KEY.has(key);
}

export function getVariable(event: EventDef, key: string): VarDef | undefined {
  return event.variables.find((x) => x.key === key);
}

/** The recipients a step on this event may name: its own, plus the two that are always valid. */
export function recipientsFor(event: EventDef): RecipientKind[] {
  return [...event.recipients, "employee", "phone"];
}

export function label(l: Label, lang: Lang): string {
  return lang === "ar" ? l.ar : l.en;
}

/** The sample values, as a render context — what the editor's preview shows. */
export function sampleContext(event: EventDef): Record<string, string> {
  return Object.fromEntries(event.variables.map((x) => [x.key, x.sample]));
}
