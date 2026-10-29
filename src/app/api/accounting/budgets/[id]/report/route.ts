import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { budgetVsActual } from "@/lib/accounting/budgets";

type Params = { params: Promise<{ id: string }> };

/** «الموازنة مقابل الفعلي»: by month and year-to-date through `through` (1–12), actuals from the general ledger. */
export async function GET(request: Request, { params }: Params) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  const { id } = await params;
  try {
    const t = qp(request, "through");
    return NextResponse.json(await budgetVsActual(id, { through: t === null || t === "" ? null : Number(t) }));
  } catch (err) {
    return acctError(err);
  }
}
