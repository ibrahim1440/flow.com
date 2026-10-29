// «عروض الأسعار» from the accounting section (BATCH22 WP-E; owner answer 3). Pure and client-safe: the quote routes, the
// accountant sidebar's «+ عرض سعر» and the pages ask the same two questions.
//
//   · READ  — the sales module OR the accounting module. The accountant sees every quotation (the accounting scope sees
//             every customer, like `accounting › ar`); a rep still sees only their own deals.
//   · WRITE — `sales › quote_write`, OR the accounting module AND `accounting › quotes_issue` (a grantable key, adminOnly
//             in the backfill; not privileged: a quote is not a ledger or tax document). The accountant quotes on an
//             EXISTING OPEN deal and never creates one (the deal owner decides commission attribution). Discount
//             approval, accept / reject and the order stay with Sales.
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

export function canViewQuotes(p: Permissions): boolean {
  return hasModuleAccess(p, "sales") || hasModuleAccess(p, "accounting");
}

export function canWriteQuotes(p: Permissions): boolean {
  return hasSubPrivilege(p, "sales", "quote_write") || (hasModuleAccess(p, "accounting") && hasSubPrivilege(p, "accounting", "quotes_issue"));
}

/** Writes through the accounting key only (no sales › quote_write): the deal must be open, and its owner is told. */
export function writesViaAccounting(p: Permissions): boolean {
  return !hasSubPrivilege(p, "sales", "quote_write") && canWriteQuotes(p);
}

/** Every deal's quotations (a sales manager — lead_assign — or the accounting module). */
export function quotesSeeAll(p: Permissions): boolean {
  return hasSubPrivilege(p, "sales", "lead_assign") || hasModuleAccess(p, "accounting");
}
