import { NextResponse } from "next/server";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { lockFiscalPeriod } from "@/lib/accounting/fiscal-period-service";
import { AccountingError } from "@/lib/accounting/errors";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "period_lock");
  if (error) return error;
  // Defense in depth: there is no role hierarchy above "admin" yet (see saas-readiness.md),
  // so period control is additionally restricted to admin regardless of sub-privilege grants.
  // The admin role is privileged: the same verified-individual gate, with a recent step-up.
  const refused = await requireAdminAction(user, "accounting.period_lock", { stepUp: true, message: "Insufficient permissions." });
  if (refused) return refused;

  const { id } = await params;

  try {
    const period = await lockFiscalPeriod(id, user.id);
    return NextResponse.json(period);
  } catch (err) {
    if (err instanceof AccountingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return handlePrismaError(err);
  }
}
