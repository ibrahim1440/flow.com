import { canEdit, hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import type { Viewer } from "@/lib/nav/registry";

/**
 * «+ جديد» (reference top bar, `C`) and the phone «+» (reference tab bar).
 *
 * Owner decision A-3 (15 Oct 2026): shown when the viewer has create actions that are both
 * IMPLEMENTED and PERMITTED in the CURRENT MODULE — several open a menu, exactly one opens
 * directly, none hide the control. It applies to every Direction 2.1 module, HR included.
 *
 * ── The contract a module provides ──
 * A list of `CreateAction`s under its registry module id (`CREATE_ACTIONS` below). Each is an
 * existing create action of one of the module's pages: `href` is that page with `?new=<kind>`,
 * and the page opens its own form when it sees it (`useCreateRequest(kind, open, enabled)` in
 * `./page-context`, which then drops the parameter). `permitted` is the same check the page's
 * own button and its API already make; nothing new is granted, and nothing is offered that the
 * server would refuse. HR's list follows docs/hr/CREATE-ACTIONS.md.
 */
export type CreateAction = {
  /** Stable and module-prefixed; also the test id `d21-new-<id>`. */
  id: string;
  labelAr: string;
  labelEn: string;
  /** The owning page with `?new=<kind>`. */
  href: string;
  permitted: (v: Viewer) => boolean;
  /** Its keyboard letter in the batch-24 sales menu (N, Q, S, O, C, L), shown beside it and pressed anywhere. */
  key?: string;
  /**
   * The action is done ON a customer (batch 24): on a customer page the shell opens it there
   * (`/dashboard/customers/<id>?new=<kind>`); elsewhere it first asks «لأي عميل؟».
   */
  onCustomer?: "activity" | "quote" | "sample";
};

const p = (v: Viewer): Permissions => v.permissions;
const hr = (sub: string) => (v: Viewer) => hasModuleAccess(p(v), "hr") && hasSubPrivilege(p(v), "hr", sub);
const ORDER: CreateAction = { id: "orders.order.new", labelAr: "طلب", labelEn: "Order", href: "/dashboard/orders?new=order", permitted: (v) => hasSubPrivilege(p(v), "orders", "create") };

/** Registry module id → the create actions that module's pages implement, in menu order. */
export const CREATE_ACTIONS: Record<string, CreateAction[]> = {
  sales: [
    // The leads page's own `?new=1` (kept from batch 0/1: shared links already use it).
    { id: "sales.lead.new", labelAr: "عميل محتمل", labelEn: "Lead", href: "/dashboard/sales/leads?new=1", permitted: (v) => hasSubPrivilege(p(v), "sales", "lead_write") },
    { id: "sales.quote.new", labelAr: "عرض سعر", labelEn: "Quotation", href: "/dashboard/sales/quotes/new", permitted: (v) => hasSubPrivilege(p(v), "sales", "quote_write") },
    // A sales order is Sales work for a seller (registry: sales.quotes.orders).
    ORDER,
  ],
  operations: [ORDER],
  hr: [
    { id: "hr.person.new", labelAr: "موظف جديد", labelEn: "New employee", href: "/dashboard/hr?new=person", permitted: hr("people_manage") },
    { id: "hr.leave.request", labelAr: "تسجيل إجازة", labelEn: "Record leave", href: "/dashboard/hr/leave?new=request", permitted: hr("leave_manage") },
    { id: "hr.leave.ledger", labelAr: "منحة / رصيد افتتاحي", labelEn: "Grant or opening balance", href: "/dashboard/hr/leave?new=ledger", permitted: hr("leave_manage") },
    { id: "hr.advance.new", labelAr: "سلفة جديدة", labelEn: "New advance", href: "/dashboard/hr/advances?new=advance", permitted: hr("advances_manage") },
    { id: "hr.applicant.new", labelAr: "متقدم جديد", labelEn: "New applicant", href: "/dashboard/hr/recruitment?new=applicant", permitted: hr("recruit") },
    { id: "hr.opening.new", labelAr: "وظيفة شاغرة", labelEn: "Job opening", href: "/dashboard/hr/recruitment?new=opening", permitted: hr("recruit") },
    { id: "hr.asset.new", labelAr: "عهدة جديدة", labelEn: "New asset", href: "/dashboard/hr/assets?new=asset", permitted: hr("assets_manage") },
    { id: "hr.payroll.run", labelAr: "مسير جديد", labelEn: "New payroll run", href: "/dashboard/hr/payroll?new=run", permitted: hr("payroll_prepare") },
    { id: "hr.policy.draft", labelAr: "مسودة سياسة جديدة", labelEn: "New policy draft", href: "/dashboard/hr/settings?new=policy", permitted: hr("policy_manage") },
  ],
};

/** The create actions of `moduleId` this viewer may use; empty outside a module. */
export function createActions(viewer: Viewer, moduleId: string | undefined): CreateAction[] {
  if (!moduleId) return [];
  return (CREATE_ACTIONS[moduleId] ?? []).filter((a) => a.permitted(viewer));
}

// ── Batch 24 WP-A: «+ جديد» everywhere for a sales user ──────────────────────────────────────
// The rep's menu (BATCH24-DESIGN §WP-A 2, mockup «زر + جديد»): نشاط N · عرض سعر Q · طلب عيّنة S · طلب O ·
// عميل جديد C · عميل محتمل L — on EVERY page, not only inside Sales. Each item is offered only when the
// API it ends at would accept it (the same checks as the customer page's buttons and the pages' own
// create buttons): nothing new is granted.
const onCustomer = (v: Viewer) => hasModuleAccess(p(v), "customers");
export const SALES_MENU: CreateAction[] = [
  { id: "sales.activity.new", key: "N", onCustomer: "activity", labelAr: "نشاط (اتصال، زيارة، واتساب)", labelEn: "Activity (call, visit, WhatsApp)", href: "/dashboard/customers",
    permitted: (v) => hasSubPrivilege(p(v), "sales", "lead_write") && onCustomer(v) },
  { id: "sales.quote.new", key: "Q", onCustomer: "quote", labelAr: "عرض سعر", labelEn: "Quotation", href: "/dashboard/sales/quotes/new",
    permitted: (v) => hasSubPrivilege(p(v), "sales", "quote_write") },
  { id: "sales.sample.new", key: "S", onCustomer: "sample", labelAr: "طلب عيّنة", labelEn: "Sample request", href: "/dashboard/customers",
    permitted: (v) => hasSubPrivilege(p(v), "sales", "lead_write") && onCustomer(v) },
  { ...ORDER, key: "O" },
  { id: "customers.customer.new", key: "C", labelAr: "عميل جديد", labelEn: "New customer", href: "/dashboard/customers?new=customer",
    permitted: (v) => canEdit(p(v), "customers") },
  { id: "sales.lead.new", key: "L", labelAr: "عميل محتمل", labelEn: "Lead", href: "/dashboard/sales/leads?new=1",
    permitted: (v) => hasSubPrivilege(p(v), "sales", "lead_write") },
];

/** «sales permissions»: the sales module with at least one way to create sales work. */
export function hasSalesMenu(viewer: Viewer): boolean {
  return hasModuleAccess(p(viewer), "sales") && SALES_MENU.some((a) => a.id !== ORDER.id && a.permitted(viewer));
}

/**
 * What «+ جديد» offers: for a sales user the sales menu (its permitted items) everywhere, followed by the
 * current module's own actions it does not already hold; for anybody else the module's actions, as before.
 * A quotation without the customers module keeps the old path (the deal picker of the quotation page).
 */
export function shellCreates(viewer: Viewer, moduleId: string | undefined): CreateAction[] {
  const own = createActions(viewer, moduleId);
  if (!hasSalesMenu(viewer)) return own;
  const menu = SALES_MENU.filter((a) => a.permitted(viewer)).map((a) => (a.onCustomer && !onCustomer(viewer) ? { ...a, onCustomer: undefined } : a));
  const ids = new Set(menu.map((a) => a.id));
  return [...menu, ...own.filter((a) => !ids.has(a.id))];
}

/** The `?new=` address of an on-customer action on that customer's page (and an order with its customer). */
export function customerActionHref(a: CreateAction, customerId: string): string {
  if (a.onCustomer) return `/dashboard/customers/${encodeURIComponent(customerId)}?new=${a.onCustomer}`;
  if (a.id === ORDER.id) return `${ORDER.href}&customerId=${encodeURIComponent(customerId)}`;
  return a.href;
}

/** `/dashboard/customers/<id>` (and only that page) → the id. */
export function customerOfPath(pathname: string): string | null {
  const m = /^\/dashboard\/customers\/([^/?#]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}
