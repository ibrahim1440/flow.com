import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { reconciliation } from "@/lib/accounting/ops/valuation";

/** Sub-ledgers (inventory cost, GRNI, AP) ↔ their GL control accounts, with the reconciling items. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json(await reconciliation(qp(request, "asOf")));
  } catch (err) {
    return acctError(err);
  }
}
