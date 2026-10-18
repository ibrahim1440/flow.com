import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
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
