import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { lastYearActuals } from "@/lib/accounting/budgets";
import { refuse } from "@/lib/accounting/refusals";

/** «نسخ من فعلي السنة السابقة»: the year before `year`'s P&L actuals (the branch's, with branchId) as a budget grid. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const year = Number(qp(request, "year"));
    if (!Number.isInteger(year)) throw refuse("BAD_INPUT", "year.");
    return NextResponse.json(await lastYearActuals(year, qp(request, "branchId")));
  } catch (err) {
    return acctError(err);
  }
}
