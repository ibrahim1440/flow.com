import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { postJournalEntry } from "@/lib/accounting/journal-service";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_post");
  if (error) return error;
  // Defense in depth: there is no role hierarchy above "admin" yet (see saas-readiness.md).
  // The admin role is privileged: the same verified-individual gate, with a recent step-up.
  const refused = await requireAdminAction(user, "accounting.journal_post", { stepUp: true, message: "Insufficient permissions." });
  if (refused) return refused;
  const { id } = await params;
  try {
    return NextResponse.json(await postJournalEntry(id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
