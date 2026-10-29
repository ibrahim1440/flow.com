import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { acctError } from "@/lib/accounting/http";
import { deferralBacklog, deferralReconciliation, dueMonths } from "@/lib/accounting/deferrals";
import { prisma } from "@/lib/db";

/** «قوالب التأجيل» overview: the months due, the balance-sheet reconciliation, the dimensions and what the viewer may do. */
export async function GET() {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  try {
    const can = (sub: string) => hasSubPrivilege(user.permissions, "accounting", sub);
    const [due, reconciliation, backlog, branches, costCenters, s] = await Promise.all([
      dueMonths(), deferralReconciliation(), deferralBacklog(),
      prisma.finBranch.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true } }),
      prisma.finCostCenter.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true } }),
      prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true, goLiveDate: true } }),
    ]);
    return NextResponse.json({
      due, reconciliation, backlog, branches, costCenters,
      accounting: { active: !!s?.accountingActive, goLiveDate: s?.goLiveDate ? s.goLiveDate.toISOString().slice(0, 10) : null },
      can: { manage: can("deferrals"), run: can("journal_post"), reverse: can("journal_reverse"), post: can("deferrals") && can("journal_post") },
    });
  } catch (err) {
    return acctError(err);
  }
}
