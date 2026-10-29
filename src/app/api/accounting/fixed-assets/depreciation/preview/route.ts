import { NextResponse } from "@/lib/api-response";
import { acctError, qp } from "@/lib/accounting/http";
import { requireFaRead, faCan } from "@/lib/accounting/fixed-assets/http";
import { previewDepreciation } from "@/lib/accounting/fixed-assets/runs";

/** What the month's run would record (?year&month): per asset and category, the period's state, post or skip. */
export async function GET(request: Request) {
  const { user, error } = await requireFaRead();
  if (error) return error;
  try {
    return NextResponse.json({ ...(await previewDepreciation(qp(request, "year"), qp(request, "month"))), can: faCan(user.permissions) });
  } catch (err) {
    return acctError(err);
  }
}
