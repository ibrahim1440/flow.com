import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { closeYear } from "@/lib/accounting/close";

type Params = { params: Promise<{ year: string }> };

/** «إقفال السنة المالية»: P&L → retained earnings (CLOSING entry), December and the year closed, the next year opened. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "period_close");
  if (error) return error;
  const refused = await requireAdminAction(user, "accounting.period_close", { stepUp: true, message: "Insufficient permissions." });
  if (refused) return refused;
  const { year } = await params;
  try {
    const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
    return NextResponse.json(await closeYear(Number(year), body.note, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
