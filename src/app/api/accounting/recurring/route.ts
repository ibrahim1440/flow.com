import { NextResponse } from "@/lib/api-response";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { requireModule } from "@/lib/auth-server";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { cronSecretConfigured } from "@/lib/cron/auth";
import { listSchedules, saveSchedule } from "@/lib/accounting/recurring/schedules";
import { PHASE_2_REASON } from "@/lib/accounting/recurring/shared";
import { salesDutyRefusal } from "./_shared";

/**
 * «المعاملات المتكررة» (20261120090000_recurring_journals). GET: the list (kind, status, q, take ≤ 200, skip) with the counts,
 * how many are due now and whether the scheduler (CRON_SECRET) is configured — the accounting module. POST: a new
 * recurring transaction — accounting › recurring (the register's maintenance duty) and the document duty accounting › journal_create (and sales › invoices_create for a sales invoice).
 */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const list = await listSchedules({ kind: qp(request, "kind"), status: qp(request, "status"), text: qp(request, "q"), take: Number(qp(request, "take")) || 25, skip: Number(qp(request, "skip")) || 0 });
    return NextResponse.json({ ...list, schedulerConfigured: cronSecretConfigured(), phase2: PHASE_2_REASON });
  } catch (err) {
    return acctError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireRegisterWrite("recurring", { duties: ["journal_create"] });
  if (error) return error;
  try {
    const body = await jsonBody(request);
    const refused = salesDutyRefusal(user, body.kind);
    if (refused) return refused;
    return NextResponse.json(await saveSchedule(body, null, auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
