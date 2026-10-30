import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { privilegedGate, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { resolveMyDayOwner } from "@/lib/services/sales/my-day/access";
import { loadMyDay } from "@/lib/services/sales/my-day/load";

/**
 * GET /api/sales/my-day[?rep=<employeeId>] — «يومي», the rep's day (BATCH24-DESIGN.md §WP-B).
 *
 * Whose day: decided here from the session (`resolveMyDayOwner`): the caller's own, or — for a team viewer only — the
 * named rep's, read-only. A rep with no customers gets empty cards, never the whole book.
 *
 * The commission figures follow the commission routes: one's own needs `commissions › view_own` (and its gate), another
 * rep's `commissions › view_team`. Without it they are null and `commissionVisible` is false.
 */
export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  const access = resolveMyDayOwner(user, new URL(request.url).searchParams.get("rep"));
  if (!access.ok) return NextResponse.json({ error: access.error, errorAr: access.errorAr }, { status: access.status });

  const perms = user.permissions as Permissions;
  const may = async (sub: "view_team" | "view_own") =>
    hasSubPrivilege(perms, "commissions", sub) && (await privilegedGate(user, "commissions", sub)) === null;
  const commissionVisible = access.ownerId === user.id ? (await may("view_own")) || (await may("view_team")) : await may("view_team");

  try {
    const day = await loadMyDay(prisma, { ownerId: access.ownerId, viewerId: user.id, commissionVisible });
    if (!day.rep) return NextResponse.json({ error: "Not found.", errorAr: "المندوب غير موجود." }, { status: 404 });
    return NextResponse.json({ ...day, viewerId: user.id, readOnly: access.readOnly, teamView: access.teamView });
  } catch (err) {
    return handleDomainError(err);
  }
}
