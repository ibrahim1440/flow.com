import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { rejectJournalEntry } from "@/lib/accounting/journal-service";

type Params = { params: Promise<{ id: string }> };

/** «رفض وإرجاع كمسودة»: SUBMITTED / APPROVED → DRAFT with a reason (the approver's duty, step-up). */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_approve");
  if (error) return error;
  const { id } = await params;
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await rejectJournalEntry(id, body.reason, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
