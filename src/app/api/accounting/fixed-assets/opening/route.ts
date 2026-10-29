import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireFaRead, requireFaOpening, faCan } from "@/lib/accounting/fixed-assets/http";
import { faOpeningPreview, applyFaOpening } from "@/lib/accounting/fixed-assets/opening";

/** At go-live: what the register holds that the ledger does not, and whether the opening grid carries it. */
export async function GET() {
  const { user, error } = await requireFaRead();
  if (error) return error;
  try {
    return NextResponse.json({ ...(await faOpeningPreview()), can: faCan(user.permissions) });
  } catch (err) {
    return acctError(err);
  }
}

/** Write the fixed-asset lines into the opening-balance grid (accounting › opening_balance, step-up). */
export async function POST(request: Request) {
  const { user, error } = await requireFaOpening();
  if (error) return error;
  try {
    const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
    await applyFaOpening(auditFromRequest(request, user.id, "opening fixed assets"), { confirmOtherLines: body.confirmOtherLines === true });
    return NextResponse.json(await faOpeningPreview());
  } catch (err) {
    return acctError(err);
  }
}
