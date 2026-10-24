import { NextResponse } from "@/lib/api-response";
import { requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { acctError } from "@/lib/accounting/http";
import { getOpening, postOpening } from "@/lib/accounting/opening";
import { auditFromRequest } from "@/lib/accounting/audit";

/** Post the grid ONCE as the OPENING entry at the go-live date (difference → opening balance equity). Step-up. */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "opening_balance");
  if (error) return error;
  const refused = await requirePrivilegedAction(user, "accounting.opening_post", { stepUp: true });
  if (refused) return refused;
  try {
    const r = await postOpening(auditFromRequest(request, user.id, "post opening balances"));
    return NextResponse.json({ result: r, opening: await getOpening() }, { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
