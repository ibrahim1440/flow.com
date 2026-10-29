import { NextResponse } from "@/lib/api-response";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { cancelSchedule } from "@/lib/accounting/deferrals";

type Params = { params: Promise<{ id: string }> };

/**
 * «إلغاء الجدول» (accounting › deferrals), with a reason: no later month is recognised; the remainder is recognised now
 * (mode RECOGNIZE_NOW, one entry — it writes the GL, so it also needs accounting › journal_post through the central gate)
 * or kept on the account (KEEP).
 */
export async function POST(request: Request, { params }: Params) {
  const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
  const { user, error } = await requireRegisterWrite("deferrals", { duties: [body.mode === "RECOGNIZE_NOW" && "journal_post"] });
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await cancelSchedule(id, { reason: body.reason, mode: body.mode, accountId: body.accountId, date: body.date }, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
