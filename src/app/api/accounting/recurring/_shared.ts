// The recurring routes' shared checks (not a route: Next.js serves only route.ts files).
import { forbidden } from "@/lib/auth-server";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

/** A recurring SALES INVOICE is also the sales duty of creating invoices (sales › invoices_create). */
export function salesDutyRefusal(user: { permissions: Permissions }, kind: unknown) {
  if (kind !== "SALES_INVOICE") return null;
  return hasModuleAccess(user.permissions, "sales") && hasSubPrivilege(user.permissions, "sales", "invoices_create") ? null : forbidden();
}
