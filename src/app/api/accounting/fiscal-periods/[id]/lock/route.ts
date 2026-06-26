import { NextResponse } from "next/server";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { lockFiscalPeriod } from "@/lib/accounting/fiscal-period-service";
import { AccountingError } from "@/lib/accounting/errors";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "period_lock");
  if (error) return error;
  // Defense in depth: there is no role hierarchy above "admin" yet (see saas-readiness.md),
  // so period control is additionally restricted to admin regardless of sub-privilege grants.
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }

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
