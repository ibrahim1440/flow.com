// «التنبيهات» — THE notification catalogue (feat/notifications). One table: event → category →
// who receives it → the words → where it links. Pure and client-safe: the preferences screen and
// the page read the categories from here, the server reads the events, and the unit tests assert
// the recipients of every event without a database.
//
// ── Who receives a notification ──
// Never a role name — the owner customises roles. A recipient is found by:
//   * PERMISSION — an active account holding any of `perm` (a module, a module at edit, or a
//     module's sub-privilege), read the way every request reads it (lib/notifications/recipients.ts:
//     the stored document, the role default when empty, SIMPLE MODE for the admin role);
//   * OWNERSHIP / PERSON — an id the event names (the order's owner, the customer's account owner,
//     the deal owner, the rep who recorded a collection, the operator of a slot, the employee
//     whose payslip it is …), passed by the hook point as `people`.
// Then, for every recipient:
//   * the actor is removed — nobody is notified of their own act;
//   * `requires` (any of): the recipient must hold the module the link opens, so nobody is told
//     about a screen they cannot open;
//   * `scope: "customer"`: a sales rep who sees only their own customers (the sales module without
//     lead_assign — lib/services/sales/scope.ts) receives a PERMISSION-based notification about a
//     customer only when they own that customer or the deal (`scopeOwners`). Owners named by the
//     event are, by definition, entitled.
// Texts carry no amounts where a recipient might not see them (credit alerts name the condition,
// never the balance).
//
// ── E-mail ──
// In-app is always on. E-mail per category, per person (NotificationPreference); the default is
// EMAIL_DEFAULT: ON for «me» (the person's own work: payslip, leave, station PIN — rare, personal,
// worth an e-mail) and for «system» (the storage incidents, which were e-mailed before this
// feature to the same people: keeping it on keeps that behaviour); OFF for the work categories,
// which can be frequent and are seen in the app during work.

import type { Permissions } from "@/lib/auth-shared";

export type Lang = "ar" | "en";
export type Bi = { ar: string; en: string };

export const CATEGORIES = ["sales", "production", "quality", "finance", "hr", "me", "system"] as const;
export type Category = (typeof CATEGORIES)[number];
export function isCategory(x: unknown): x is Category {
  return typeof x === "string" && (CATEGORIES as readonly string[]).includes(x);
}

export const CATEGORY_LABEL: Record<Category, Bi & { hintAr: string; hintEn: string }> = {
  sales: { ar: "المبيعات", en: "Sales", hintAr: "عروض الأسعار وطلبات عملائك وإيقاف البيع والتحصيل.", hintEn: "Quotations, your customers' orders, sales holds and collections." },
  production: { ar: "الإنتاج", en: "Production", hintAr: "أوامر الإنتاج وجدول التحميص والمحامص ومشكلات المحطات.", hintEn: "Production orders, the roasting schedule, roasters and station problems." },
  quality: { ar: "الجودة", en: "Quality", hintAr: "الدفعات التي تنتظر فحص الجودة.", hintEn: "Batches waiting for quality control." },
  finance: { ar: "المالية", en: "Finance", hintAr: "تحصيلات بانتظار الاعتماد وحدود الائتمان وطلبات الاعتماد المالي.", hintEn: "Collections awaiting approval, credit limits and finance approvals." },
  hr: { ar: "الموارد البشرية", en: "Human resources", hintAr: "طلبات الإجازة التي تنتظر قرارك.", hintEn: "Leave requests waiting for your decision." },
  me: { ar: "شؤوني", en: "My work", hintAr: "قسيمة راتبك وإجازاتك ورمز المحطة ووصولك إلى المحطات.", hintEn: "Your payslip, your leave, your station PIN and station access." },
  system: { ar: "النظام", en: "System", hintAr: "أعطال التخزين وإصلاحها.", hintEn: "Storage incidents and their recovery." },
};

/** Default e-mail choice per category (see the header). */
export const EMAIL_DEFAULT: Record<Category, boolean> = {
  sales: false, production: false, quality: false, finance: false, hr: false, me: true, system: true,
};

export type Severity = "info" | "success" | "warning" | "danger";

/** A module (any access), a module at edit, or a module's sub-privilege. */
export type Ability = { module: string; sub?: string; edit?: true };

