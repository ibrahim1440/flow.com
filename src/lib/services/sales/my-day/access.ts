// «يومي» — whose day a request may read, decided on the SERVER from the session (design «Data scope rule»):
//   * no `rep`            → the caller's own day (Customer.accountOwnerId = caller), read-write;
//   * `rep=<employeeId>`  → that rep's day, READ-ONLY, and only for a team viewer (the sales manager's `lead_assign`
//                           or the admin role: `seesTeamReports`, the mark of every other team view). Anybody else is
//                           refused (403) — a rep can never be pointed at a colleague's book by a query parameter.
import type { Permissions } from "@/lib/auth-shared";
import { seesTeamReports } from "@/lib/services/sales/scope";

export type MyDayAccess =
  | { ok: true; ownerId: string; readOnly: boolean; teamView: boolean }
  | { ok: false; status: 403 | 400; error: string; errorAr: string };

export function resolveMyDayOwner(user: { id: string; role?: string | null; permissions: Permissions | Record<string, unknown> }, rep: string | null): MyDayAccess {
  const teamView = seesTeamReports(user.permissions, user.role);
  const asked = rep?.trim() || null;
  if (!asked || asked === user.id) return { ok: true, ownerId: user.id, readOnly: false, teamView };
  if (!teamView) return { ok: false, status: 403, error: "Only a sales manager may open another rep's day.", errorAr: "فتح يوم مندوب آخر للمدير فقط." };
  if (asked.length > 64 || !/^[A-Za-z0-9_-]+$/.test(asked)) return { ok: false, status: 400, error: "rep is not an employee id.", errorAr: "المندوب غير صحيح." };
  return { ok: true, ownerId: asked, readOnly: true, teamView };
}
