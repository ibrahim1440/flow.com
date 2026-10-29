import { NextResponse } from "@/lib/api-response";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { retryRun } from "@/lib/accounting/recurring/runner";

type Params = { params: Promise<{ runId: string }> };

/** «إعادة المحاولة» of a FAILED run (same run key: it never makes a second document) — accounting › recurring. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("recurring");
  if (error) return error;
  const { runId } = await params;
  try {
    return NextResponse.json(await retryRun(runId, auditFromRequest(request, user.id, "recurring run retried")));
  } catch (err) {
    return acctError(err);
  }
}