export type RecipientRule = { perm: Ability[] } | { person: string };

export type Facts = Record<string, string | number | null | undefined>;
export type Rendered = { titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; link: string | null; severity?: Severity };

export type NotificationEventDef = {
  key: string;
  category: Category;
  severity: Severity;
  label: Bi;
  recipients: RecipientRule[];
  /** The recipient must hold ANY of these (the module the link opens). Absent: no requirement. */
  requires?: Ability[];
  /** Permission-based recipients who are scoped sales reps need to own the customer / deal. */
  scope?: "customer";
  /** Where it is raised (documentation; the report's table). */
  trigger: string;
  render(f: Facts): Rendered;
};

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const enc = encodeURIComponent;

const ORDER_STATUS_AR: Record<string, string> = {
  Completed: "اكتمل وسُلِّم", "On Hold": "عُلِّق مؤقتًا", Cancelled: "أُلغي", resumed: "استُؤنف", part_delivered: "سُلِّم جزئيًا",
};
const ORDER_STATUS_EN: Record<string, string> = {
  Completed: "was completed and delivered", "On Hold": "was put on hold", Cancelled: "was cancelled", resumed: "was resumed", part_delivered: "was partially delivered",
};
const QUOTE_AR: Record<string, string> = { ACCEPTED: "قُبل", REJECTED: "رُفض", EXPIRED: "انتهت صلاحيته" };
const QUOTE_EN: Record<string, string> = { ACCEPTED: "was accepted", REJECTED: "was rejected", EXPIRED: "expired" };
const COLLECTION_AR: Record<string, string> = { APPROVED: "اعتُمد", REJECTED: "رُفض", REVERSED: "عُكس" };
const COLLECTION_EN: Record<string, string> = { APPROVED: "was approved", REJECTED: "was rejected", REVERSED: "was reversed" };
const HOLD_AR: Record<string, string> = { HOLD: "أُوقف البيع لعميلك", GRACE: "مُنح عميلك مهلة سداد", LIFT: "رُفع إيقاف البيع عن عميلك", AUTO_LIFT: "رُفع إيقاف البيع عن عميلك تلقائيًا" };
const HOLD_EN: Record<string, string> = { HOLD: "Sales were put on hold for your customer", GRACE: "Your customer was given grace days", LIFT: "The sales hold on your customer was lifted", AUTO_LIFT: "The sales hold on your customer ended automatically" };
const ROASTER_AR: Record<string, string> = { MAINTENANCE: "في الصيانة", STOPPED: "متوقفة", OUT_OF_SERVICE: "خارج الخدمة" };
const ROASTER_EN: Record<string, string> = { MAINTENANCE: "under maintenance", STOPPED: "stopped", OUT_OF_SERVICE: "out of service" };
const APPROVAL_TYPE_AR: Record<string, string> = { BUDGET_APPROVAL: "اعتماد ميزانية", ALLOCATION_RULES: "قواعد التوزيع", CATEGORY_TRANSFER: "تحويل بين البنود", SPEND_OVERRIDE: "تجاوز حد الصرف", PERIOD_REOPEN: "إعادة فتح فترة" };
const DECISION_AR: Record<string, string> = { APPROVED: "اعتُمد", REJECTED: "رُفض", CANCELLED: "سُحب" };
const DECISION_EN: Record<string, string> = { APPROVED: "was approved", REJECTED: "was rejected", CANCELLED: "was withdrawn" };

const sales = (sub?: string): Ability => ({ module: "sales", ...(sub ? { sub } : {}) });
const MOD = (module: string): Ability => ({ module });

