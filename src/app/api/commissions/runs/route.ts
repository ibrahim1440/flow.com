import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { requireAnySub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { riyadhMonthStart, riyadhMonthEnd } from "@/lib/services/commissions/engine";
import { runBuilderMonth } from "@/lib/services/commissions/accrual";
import { serializePeriod } from "@/lib/services/commissions/builder-period";
import { getCommissionSettings } from "@/lib/services/commissions/settings";

/**
 * POST /api/commissions/runs — the monthly run of the COMPONENTS plans («احتساب الشهر»).
 *
 * For every employee whose assignment in the month is a COMPONENTS version (or the one named),
 * recompute A, B and C on the month's collected and approved money and post the difference to the
 * ledger through the existing engine (runBuilderMonth → recomputeEmployeePeriod → postDelta).
 * Idempotent: a second run posts nothing; a collection reversed since the last run comes back
 * as a negative movement. Tiered plans are not touched (they are computed per collection, as before).
 *
 * Who: the approvers (`commissions › approve`) and the plan managers (`manage_plans`). A run is
 * the plan's arithmetic — nothing is decided or approved by it — so it may include the caller;
 * the discretionary decision, the approval and the payout keep their own rules.
 */
export async function POST(request: Request) {
  // Either privileged sub; requireAnySub applies the verified-individual gate of the one held.
  const { user, error } = await requireAnySub("commissions", ["approve", "manage_plans"]);
  if (error) return error;
  let b: Record<string, unknown> = {};
  try {
    b = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const month = typeof b.month === "string" ? b.month : "";
  if (!/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: "month must look like 2026-09." }, { status: 400 });
  const at = new Date(`${month}-15T00:00:00Z`);
  const periodStart = riyadhMonthStart(at);
  const periodEnd = riyadhMonthEnd(at);
  if (periodStart.getTime() > Date.now()) {
    return NextResponse.json({ error: "A month that has not started cannot be run." }, { status: 400 });
  }

  // Owner decision: no run before the commission activation date is set — the opening setup comes first.
  const settings = await getCommissionSettings(prisma);
  if (!settings.activationDate) {
    return NextResponse.json({
      error: "لم يُحدَّد تاريخ تفعيل العمولات بعد. أكمل «تهيئة العملاء الحاليين قبل تفعيل العمولات» ثم حدّد تاريخ التفعيل في «إعدادات العمولات».",
      errorEn: "The commission activation date is not set. Complete the opening setup of existing customers, then set the activation date in the commission settings.",
      code: "COMMISSION_NOT_ACTIVATED",
    }, { status: 409 });
  }
  try {
    const assigned = await prisma.commissionAssignment.findMany({
      where: {
        ...(typeof b.employeeId === "string" && b.employeeId ? { employeeId: b.employeeId } : {}),
        effectiveFrom: { lt: periodEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart } }],
        planVersion: { components: { not: Prisma.DbNull } },
      },
      select: { employeeId: true },
      distinct: ["employeeId"],
    });
    const results = [];
    for (const { employeeId } of assigned) {
      // One transaction per employee: one person's failure (a currency refusal, say) is theirs alone.
      try {
        const r = await prisma.$transaction((tx) => runBuilderMonth(tx, employeeId, at, user.id), TX_OPTS);
        if (!r) continue;
        results.push({
          employeeId, posted: r.posted, unposted: r.unposted, againstApproved: r.againstApproved,
          delta: r.delta.toFixed(2), result: serializePeriod(r.builder),
        });
      } catch (err) {
        const e = err as { message?: string };
        results.push({ employeeId, error: e?.message ?? "failed" });
      }
    }
    return NextResponse.json({ month, periodStart, periodEnd, employees: results.length, results });
  } catch (err) {
    return handleDomainError(err);
  }
}
