import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { recurringWidget } from "@/lib/accounting/recurring/widget";

/**
 * «تفاصيل المعاملات المتكررة» — the dashboard widget's data (qoyod-program/APIS.md): `tab` ALL | SALES_INVOICE |
 * PURCHASE_INVOICE | SIMPLE_BILL, `status`, `take` (1–50, default 5), `skip`. Read-only; the accounting module.
 */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json(await recurringWidget({ tab: qp(request, "tab"), status: qp(request, "status"), take: Number(qp(request, "take")) || 5, skip: Number(qp(request, "skip")) || 0 }));
  } catch (err) {
    return acctError(err);
  }
}
