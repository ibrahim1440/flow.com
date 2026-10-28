import { NextResponse } from "@/lib/api-response";
import { requireAuth, stockChangeGate } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { abandonClaim } from "@/lib/accounting/ops/supplier-claims";

type Params = { params: Promise<{ id: string }> };

/**
 * «التنازل عن المطالبة» — { reason ≥ 3 }: what is open becomes a purchase shortage loss (and, with the setting — default
 * on — its input VAT is reversed). A stock write-off: inventory › adjust through the stock-change gate (step-up).
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await stockChangeGate(user, "inventory", "adjust");
  if (refused) return refused;
  try {
    const b = await jsonBody(request);
    const reason = String(b.reason ?? "");
    return NextResponse.json(await abandonClaim((await params).id, reason, auditFromRequest(request, user.id, reason)));
  } catch (err) {
    return acctError(err);
  }
}
