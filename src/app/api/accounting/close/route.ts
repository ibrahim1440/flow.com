import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { closeChecklist, closeHistory } from "@/lib/accounting/close";
import { refuse } from "@/lib/accounting/refusals";

/** «قائمة الإقفال» of a month: ?periodId — the checks (read-only) and the recorded reviews / closes. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const id = qp(request, "periodId");
    if (!id) throw refuse("BAD_INPUT", "periodId.");
    const [list, history] = await Promise.all([closeChecklist(id), closeHistory(id)]);
    return NextResponse.json({ ...list, history });
  } catch (err) {
    return acctError(err);
  }
}