export const EVENTS: NotificationEventDef[] = [
  // ── Sales ──
  {
    key: "sales.quote_decided", category: "sales", severity: "info",
    label: { ar: "قُبل عرض سعرك أو رُفض أو انتهى", en: "Your quotation accepted / rejected / expired" },
    recipients: [{ person: "dealOwner" }], requires: [MOD("sales")],
    trigger: "POST /api/sales/quotes/[id]/transition (automation event sales.quote_status_changed)",
    render: (f) => ({
      severity: f.status === "ACCEPTED" ? "success" : f.status === "REJECTED" ? "warning" : "info",
      titleAr: `عرض السعر ${s(f.quoteNumber)} ${QUOTE_AR[s(f.status)] ?? s(f.status)}`,
      titleEn: `Quotation ${s(f.quoteNumber)} ${QUOTE_EN[s(f.status)] ?? s(f.status)}`,
      bodyAr: s(f.customerName), bodyEn: s(f.customerName),
      link: f.quoteId ? `/dashboard/sales/quotes/${enc(s(f.quoteId))}` : "/dashboard/sales/quotes",
    }),
  },
  {
    key: "sales.discount_pending", category: "sales", severity: "warning",
    label: { ar: "عرض سعر ينتظر اعتمادك للخصم", en: "A quotation's discount awaits your approval" },
    recipients: [{ perm: [sales("quote_approve_discount")] }], requires: [MOD("sales")], scope: "customer",
    trigger: "saveQuoteLines — a draft saved with a discount above the threshold (POST /api/sales/quotes, PATCH /api/sales/quotes/[id], revise)",
    render: (f) => ({
      titleAr: `اعتمادك مطلوب: خصم ${s(f.percent)}٪ على عرض السعر ${s(f.quoteNumber)}`,
      titleEn: `Your approval is needed: ${s(f.percent)}% discount on quotation ${s(f.quoteNumber)}`,
      bodyAr: s(f.customerName), bodyEn: s(f.customerName),
      link: `/dashboard/sales/quotes/${enc(s(f.quoteId))}`,
    }),
  },
  {
    key: "sales.discount_decided", category: "sales", severity: "info",
    label: { ar: "اعتُمد الخصم على عرضك أو رُفض", en: "The discount on your quotation approved / refused" },
    recipients: [{ person: "quoteCreator" }, { person: "dealOwner" }], requires: [MOD("sales")],
    trigger: "POST /api/sales/quotes/[id]/discount-approval (decideDiscount)",
    render: (f) => ({
      severity: f.decision === "APPROVE" ? "success" : "warning",
      titleAr: f.decision === "APPROVE" ? `اعتُمد الخصم على عرض السعر ${s(f.quoteNumber)}` : `رُفض الخصم على عرض السعر ${s(f.quoteNumber)}`,
      titleEn: f.decision === "APPROVE" ? `The discount on quotation ${s(f.quoteNumber)} was approved` : `The discount on quotation ${s(f.quoteNumber)} was refused`,
      bodyAr: s(f.note), bodyEn: s(f.note),
      link: `/dashboard/sales/quotes/${enc(s(f.quoteId))}`,
    }),
  },
  {
    key: "sales.order_created", category: "sales", severity: "info",
    label: { ar: "طلب جديد لعميلك أو من عرضك", en: "An order for your customer / from your quotation" },
    recipients: [{ person: "dealOwner" }, { person: "customerOwner" }, { person: "orderOwner" }],
    requires: [MOD("orders"), MOD("sales"), MOD("customers")],
    trigger: "POST /api/orders, POST /api/sales/quotes/[id]/create-order (automation event order.created)",
    render: (f) => ({
      titleAr: `طلب جديد #${s(f.orderNumber)} لعميلك ${s(f.customerName)}`,
      titleEn: `New order #${s(f.orderNumber)} for your customer ${s(f.customerName)}`,
      bodyAr: f.quoteNumber ? `من عرض السعر ${s(f.quoteNumber)}` : "", bodyEn: f.quoteNumber ? `From quotation ${s(f.quoteNumber)}` : "",
      link: "/dashboard/orders",
    }),
  },
  {
    key: "sales.order_status", category: "sales", severity: "info",
    label: { ar: "تغيّرت حالة طلب عميلك (سُلِّم، جزئيًا، معلّق، ملغى، استُؤنف)", en: "Your customer's order delivered / part-delivered / held / cancelled / resumed" },
    recipients: [{ person: "orderOwner" }, { person: "customerOwner" }],
    requires: [MOD("orders"), MOD("sales"), MOD("customers")],
    trigger: "POST /api/orders/[id]/status, auto-close on delivery, preparation (order.status_changed); POST /api/deliveries (order.progress_changed)",
    render: (f) => ({
      severity: f.status === "Completed" ? "success" : f.status === "On Hold" || f.status === "Cancelled" ? "warning" : "info",
      titleAr: `الطلب #${s(f.orderNumber)} ${ORDER_STATUS_AR[s(f.status)] ?? s(f.status)}`,
      titleEn: `Order #${s(f.orderNumber)} ${ORDER_STATUS_EN[s(f.status)] ?? s(f.status)}`,
      bodyAr: [s(f.customerName), s(f.reason)].filter(Boolean).join(" · "), bodyEn: [s(f.customerName), s(f.reason)].filter(Boolean).join(" · "),
      link: "/dashboard/orders",
    }),
  },
  {
    key: "sales.customer_hold", category: "sales", severity: "warning",
    label: { ar: "إيقاف البيع لعميلك أو مهلة أو رفع الإيقاف", en: "Your customer held / given grace / hold lifted" },
    recipients: [{ person: "customerOwner" }, { perm: [{ module: "customers", sub: "sales_hold" }] }],
    requires: [MOD("customers"), MOD("sales")], scope: "customer",
    trigger: "POST /api/customers/[id]/credit/{hold,grace,lift}; automatic lift on read / at creation (settleHold)",
    render: (f) => ({
      severity: f.kind === "HOLD" ? "danger" : f.kind === "GRACE" ? "warning" : "success",
      titleAr: `${HOLD_AR[s(f.kind)] ?? s(f.kind)}: ${s(f.customerName)}`,
      titleEn: `${HOLD_EN[s(f.kind)] ?? s(f.kind)}: ${s(f.customerName)}`,
      bodyAr: [f.days ? `${s(f.days)} يومًا` : "", s(f.reason)].filter(Boolean).join(" · "),
      bodyEn: [f.days ? `${s(f.days)} days` : "", s(f.reason)].filter(Boolean).join(" · "),
      link: `/dashboard/customers/${enc(s(f.customerId))}`,
    }),
  },
  {
    key: "sales.collection_decided", category: "sales", severity: "info",
    label: { ar: "اعتُمد التحصيل الذي سجّلته أو رُفض أو عُكس", en: "The collection you recorded approved / rejected / reversed" },
    recipients: [{ person: "submitter" }], requires: [MOD("sales"), MOD("commissions")],
    trigger: "approve / reject / reverse collection (automation event sales.collection_status_changed)",
    render: (f) => ({
      severity: f.status === "APPROVED" ? "success" : "warning",
      titleAr: `التحصيل ${s(f.reference) ? `${s(f.reference)} ` : ""}${COLLECTION_AR[s(f.status)] ?? s(f.status)}`,
      titleEn: `Collection ${s(f.reference) ? `${s(f.reference)} ` : ""}${COLLECTION_EN[s(f.status)] ?? s(f.status)}`,
      bodyAr: [s(f.customerName), s(f.amount)].filter(Boolean).join(" · "), bodyEn: [s(f.customerName), s(f.amount)].filter(Boolean).join(" · "),
      link: "/dashboard/sales/collections",
    }),
  },
  // ── Finance ──
  {
    key: "finance.collection_pending", category: "finance", severity: "warning",
    label: { ar: "تحصيل بانتظار الاعتماد", en: "A collection awaits approval" },
    recipients: [{ perm: [{ module: "commissions", sub: "collection_verify" }] }], requires: [MOD("commissions"), MOD("sales")],
    trigger: "submitCollection (automation event sales.collection_status_changed → PENDING_VERIFICATION)",
    render: (f) => ({
      titleAr: `تحصيل بانتظار الاعتماد: ${s(f.customerName)}`,
      titleEn: `Collection awaiting approval: ${s(f.customerName)}`,
      bodyAr: [s(f.amount), f.submitterName ? `سجّله ${s(f.submitterName)}` : ""].filter(Boolean).join(" · "),
      bodyEn: [s(f.amount), f.submitterName ? `recorded by ${s(f.submitterName)}` : ""].filter(Boolean).join(" · "),
      link: "/dashboard/sales/collections",
    }),
  },
  {
    key: "finance.credit_alert", category: "finance", severity: "warning",
    label: { ar: "عميل تجاوز حد الائتمان أو تأخر في السداد (مرة لكل تغيّر)", en: "A customer over the credit limit or overdue (once per change)" },
    recipients: [{ perm: [{ module: "customers", sub: "sales_hold" }, { module: "commissions", sub: "collection_verify" }] }],
    requires: [MOD("customers")], scope: "customer",
    trigger: "after an accepted quotation, an approved / reversed collection or a delivery, and when the customer file or list is read (lib/notifications/credit-watch.ts)",
    render: (f) => {
      const over = f.overLimit === "yes";
      const late = Number(f.overdueDays ?? 0) > 0;
      const ar = [over ? "تجاوز حد الائتمان" : "", late ? `متأخر في السداد ${s(f.overdueDays)} يومًا` : ""].filter(Boolean).join(" و");
      const en = [over ? "is over the credit limit" : "", late ? `is ${s(f.overdueDays)} days overdue` : ""].filter(Boolean).join(" and ");
      return {
        severity: over && late ? "danger" : "warning",
        titleAr: `${s(f.customerName)}: ${ar}`, titleEn: `${s(f.customerName)} ${en}`,
        bodyAr: "راجع ملف العميل قبل البيع له بالآجل.", bodyEn: "Review the customer file before selling on credit.",
        link: `/dashboard/customers/${enc(s(f.customerId))}`,
      };
    },
  },
  {
    key: "finance.approval_requested", category: "finance", severity: "warning",
    label: { ar: "طلب اعتماد مالي ينتظر قرارك", en: "A finance request awaits your decision" },
    recipients: [{ person: "approvers" }], requires: [MOD("finance")],
    trigger: "requestApproval (automation event finance.approval_requested)",
    render: (f) => ({
      titleAr: `طلب اعتماد: ${APPROVAL_TYPE_AR[s(f.type)] ?? s(f.type)}`, titleEn: `Approval requested: ${s(f.type).replace(/_/g, " ").toLowerCase()}`,
      bodyAr: s(f.summary), bodyEn: s(f.summary), link: "/dashboard/finance",
    }),
  },
  {
    key: "finance.approval_decided", category: "finance", severity: "info",
    label: { ar: "صدر قرار على طلبك المالي", en: "Your finance request was decided" },
    recipients: [{ person: "requester" }], requires: [MOD("finance")],
    trigger: "decide / withdraw approval (automation event finance.approval_decided)",
    render: (f) => ({
      severity: f.decision === "APPROVED" ? "success" : "warning",
      titleAr: `طلبك (${APPROVAL_TYPE_AR[s(f.type)] ?? s(f.type)}) ${DECISION_AR[s(f.decision)] ?? s(f.decision)}`,
      titleEn: `Your request ${DECISION_EN[s(f.decision)] ?? s(f.decision)}`,
      bodyAr: s(f.summary), bodyEn: s(f.summary), link: "/dashboard/finance",
    }),
  },
  // ── Production ──
  {
    key: "production.order_created", category: "production", severity: "info",
    label: { ar: "أمر إنتاج جديد", en: "New production order" },
    recipients: [{ perm: [{ module: "production", sub: "start_batch" }, { module: "production", sub: "manage_schedule" }] }], requires: [MOD("production")],
    trigger: "createScheduledProductionOrder — manual and automatic shortfall (automation event production.order_created)",
    render: (f) => ({
      titleAr: `أمر إنتاج جديد ${s(f.productionNumber)}: ${s(f.units)} × ${s(f.sku)}`,
      titleEn: `New production order ${s(f.productionNumber)}: ${s(f.units)} × ${s(f.sku)}`,
      bodyAr: f.greenKg ? `بن أخضر متوقع ${s(f.greenKg)} كغ` : "", bodyEn: f.greenKg ? `${s(f.greenKg)} kg green expected` : "",
      link: f.productionOrderId ? `/dashboard/production-orders/${enc(s(f.productionOrderId))}` : "/dashboard/production-orders",
    }),
  },
  {
    key: "production.slot_assigned", category: "production", severity: "info",
    label: { ar: "أُسندت إليك دفعات في جدول التحميص", en: "Roasting slots assigned to you" },
    recipients: [{ person: "operator" }],
    trigger: "approvePlan (POST /api/production/schedule/plans); moveSlot reassigning a slot to you",
    render: (f) => ({
      titleAr: Number(f.count ?? 1) > 1 ? `أُسندت إليك ${s(f.count)} دفعات تحميص على ${s(f.roasterName)}` : `أُسندت إليك دفعة تحميص على ${s(f.roasterName)}`,
      titleEn: Number(f.count ?? 1) > 1 ? `${s(f.count)} roasting slots assigned to you on ${s(f.roasterName)}` : `A roasting slot assigned to you on ${s(f.roasterName)}`,
      bodyAr: [s(f.productName), s(f.when)].filter(Boolean).join(" · "), bodyEn: [s(f.productName), s(f.when)].filter(Boolean).join(" · "),
      link: `/dashboard/production/schedule${f.day ? `?date=${enc(s(f.day))}` : ""}`,
    }),
  },
  {
    key: "production.slot_changed", category: "production", severity: "warning",
    label: { ar: "نُقلت دفعتك أو أُسندت لغيرك", en: "Your slot moved / given to someone else" },
    recipients: [{ person: "operator" }],
    trigger: "moveSlot (PATCH /api/production/schedule/slots/[id])",
    render: (f) => ({
      titleAr: f.change === "REMOVED" ? `أُسندت دفعة التحميص على ${s(f.roasterName)} إلى ${s(f.otherName) || "مشغّل آخر"}` : `تغيّر موعد دفعة التحميص على ${s(f.roasterName)}`,
      titleEn: f.change === "REMOVED" ? `Your roasting slot on ${s(f.roasterName)} was given to ${s(f.otherName) || "another operator"}` : `Your roasting slot on ${s(f.roasterName)} was moved`,
      bodyAr: s(f.whenAr) || s(f.when), bodyEn: s(f.when),
      link: `/dashboard/production/schedule${f.day ? `?date=${enc(s(f.day))}` : ""}`,
    }),
  },
  {
    key: "production.slot_cancelled", category: "production", severity: "warning",
    label: { ar: "أُلغيت دفعة تحميص مسندة إليك", en: "A roasting slot of yours was cancelled" },
    recipients: [{ person: "operator" }],
    trigger: "cancelSlot (POST /api/production/schedule/slots/[id]/cancel); roaster status change (cancelSlotsForRoasterStatus)",
    render: (f) => ({
      titleAr: Number(f.count ?? 1) > 1 ? `أُلغيت ${s(f.count)} دفعات تحميص مسندة إليك على ${s(f.roasterName)}` : `أُلغيت دفعة تحميص مسندة إليك على ${s(f.roasterName)}`,
      titleEn: Number(f.count ?? 1) > 1 ? `${s(f.count)} of your roasting slots on ${s(f.roasterName)} were cancelled` : `Your roasting slot on ${s(f.roasterName)} was cancelled`,
      bodyAr: [s(f.when), s(f.reason)].filter(Boolean).join(" · "), bodyEn: [s(f.when), s(f.reason)].filter(Boolean).join(" · "),
      link: `/dashboard/production/schedule${f.day ? `?date=${enc(s(f.day))}` : ""}`,
    }),
  },
  {
    key: "production.station_problem", category: "production", severity: "danger",
    label: { ar: "أُبلغ عن مشكلة في محطة التحميص", en: "A problem was reported at the roasting station" },
    recipients: [{ perm: [{ module: "production", sub: "manage_schedule" }, { module: "production", sub: "manage_roasters" }] }], requires: [MOD("production")],
    trigger: "reportProblem — «الإبلاغ عن مشكلة» at the station (WorkstationActionLog FLAG)",
    render: (f) => ({
      titleAr: `مشكلة في محطة التحميص: ${s(f.kindAr)}`, titleEn: `Roasting station problem: ${s(f.kindEn)}`,
      bodyAr: [`أبلغ ${s(f.byName)}`, s(f.reason)].filter(Boolean).join(" · "), bodyEn: [`Reported by ${s(f.byName)}`, s(f.reason)].filter(Boolean).join(" · "),
      link: "/dashboard/production",
    }),
  },
  {
    key: "production.roaster_status", category: "production", severity: "warning",
    label: { ar: "محمصة دخلت الصيانة أو توقفت", en: "A roaster under maintenance or stopped" },
    recipients: [{ perm: [{ module: "production", sub: "manage_schedule" }, { module: "production", sub: "manage_roasters" }] }, { person: "operators" }],
    requires: [MOD("production")],
    trigger: "PATCH /api/settings/production/roasters/[id] and …/status (cancelSlotsForRoasterStatus)",
    render: (f) => ({
      titleAr: `المحمصة ${s(f.roasterName)} ${ROASTER_AR[s(f.status)] ?? s(f.status)}`,
      titleEn: `Roaster ${s(f.roasterName)} is ${ROASTER_EN[s(f.status)] ?? s(f.status)}`,
      bodyAr: [s(f.reason), Number(f.cancelled ?? 0) > 0 ? `أُلغيت ${s(f.cancelled)} دفعة مجدولة` : ""].filter(Boolean).join(" · "),
      bodyEn: [s(f.reason), Number(f.cancelled ?? 0) > 0 ? `${s(f.cancelled)} scheduled slot(s) cancelled` : ""].filter(Boolean).join(" · "),
      link: "/dashboard/production/schedule?view=roasters",
    }),
  },
  // ── Quality ──
  {
    key: "quality.batch_pending", category: "quality", severity: "info",
    label: { ar: "دفعة تنتظر فحص الجودة", en: "A batch awaits quality control" },
    recipients: [{ perm: [{ module: "qc", sub: "create_record" }, { module: "qc", sub: "manage" }] }], requires: [MOD("qc")],
    trigger: "POST /api/roasting-batches — a batch recorded «Pending QC» (automation event production.batch_roasted)",
    render: (f) => ({
      titleAr: `الدفعة ${s(f.batchNumber)} تنتظر فحص الجودة`, titleEn: `Batch ${s(f.batchNumber)} awaits quality control`,
      bodyAr: s(f.productName), bodyEn: s(f.productName), link: "/dashboard/qc",
    }),
  },
  // ── HR (a decision is waiting for you) ──
  {
    key: "hr.leave_pending", category: "hr", severity: "warning",
    label: { ar: "طلب إجازة ينتظر قرارك", en: "A leave request awaits your decision" },
    recipients: [{ person: "approvers" }], requires: [{ module: "hr", sub: "leave_approve" }],
    trigger: "requestLeave (POST /api/hr/leave/requests, POST /api/hr/me/leave)",
    render: (f) => ({
      titleAr: `طلب إجازة من ${s(f.personName)} ينتظر قرارك`, titleEn: `Leave request from ${s(f.personName)} awaits your decision`,
      bodyAr: `${s(f.leaveTypeAr)} · من ${s(f.from)} إلى ${s(f.to)} · ${s(f.days)} يوم`, bodyEn: `${s(f.from)} → ${s(f.to)} · ${s(f.days)} day(s)`,
      link: "/dashboard/hr/leave",
    }),
  },
  // ── Me (the person's own work) ──
  {
    key: "me.payslip_issued", category: "me", severity: "success",
    label: { ar: "صدرت قسيمة راتبك", en: "Your payslip was issued" },
    recipients: [{ person: "subject" }],
    trigger: "approveLines — the payroll run becomes APPROVED (the payslip is visible from then)",
    render: (f) => ({
      titleAr: `صدرت قسيمة راتبك لشهر ${s(f.month)}`, titleEn: `Your payslip for ${s(f.month)} was issued`,
      bodyAr: "يمكنك الاطلاع عليها وتنزيلها من «خدماتي».", bodyEn: "You can view and download it from «My HR».",
      link: f.lineId ? `/dashboard/me/payslips/${enc(s(f.lineId))}` : "/dashboard/me",
    }),
  },
  {
    key: "me.leave_decided", category: "me", severity: "info",
    label: { ar: "اعتُمدت إجازتك أو رُفضت", en: "Your leave approved / rejected" },
    recipients: [{ person: "subject" }],
    trigger: "decideLeave (POST /api/hr/leave/requests/[id]/decide)",
    render: (f) => ({
      severity: f.decision === "APPROVE" ? "success" : "warning",
      titleAr: f.decision === "APPROVE" ? "اعتُمد طلب إجازتك" : "رُفض طلب إجازتك",
      titleEn: f.decision === "APPROVE" ? "Your leave request was approved" : "Your leave request was rejected",
      bodyAr: [`من ${s(f.from)} إلى ${s(f.to)}`, s(f.note)].filter(Boolean).join(" · "), bodyEn: [`${s(f.from)} → ${s(f.to)}`, s(f.note)].filter(Boolean).join(" · "),
      link: "/dashboard/me",
    }),
  },
  {
    key: "me.station_pin_locked", category: "me", severity: "danger",
    label: { ar: "قُفل رمز محطتك بعد محاولات خاطئة", en: "Your station PIN was locked" },
    recipients: [{ person: "subject" }],
    trigger: "station sign-in — the last wrong PIN locks it on that device (lib/services/station/session.ts)",
    render: (f) => ({
      titleAr: `قُفل رمز المحطة على جهاز «${s(f.device)}»`, titleEn: `Your station PIN was locked on «${s(f.device)}»`,
      bodyAr: "بعد عدة محاولات خاطئة. إن لم تكن أنت، أبلغ المسؤول. يعيد المسؤول تفعيله.", bodyEn: "After several wrong attempts. If it was not you, tell the administrator, who can re-enable it.",
      link: "/dashboard/profile?tab=security",
    }),
  },
  {
    key: "me.station_pin_reenabled", category: "me", severity: "success",
    label: { ar: "أُعيد تفعيل رمز محطتك", en: "Your station PIN was re-enabled" },
    recipients: [{ person: "subject" }],
    trigger: "users screen «إعادة تفعيل رمز المحطة» (reenable_station_pin)",
    render: () => ({ titleAr: "أُعيد تفعيل رمز محطتك", titleEn: "Your station PIN was re-enabled", bodyAr: "يمكنك الدخول من أجهزة المحطات من جديد.", bodyEn: "You can sign in at the station devices again.", link: "/dashboard/profile?tab=security" }),
  },
  {
    key: "me.station_access_granted", category: "me", severity: "info",
    label: { ar: "مُنحت وصولًا إلى محطة", en: "Station access granted" },
    recipients: [{ person: "subject" }],
    trigger: "PUT /api/users/[id]/stations (setUserStations, NONE → allowed)",
    render: (f) => ({
      titleAr: `مُنحت وصولًا إلى محطة ${s(f.stations)}`, titleEn: `You were given access to station ${s(f.stations)}`,
      bodyAr: "عيّن رمز المحطة من «ملفي» إن لم تفعل بعد.", bodyEn: "Set your station PIN from «My profile» if you have not yet.",
      link: "/dashboard/profile?tab=security",
    }),
  },
  // ── System ──
  {
    key: "system.storage_incident", category: "system", severity: "danger",
    label: { ar: "تعطّل تخزين ملفات العملاء", en: "Customer file storage incident" },
    recipients: [{ perm: [{ module: "settings", edit: true }] }],
    trigger: "reportStorageFailure (lib/services/system/storage-alerts.ts; server uploads and direct browser-to-Blob uploads)",
    render: (f) => ({ severity: (s(f.severity) || "danger") as Severity, titleAr: s(f.titleAr), titleEn: s(f.titleEn), bodyAr: s(f.bodyAr), bodyEn: s(f.bodyEn), link: "/dashboard/settings" }),
  },
  {
    key: "system.storage_recovered", category: "system", severity: "success",
    label: { ar: "تم إصلاح تخزين ملفات العملاء", en: "Customer file storage recovered" },
    recipients: [{ perm: [{ module: "settings", edit: true }] }],
    trigger: "reportStorageSuccess (lib/services/system/storage-alerts.ts)",
    render: (f) => ({ severity: "success", titleAr: s(f.titleAr), titleEn: s(f.titleEn), bodyAr: s(f.bodyAr), bodyEn: s(f.bodyEn), link: "/dashboard/settings" }),
  },
];

const BY_KEY = new Map(EVENTS.map((e) => [e.key, e]));
export type EventKey = string;
export function eventDef(key: string): NotificationEventDef | undefined {
  return BY_KEY.get(key);
}

/** Does `perms` (already effective) hold this ability? */
export function holdsAbility(perms: Permissions, a: Ability): boolean {
  const p = perms[a.module];
  const level: unknown = p?.access;
  if (typeof level !== "string" || level === "" || level === "none") return false;
  if (a.edit && level !== "edit") return false;
  if (a.sub) return !!p?.sub && p.sub[a.sub] === true;
  return true;
}
