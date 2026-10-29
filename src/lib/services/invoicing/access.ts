// Sales invoicing A2 — who may see and do what. Pure (the screens ask the same questions as the routes).
//
//   view       sales › invoices_view, or accounting › ar (the AR clerk reads the documents it matches);
//   scope      a sales rep (sales without lead_assign, the existing data-scope rule) sees only the invoices of the
//              customers whose account they own; lead_assign holders, accounting › ar and the admin role see all;
//   create     sales › invoices_create (drafts: manual, from an order / a delivery; edit a draft);
//   issue      sales › invoices_issue — privileged: verified individual + step-up (auth-server STEP_UP_KEYS);
//   cancel     sales › invoices_cancel (a DRAFT only; an issued document is corrected by a note);
//   notes      sales › invoices_credit_note — privileged + step-up; four-eyes: the preparer does not issue it;
//   AR         accounting › ar (the accounting module is privileged as a whole: verified individual).
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { seesAllSales } from "@/lib/services/sales/scope";

type P = Permissions | Record<string, unknown>;
const sub = (p: P, m: string, s: string) => hasSubPrivilege(p as Permissions, m, s);

export const canViewInvoices = (p: P) => sub(p, "sales", "invoices_view") || canAr(p);
export const canCreateInvoices = (p: P) => sub(p, "sales", "invoices_create");
export const canIssueInvoices = (p: P) => sub(p, "sales", "invoices_issue");
export const canCancelInvoices = (p: P) => sub(p, "sales", "invoices_cancel");
export const canCreditNote = (p: P) => sub(p, "sales", "invoices_credit_note");
/** «بيع أصل ثابت» (BATCH 22 WP-F): a line selling a fixed asset needs accounting › fixed_assets (with invoices_create / issue). */
export const canSellAssets = (p: P) => hasModuleAccess(p as Permissions, "accounting") && sub(p, "accounting", "fixed_assets");
export const canAr = (p: P) => hasModuleAccess(p as Permissions, "accounting") && sub(p, "accounting", "ar");

/**
 * True when the viewer sees every customer's invoices; false = only the customers they own. By permission only
 * (the admin role's template holds lead_assign, and SIMPLE MODE gives the admin every permission).
 */
export function seesAllInvoices(p: P): boolean {
  return seesAllSales(p) || canAr(p);
}

export function abilities(p: P) {
  return {
    view: canViewInvoices(p), create: canCreateInvoices(p), issue: canIssueInvoices(p), cancel: canCancelInvoices(p),
    creditNote: canCreditNote(p), ar: canAr(p), all: seesAllInvoices(p), sellAssets: canSellAssets(p),
  };
}
