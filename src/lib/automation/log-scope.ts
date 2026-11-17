// Who may open «سجل الرسائل» and «الأرشيف» at all (fix round 2, council b25 seat 5 N5): the automation module, a sales
// holder, or a customer manager — the audience the log was opened to. R1-e (owner decisions 0–6) narrows WHAT each of
// them reads to the departments they hold (lib/automation/message-access.ts); this gate keeps anybody else out, so the
// department rule never widens the log to a new audience (a dispatch or roasting login holds orders / production, but
// never read the log and still does not).
import { hasModuleAccess, type Permissions } from "@/lib/auth-shared";
import { seesAllSales } from "@/lib/services/sales/scope";
import { isCustomerManager } from "@/lib/services/customers/email-consent";

type Viewer = { id: string; role?: string | null; permissions: Permissions | Record<string, unknown> };

/** all — the automation module; customers — a customer / sales manager; book — any other sales holder; null — no entry. */
export function logScopeKind(user: Viewer): "all" | "customers" | "book" | null {
  const p = user.permissions as Permissions;
  if (hasModuleAccess(p, "automation")) return "all";
  if (isCustomerManager(user) || (hasModuleAccess(p, "sales") && seesAllSales(p))) return "customers";
  if (hasModuleAccess(p, "sales")) return "book";
  return null;
}

/** May this viewer open the log at all (before the department rule)? */
export const opensMessageLog = (user: Viewer) => user.role === "admin" || logScopeKind(user) !== null;
