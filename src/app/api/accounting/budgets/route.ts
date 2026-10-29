import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { createBudget, listBudgets } from "@/lib/accounting/budgets";
import { prisma } from "@/lib/db";

/** «الموازنات»: the budgets (filters year, status), the branches a budget may name and what the viewer may do. */
export async function GET(request: Request) {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  try {
    const year = Number(qp(request, "year")) || null;
    const [items, branches] = await Promise.all([
      listBudgets({ year, status: qp(request, "status") }),
      prisma.finBranch.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true } }),
    ]);
    const can = (sub: string) => hasSubPrivilege(user.permissions, "accounting", sub);
    return NextResponse.json({ items, branches, can: { prepare: can("budgets"), approve: can("journal_approve") }, viewer: { id: user.id } });
  } catch (err) {
    return acctError(err);
  }
}

/** «موازنة جديدة» (accounting › budgets): a DRAFT, optionally with its grid. */
export async function POST(request: Request) {
  const { user, error } = await requireRegisterWrite("budgets");
  if (error) return error;
  try {
    return NextResponse.json(await createBudget(await jsonBody(request), auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
