import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { privilegedGate, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { seesAllSales } from "@/lib/services/sales/scope";
import { monthPeriod, performanceSummary } from "@/lib/services/sales/performance";

/**
 * GET /api/sales/performance?month=YYYY-MM[&employeeId=…] — «لوحة الأداء».
 *
 * The month's figures of the team and of each rep, computed from deals, leads, quotations,
 * recorded collections, targets and the commission ledger (formulas: lib/services/sales/
 * performance.ts). Read-only; nothing is stored.
 *
 * Scope is the sales reports' and the targets': `sales` module to open it at all; somebody who
 * sees all sales (`lead_assign`) sees every rep and may narrow to one with `employeeId`; anybody
 * else sees themselves only, whatever `employeeId` says.
 *
 * The commission column follows the commission routes exactly: the whole team's needs what
 * GET /api/commissions/review needs (`commissions › view_team` and its gate), one's own what
 * GET /api/commissions/me needs (`commissions › view_own` and its gate). Without it the figure is
 * null and `commissionVisible` false — the screen says so instead of showing zero.
 */
export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const url = new URL(request.url);
  const period = monthPeriod(url.searchParams.get("month"));
  if (!period) return NextResponse.json({ error: "month must look like 2026-09." }, { status: 400 });

  const perms = user.permissions as Permissions;
  const all = seesAllSales(perms);
  const asked = url.searchParams.get("employeeId");
  const ownerId = all ? (asked || null) : user.id;

  const may = async (sub: "view_team" | "view_own") =>
    hasSubPrivilege(perms, "commissions", sub) && (await privilegedGate(user, "commissions", sub)) === null;
  // Another person's commission needs view_team; one's own needs view_own (or view_team).
  let commission: "all" | "own" | "none" = "none";
  if (await may("view_team")) commission = "all";
  else if (await may("view_own")) commission = "own";

  try {
    const summary = await performanceSummary(prisma, {
      start: period.start, end: period.end, month: period.month,
      ownerId, selfId: user.id, commission,
    });
    // A team viewer with only view_own sees their own commission in their own row; the team
    // total of a column they cannot fully read would be a partial sum, so it stays null.
    if (commission === "own" && summary.scope === "all") summary.totals.commissionAccrued = null;
    return NextResponse.json({
      ...summary,
      viewerId: user.id,
      teamView: all,
      notice: summary.sandbox
        ? "Collections this month come from the sandbox source. No real payment has been received."
        : null,
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
