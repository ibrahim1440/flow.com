import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAuth, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { getCommissionSettings, updateCommissionSettings } from "@/lib/services/commissions/settings";

/**
 * «إعدادات العمولات» — GET for the settings managers and the plan managers (the builder shows what a
 * plan inherits); PUT for `commissions › manage_settings` only. Every save is logged (before /
 * after, actor, reason) in CommissionAuditLog, and the last changes are returned with the settings.
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  const p = user.permissions;
  if (!hasSubPrivilege(p, "commissions", "manage_settings") && !hasSubPrivilege(p, "commissions", "manage_plans")) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  try {
    const settings = await getCommissionSettings(prisma);
    const [log, opening] = await Promise.all([
      prisma.commissionAuditLog.findMany({ where: { kind: "SETTINGS" }, orderBy: { createdAt: "desc" }, take: 20 }),
      prisma.customer.groupBy({ by: ["newClientCommissionExcluded"], _count: { _all: true }, where: {} }),
    ]);
    const withPrior = await prisma.customer.count({ where: { commissionPriorOrders: { not: null } } });
    const customers = opening.reduce((n, g) => n + g._count._all, 0);
    const excluded = opening.find((g) => g.newClientCommissionExcluded)?._count._all ?? 0;
    return NextResponse.json({
      settings,
      active: !!settings.activationDate && settings.activationDate.getTime() <= Date.now(),
      opening: { customers, withPriorOrders: withPrior, excluded },
      log,
      can: { edit: hasSubPrivilege(p, "commissions", "manage_settings") },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function PUT(request: Request) {
  const { user, error } = await requireSub("commissions", "manage_settings");
  if (error) return error;
  let b: Record<string, unknown>;
  try {
    b = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  try {
    const settings = await prisma.$transaction((tx) => updateCommissionSettings(tx, {
      newClientWindow: b.newClientWindow, lapse: b.lapse, eligibility: b.eligibility, activationDate: b.activationDate,
      reason: typeof b.reason === "string" ? b.reason : null, actorId: user.id,
    }), TX_OPTS);
    return NextResponse.json({ settings });
  } catch (err) {
    return handleDomainError(err);
  }
}
