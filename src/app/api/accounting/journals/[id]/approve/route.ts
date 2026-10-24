import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { approveJournalEntry } from "@/lib/accounting/journal-service";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";

type Params = { params: Promise<{ id: string }> };

/** Approve a submitted journal — never its own preparer's (four-eyes; SIMPLE MODE allows it and records it). */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_approve");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await approveJournalEntry(id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
