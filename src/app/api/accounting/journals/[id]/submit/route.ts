import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { submitJournalEntry } from "@/lib/accounting/journal-service";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_submit");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await submitJournalEntry(id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
