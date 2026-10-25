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
  quality: { ar: "الجودة", en: "Quality", hintAr: "الدفعات التي تنتظر فحص الجودة أو حُجزت، وطلبات الاستثناء والتصرف.", hintEn: "Batches waiting for quality control or held, exception and disposition requests." },
  finance: { ar: "المالية", en: "Finance", hintAr: "تحصيلات بانتظار الاعتماد وحدود الائتمان وطلبات الاعتماد المالي.", hintEn: "Collections awaiting approval, credit limits and finance approvals." },
  hr: { ar: "الموارد البشرية", en: "Human resources", hintAr: "طلبات الإجازة التي تنتظر قرارك ووثائق الموظفين القريبة من الانتهاء.", hintEn: "Leave requests waiting for your decision and employee documents about to expire." },
  me: { ar: "شؤوني", en: "My work", hintAr: "قسيمة راتبك وإجازاتك ورمز المحطة ووصولك إلى المحطات وانتهاء وثائقك.", hintEn: "Your payslip, your leave, your station PIN, station access and your documents' expiry." },
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
  // Workstations W4 · the packaging station.
  {
    key: "production.packaging_material_short", category: "production", severity: "warning",
    label: { ar: "نقص مواد تعبئة في محطة التعبئة", en: "Packaging materials short at the packaging station" },
    recipients: [{ perm: [{ module: "production", sub: "manage_schedule" }, { module: "production", sub: "manage_roasters" }, { module: "inventory", sub: "receive" }] }],
    requires: [MOD("inventory")],
    trigger: "POST /api/station/packaging/preview — a packaging task short of a material (once per material per day)",
    render: (f) => ({
      titleAr: `نقص ${s(f.material)} في التعبئة`, titleEn: `${s(f.material)} short at packaging`,
      bodyAr: `يلزم ${s(f.required)} والمتوفر ${s(f.available)}${f.batchNumber ? ` · الدفعة ${s(f.batchNumber)}` : ""}`,
      bodyEn: `${s(f.required)} needed, ${s(f.available)} on hand${f.batchNumber ? ` · batch ${s(f.batchNumber)}` : ""}`,
      link: "/dashboard/inventory?tab=pack",
    }),
  },
  {
    key: "dispatch.order_handed_off", category: "production", severity: "info",
    label: { ar: "طلب جُهّز وسُلّم للشحن", en: "An order was prepared and handed to dispatch" },
    recipients: [{ perm: [{ module: "dispatch", sub: "mark_delivered" }] }], requires: [MOD("dispatch")],
    trigger: "POST /api/station/handoffs — «تسليم للشحن» at the packaging station (DispatchHandoff, J-18)",
    render: (f) => ({
      titleAr: `الطلب #${s(f.orderNumber)} جاهز للشحن${f.partial ? " · جزئي" : ""}`,
      titleEn: `Order #${s(f.orderNumber)} is ready to ship${f.partial ? " · partial" : ""}`,
      bodyAr: [`${s(f.units)} وحدة`, f.staging ? `المكان: ${s(f.staging)}` : "", f.packages !== "" && f.packages !== undefined && f.packages !== null ? `${s(f.packages)} طرود` : "", `جهّزه ${s(f.byName)}`].filter(Boolean).join(" · "),
      bodyEn: [`${s(f.units)} unit(s)`, f.staging ? `Staged at: ${s(f.staging)}` : "", f.packages !== "" && f.packages !== undefined && f.packages !== null ? `${s(f.packages)} parcel(s)` : "", `Prepared by ${s(f.byName)}`].filter(Boolean).join(" · "),
      link: "/dashboard/dispatch",
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
  // QC station W3 (owner decisions 23 Oct 2026): hold, exception, disposition, profile approval.
  {
    key: "quality.batch_held", category: "quality", severity: "warning",
    label: { ar: "دفعة محجوزة بعد فحص الجودة", en: "A batch was held after quality control" },
    recipients: [{ perm: [{ module: "qc", sub: "manage" }, { module: "production", sub: "manage_schedule" }, { module: "production", sub: "manage_roasters" }] }],
    requires: [MOD("qc"), MOD("production")],
    trigger: "recordInspection (POST /api/station/quality/inspections) — an inspection outside the spec, with a defect or a failed sensory result",
    render: (f) => ({
      severity: f.foreign ? "danger" : "warning",
      titleAr: `الدفعة ${s(f.batchNumber)} محجوزة${f.foreign ? " · أجسام غريبة" : ""}`,
      titleEn: `Batch ${s(f.batchNumber)} is held${f.foreign ? " · foreign objects" : ""}`,
      bodyAr: [s(f.productName), s(f.reasonsAr), f.inspectorName ? `فحصها ${s(f.inspectorName)}` : ""].filter(Boolean).join(" · "),
      bodyEn: [s(f.productName), s(f.reasonsEn), f.inspectorName ? `Inspected by ${s(f.inspectorName)}` : ""].filter(Boolean).join(" · "),
      link: "/dashboard/qc?tab=held",
    }),
  },
  {
    key: "quality.exception_requested", category: "quality", severity: "warning",
    label: { ar: "طلب استثناء جودة ينتظر قرارك", en: "A QC exception request awaits your decision" },
    // The inspector of the inspection (and the requester, the actor) never decide it: excluded by the hook.
    recipients: [{ perm: [{ module: "qc", sub: "approve_exception" }] }], requires: [{ module: "qc", sub: "approve_exception" }],
    trigger: "requestException (POST /api/station/quality/exceptions, POST /api/qc/exceptions)",
    render: (f) => ({
      titleAr: `طلب استثناء ${s(f.number)} · الدفعة ${s(f.batchNumber)}`, titleEn: `Exception request ${s(f.number)} · batch ${s(f.batchNumber)}`,
      bodyAr: [s(f.productName), s(f.reasonAr), f.requesterName ? `طلبه ${s(f.requesterName)}` : ""].filter(Boolean).join(" · "),
      bodyEn: [s(f.productName), s(f.reasonEn), f.requesterName ? `Requested by ${s(f.requesterName)}` : ""].filter(Boolean).join(" · "),
      link: f.exceptionId ? `/dashboard/qc?tab=exceptions&id=${enc(s(f.exceptionId))}` : "/dashboard/qc?tab=exceptions",
    }),
  },
  {
    key: "quality.exception_decided", category: "quality", severity: "info",
    label: { ar: "قُرّر طلب الاستثناء الذي قدّمته", en: "Your QC exception request was decided" },
    recipients: [{ person: "requester" }], requires: [MOD("qc")],
    trigger: "decideException (POST /api/qc/exceptions/[id]/decide)",
    render: (f) => ({
      severity: f.status === "APPROVED" ? "success" : "warning",
      titleAr: `طلب الاستثناء ${s(f.number)} ${DECISION_AR[s(f.status)] ?? s(f.status)}`, titleEn: `Exception request ${s(f.number)} ${DECISION_EN[s(f.status)] ?? s(f.status)}`,
      bodyAr: [`الدفعة ${s(f.batchNumber)}`, f.deciderName ? `قرّره ${s(f.deciderName)}` : ""].filter(Boolean).join(" · "),
      bodyEn: [`Batch ${s(f.batchNumber)}`, f.deciderName ? `Decided by ${s(f.deciderName)}` : ""].filter(Boolean).join(" · "),
      link: f.exceptionId ? `/dashboard/qc?tab=exceptions&id=${enc(s(f.exceptionId))}` : "/dashboard/qc?tab=exceptions",
    }),
  },
  {
    key: "quality.disposition_requested", category: "quality", severity: "warning",
    label: { ar: "تصرف في دفعة محجوزة ينتظر قرارك", en: "A held-batch disposition awaits your decision" },
    recipients: [{ perm: [{ module: "qc", sub: "dispose" }] }], requires: [{ module: "qc", sub: "dispose" }],
    trigger: "requestDisposition (POST /api/qc/dispositions)",
    render: (f) => ({
      titleAr: `${s(f.kindAr)} · الدفعة ${s(f.batchNumber)} (${s(f.number)})`, titleEn: `${s(f.kindEn)} · batch ${s(f.batchNumber)} (${s(f.number)})`,
      bodyAr: [`${s(f.quantityKg)} كغ`, s(f.reason)].filter(Boolean).join(" · "), bodyEn: [`${s(f.quantityKg)} kg`, s(f.reason)].filter(Boolean).join(" · "),
      link: "/dashboard/qc?tab=held",
    }),
  },
  {
    key: "quality.disposition_decided", category: "quality", severity: "info",
    label: { ar: "قُرّر التصرف الذي طلبته", en: "Your held-batch disposition was decided" },
    recipients: [{ person: "requester" }], requires: [MOD("qc")],
    trigger: "decideDisposition (POST /api/qc/dispositions/[id]/decide)",
    render: (f) => ({
      severity: f.status === "REJECTED" ? "warning" : "success",
      titleAr: `${s(f.kindAr)} · الدفعة ${s(f.batchNumber)} ${DECISION_AR[s(f.status)] ?? "اعتُمد"}`, titleEn: `${s(f.kindEn)} · batch ${s(f.batchNumber)} ${DECISION_EN[s(f.status)] ?? "was approved"}`,
      bodyAr: f.deciderName ? `قرّره ${s(f.deciderName)}` : "", bodyEn: f.deciderName ? `Decided by ${s(f.deciderName)}` : "",
      link: "/dashboard/qc?tab=held",
    }),
  },
  {
    key: "production.profile_approved", category: "production", severity: "info",
    label: { ar: "اعتُمد إصدار ملف تحميص", en: "A roast profile version was approved" },
    recipients: [{ perm: [{ module: "production", sub: "manage_schedule" }, { module: "production", sub: "manage_roasters" }, { module: "qc", sub: "manage" }] }],
    requires: [MOD("production"), MOD("qc")],
    trigger: "approveVersion (POST /api/qc/profile-versions/[id]/approve)",
    render: (f) => ({
      titleAr: `اعتُمد ${s(f.profileName)} · الإصدار ${s(f.version)}`, titleEn: `${s(f.profileName)} · version ${s(f.version)} approved`,
      bodyAr: `${s(f.productName)} · حبوب ${s(f.whole)} · مطحون ${s(f.ground)} (${s(f.scale)})`,
      bodyEn: `${s(f.productName)} · whole ${s(f.whole)} · ground ${s(f.ground)} (${s(f.scale)})`,
      link: "/dashboard/qc?tab=profiles",
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
  {
    key: "hr.document_expiry", category: "hr", severity: "warning",
    label: { ar: "وثيقة موظف قريبة الانتهاء أو منتهية (هوية، إقامة، عقد، شهادة…)", en: "An employee document expiring soon or expired (ID, iqama, contract, certificate…)" },
    // The holders are chosen by the daily check itself (lib/hr/services/document-expiry.ts): the HR duty
    // that sees the item (documents_view / private_view / contracts_manage) with a scope covering the
    // person, and the admin role while it holds the HR module — never the person themself (they get
    // «me.document_expiry»), never an account without HR.
    recipients: [{ person: "holders" }], requires: [MOD("hr")],
    trigger: "the daily document-expiry check: GET /api/cron/hr-document-expiry (Vercel Cron, 03:00 UTC) and «تشغيل الآن» in HR settings (POST /api/hr/document-expiry/run)",
    render: (f) => {
      const n = Number(f.daysLeft ?? 0);
      const expired = n <= 0;
      return {
        severity: expired ? "danger" : n <= 7 ? "warning" : "info",
        titleAr: expired ? `انتهت ${s(f.labelAr)} — ${s(f.personName)}` : `${s(f.labelAr)} — ${s(f.personName)}: تنتهي بعد ${n} يومًا`,
        titleEn: expired ? `${s(f.labelEn)} of ${s(f.personName)} has expired` : `${s(f.labelEn)} of ${s(f.personName)} expires in ${n} days`,
        bodyAr: expired ? `انتهت في ${s(f.expiresOn)}${n < 0 ? ` (منذ ${-n} يومًا)` : ""}. جدّدها وحدّث التاريخ في ملف الموظف.` : `تاريخ الانتهاء ${s(f.expiresOn)}.`,
        bodyEn: expired ? `Expired on ${s(f.expiresOn)}${n < 0 ? ` (${-n} days ago)` : ""}. Renew it and update the date in the employee file.` : `Expiry date ${s(f.expiresOn)}.`,
        link: f.employeeId ? `/dashboard/hr/employees/${enc(s(f.employeeId))}?tab=${enc(s(f.tab) || "documents")}` : "/dashboard/hr",
      };
    },
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
  {
    key: "me.document_expiry", category: "me", severity: "warning",
    label: { ar: "وثيقتك قريبة الانتهاء أو منتهية (هوية، إقامة، شهادة…)", en: "Your document expiring soon or expired (ID, iqama, certificate…)" },
    recipients: [{ person: "subject" }],
    trigger: "the daily document-expiry check (GET /api/cron/hr-document-expiry; «تشغيل الآن» in HR settings) — your own documents and identity, never your contract end",
    render: (f) => {
      const n = Number(f.daysLeft ?? 0);
      const expired = n <= 0;
      return {
        severity: expired ? "danger" : n <= 7 ? "warning" : "info",
        titleAr: expired ? `انتهت ${s(f.labelAr)}` : `${s(f.labelAr)} تنتهي بعد ${n} يومًا`,
        titleEn: expired ? `Your ${s(f.labelEn)} has expired` : `Your ${s(f.labelEn)} expires in ${n} days`,
        bodyAr: expired ? `انتهت في ${s(f.expiresOn)}. سلّم النسخة المجددة للموارد البشرية.` : `تاريخ الانتهاء ${s(f.expiresOn)}. جدّدها وسلّم النسخة الجديدة للموارد البشرية.`,
        bodyEn: expired ? `It expired on ${s(f.expiresOn)}. Hand the renewed copy to HR.` : `Expiry date ${s(f.expiresOn)}. Renew it and hand the new copy to HR.`,
        link: "/dashboard/me",
      };
    },
  },
  // ── System ──
  {
    // ZATCA Phase 2 A4: a document ZATCA rejected, could not take (CSID / clearance switched off / conflict), or
    // accepted with warnings — the owner acts (a rejection is corrected with a credit note and a new invoice).
    key: "finance.zatca_attention", category: "finance", severity: "danger",
    label: { ar: "مستند فوترة إلكترونية يحتاج انتباهك", en: "An e-invoice needs your attention" },
    recipients: [{ perm: [{ module: "accounting", sub: "zatca_view" }] }], requires: [MOD("accounting")],
    trigger: "submitDocument (lib/zatca/pipeline.ts): REJECTED / ERROR / accepted with warnings; certificateAlerts (the cron): a production certificate expiring within 30 / 7 days",
    render: (f) => {
      const st = s(f.state);
      const warn = st.endsWith("_WITH_WARNINGS");
      if (st === "CERT_EXPIRING") {
        return {
          severity: "warning",
          titleAr: `شهادة الفوترة الإلكترونية للوحدة ${s(f.number)} تنتهي خلال ${s(f.detail)} يومًا`,
          titleEn: `The e-invoicing certificate of ${s(f.number)} expires in ${s(f.detail)} days`,
          bodyAr: "جدّدها برمز تحقق جديد من بوابة فاتورة قبل الانتهاء، وإلا توقف الإرسال إلى الهيئة.",
          bodyEn: "Renew it with a new OTP from the Fatoora portal before it expires, or sending to ZATCA stops.",
          link: "/dashboard/accounting/zatca",
        };
      }
      return {
        severity: warn ? "warning" : "danger",
        titleAr: warn ? `قبلت الهيئة المستند ${s(f.number)} مع ملاحظات` : st === "REJECTED" ? `رفضت الهيئة المستند ${s(f.number)}` : `تعذّر إرسال المستند ${s(f.number)} إلى الهيئة`,
        titleEn: warn ? `ZATCA accepted ${s(f.number)} with warnings` : st === "REJECTED" ? `ZATCA rejected ${s(f.number)}` : `${s(f.number)} could not be sent to ZATCA`,
        bodyAr: st === "REJECTED" ? `المستند يبقى صادرًا؛ التصحيح بإشعار دائن ثم فاتورة جديدة. ${s(f.detail)}` : s(f.detail),
        bodyEn: st === "REJECTED" ? `The document stays issued; correct it with a credit note and a new invoice. ${s(f.detail)}` : s(f.detail),
        link: f.invoiceId ? `/dashboard/sales/invoices/${enc(s(f.invoiceId))}` : "/dashboard/accounting/zatca",
      };
    },
  },
  // ── «مساحة عملي» · tasks, reviews, appointments (feat/my-workspace). Person-addressed only: the assignee,
  // the asker, the reviewer, the manager an overdue task escalates to, an appointment's participants. The
  // planned reminders are written by lib/workspace/server/reminders.ts and sent once (dedupe per due instant).
  {
    key: "me.task_assigned", category: "me", severity: "info",
    label: { ar: "أُسندت إليك مهمة", en: "A task was assigned to you" },
    recipients: [{ person: "assignee" }],
    trigger: "createTask / reassignTask (lib/workspace/server/tasks.ts)",
    render: (f) => ({
      severity: f.priority === "URGENT" ? "warning" : "info",
      titleAr: `مهمة جديدة: ${s(f.title)}`, titleEn: `New task: ${s(f.title)}`,
      bodyAr: [f.by ? `من ${s(f.by)}` : "", f.due ? `تُستحق ${s(f.due)}` : ""].filter(Boolean).join(" · "),
      bodyEn: [f.by ? `From ${s(f.by)}` : "", f.dueEn ? `Due ${s(f.dueEn)}` : ""].filter(Boolean).join(" · "),
      link: f.taskId ? `/dashboard/workspace/tasks?task=${enc(s(f.taskId))}` : "/dashboard/workspace",
    }),
  },
  {
    key: "me.task_due_soon", category: "me", severity: "info",
    label: { ar: "اقترب موعد مهمتك", en: "Your task is due soon" },
    recipients: [{ person: "recipient" }],
    trigger: "the workspace reminder runner (DUE_SOON / SNOOZE)",
    render: (f) => ({
      titleAr: `تذكير: ${s(f.title)}`, titleEn: `Reminder: ${s(f.title)}`,
      bodyAr: f.due ? `تُستحق ${s(f.due)}` : "", bodyEn: f.dueEn ? `Due ${s(f.dueEn)}` : "",
      link: f.taskId ? `/dashboard/workspace/tasks?task=${enc(s(f.taskId))}` : "/dashboard/workspace",
    }),
  },
  {
    key: "me.task_overdue", category: "me", severity: "warning",
    label: { ar: "تأخرت مهمتك", en: "Your task is overdue" },
    recipients: [{ person: "recipient" }],
    trigger: "the workspace reminder runner (OVERDUE)",
    render: (f) => ({
      titleAr: `متأخرة: ${s(f.title)}`, titleEn: `Overdue: ${s(f.title)}`,
      bodyAr: f.due ? `كان موعدها ${s(f.due)}` : "", bodyEn: f.dueEn ? `It was due ${s(f.dueEn)}` : "",
      link: f.taskId ? `/dashboard/workspace/tasks?task=${enc(s(f.taskId))}` : "/dashboard/workspace",
    }),
  },
  {
    key: "me.task_escalated", category: "me", severity: "warning",
    label: { ar: "مهمة متأخرة في فريقك", en: "An overdue task in your team" },
    recipients: [{ person: "recipient" }],
    trigger: "the workspace reminder runner (ESCALATION, WorkSettings.escalateAfterHours after the deadline) — to the asker and the assignee's manager",
    render: (f) => ({
      titleAr: `مهمة متأخرة لدى ${s(f.assignee)}: ${s(f.title)}`, titleEn: `Overdue with ${s(f.assignee)}: ${s(f.title)}`,
      bodyAr: f.due ? `كان موعدها ${s(f.due)}` : "", bodyEn: f.dueEn ? `It was due ${s(f.dueEn)}` : "",
      link: f.taskId ? `/dashboard/workspace/tasks?task=${enc(s(f.taskId))}` : "/dashboard/workspace",
    }),
  },
  {
    key: "me.task_review", category: "me", severity: "info",
    label: { ar: "مهمة بانتظار مراجعتك", en: "A task awaits your review" },
    recipients: [{ person: "reviewer" }],
    trigger: "transitionTask complete → IN_REVIEW",
    render: (f) => ({
      titleAr: `بانتظار مراجعتك: ${s(f.title)}`, titleEn: `Awaiting your review: ${s(f.title)}`,
      bodyAr: f.by ? `أنجزها ${s(f.by)}` : "", bodyEn: f.by ? `Completed by ${s(f.by)}` : "",
      link: f.taskId ? `/dashboard/workspace/tasks?task=${enc(s(f.taskId))}` : "/dashboard/workspace",
    }),
  },
  {
    key: "me.task_updated", category: "me", severity: "info",
    label: { ar: "تغيّرت مهمة تخصك (اكتملت، أُعيدت، أُلغيت، تغيّر موعدها)", en: "A task of yours changed (done, returned, cancelled, rescheduled)" },
    recipients: [{ person: "recipient" }],
    trigger: "transitionTask / updateTask — to the asker when the work is done, to the assignee when it is returned, cancelled or rescheduled",
    render: (f) => {
      const what: Record<string, [string, string]> = {
        DONE: ["اكتملت", "was completed"], RETURNED: ["أُعيدت للتنفيذ", "was returned for more work"],
        CANCELLED: ["أُلغيت", "was cancelled"], DUE_CHANGED: ["تغيّر موعدها", "was rescheduled"], ON_HOLD: ["توقفت", "was put on hold"],
      };
      const w = what[s(f.change)] ?? ["تغيّرت", "changed"];
      return {
        severity: f.change === "DONE" ? "success" : f.change === "CANCELLED" || f.change === "RETURNED" ? "warning" : "info",
        titleAr: `المهمة «${s(f.title)}» ${w[0]}`, titleEn: `Task «${s(f.title)}» ${w[1]}`,
        bodyAr: [f.by ? `بواسطة ${s(f.by)}` : "", s(f.note), f.due ? `الموعد ${s(f.due)}` : ""].filter(Boolean).join(" · "),
        bodyEn: [f.by ? `By ${s(f.by)}` : "", s(f.note), f.dueEn ? `Due ${s(f.dueEn)}` : ""].filter(Boolean).join(" · "),
        link: f.taskId ? `/dashboard/workspace/tasks?task=${enc(s(f.taskId))}` : "/dashboard/workspace",
      };
    },
  },
  {
    key: "me.appointment", category: "me", severity: "info",
    label: { ar: "موعد: دعوة، تغيير، إلغاء، أو تذكير", en: "Appointment: invitation, change, cancellation or reminder" },
    recipients: [{ person: "recipient" }],
    trigger: "createAppointment / updateAppointment / cancelAppointment and the reminder runner (APPOINTMENT)",
    render: (f) => {
      const what: Record<string, [string, string]> = {
        INVITED: ["دُعيت إلى", "You were invited to"], CHANGED: ["تغيّر موعد", "Rescheduled:"],
        CANCELLED: ["أُلغي", "Cancelled:"], SOON: ["يبدأ قريبًا", "Starting soon:"],
      };
      const w = what[s(f.change)] ?? ["موعد", "Appointment:"];
      return {
        severity: f.change === "CANCELLED" ? "warning" : "info",
        titleAr: `${w[0]} «${s(f.title)}»`, titleEn: `${w[1]} «${s(f.title)}»`,
        bodyAr: [s(f.when), s(f.where)].filter(Boolean).join(" · "), bodyEn: [s(f.whenEn), s(f.where)].filter(Boolean).join(" · "),
        link: f.appointmentId ? `/dashboard/workspace/calendar?appointment=${enc(s(f.appointmentId))}` : "/dashboard/workspace/calendar",
      };
    },
  },
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
