// Accounting A3 — who may reach the inventory-cost and AP endpoints (the routes re-check every duty; the pages'
// controls are conveniences):
//   • cost reads (valuation, batch costs, reconciliation): inventory › valuation, or the accounting module;
//   • AP reads: the accounting module, or purchases › invoices (the clerk sees the invoices and receipts);
//   • supplier-invoice drafts (create, edit, delete, submit): purchases › invoices — operational, no gate — or
//     accounting › ap (privileged: a verified individual, no step-up for a draft);
//   • posting, cancelling, paying, voiding: accounting › ap through requireSub (verified individual + step-up).
import { acctCsvCell } from "../csv";
import { NextResponse } from "@/lib/api-response";
import { forbidden, requireAuth, requirePrivilegedAction } from "@/lib/auth-server";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";

type Gate = Promise<{ user: Awaited<ReturnType<typeof requireAuth>>["user"]; error: NextResponse | null }>;

export async function requireCostRead(): Gate {
  const { user, error } = await requireAuth();
  if (error) return { user, error };
  if (hasModuleAccess(user.permissions, "accounting") || hasSubPrivilege(user.permissions, "inventory", "valuation")) return { user, error: null };
  return { user, error: forbidden() };
}

export async function requireApRead(): Gate {
  const { user, error } = await requireAuth();
  if (error) return { user, error };
  if (hasModuleAccess(user.permissions, "accounting") || hasSubPrivilege(user.permissions, "purchases", "invoices")) return { user, error: null };
  return { user, error: forbidden() };
}

export async function requireDraftWriter(): Gate {
  const { user, error } = await requireAuth();
  if (error) return { user, error };
  if (hasSubPrivilege(user.permissions, "purchases", "invoices")) return { user, error: null };
  if (!hasSubPrivilege(user.permissions, "accounting", "ap")) return { user, error: forbidden() };
  const refused = await requirePrivilegedAction(user, "accounting.ap", { stepUp: false });
  return { user, error: refused };
}

// A5 council fix: formulas neutralised (CWE-1236), numbers kept (../csv.ts).
export const csvCell = (v: string | number | null | undefined) => acctCsvCell(v);

export function csvResponse(name: string, head: string[], rows: (string | number | null | undefined)[][]): NextResponse {
  return new NextResponse("﻿" + [head.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` } });
}
