import { NextResponse } from "@/lib/api-response";
import { requireModule, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { getOpening, replaceOpeningLines, type OpeningLineInput } from "@/lib/accounting/opening";
import { auditFromRequest } from "@/lib/accounting/audit";
import { refuse } from "@/lib/accounting/refusals";

/** «الأرصدة الافتتاحية»: the grid, its totals and difference, the go-live date and whether it is posted. */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json(await getOpening());
  } catch (err) {
    return acctError(err);
  }
}

/** Replace the grid (manual entry). Frozen once posted (the database refuses too). */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("accounting", "opening_balance");
  if (error) return error;
  try {
    const body = await jsonBody(request);
    if (!Array.isArray(body.lines)) throw refuse("BAD_INPUT", "lines is an array.");
    await replaceOpeningLines(body.lines as OpeningLineInput[], auditFromRequest(request, user.id));
    return NextResponse.json(await getOpening());
  } catch (err) {
    return acctError(err);
  }
}
