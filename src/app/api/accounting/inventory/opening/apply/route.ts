import { NextResponse } from "@/lib/api-response";
import { requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { applyOpening, openingPreview } from "@/lib/accounting/ops/valuation";

/** Apply the valuation to the cost ledger and the opening-balance grid (repeatable until the opening is posted). Step-up. */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "opening_balance");
  if (error) return error;
  const refused = await requirePrivilegedAction(user, "accounting.opening_inventory", { stepUp: true });
  if (refused) return refused;
  try {
    const r = await applyOpening(auditFromRequest(request, user.id, "opening inventory valuation"));
    return NextResponse.json({ result: r, opening: await openingPreview() }, { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
