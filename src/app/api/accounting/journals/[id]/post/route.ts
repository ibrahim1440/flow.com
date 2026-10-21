import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { postJournalEntry } from "@/lib/accounting/journal-service";
import { AccountingError, accountingErrorJson } from "@/lib/accounting/errors";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_post");
  if (error) return error;
  // Defense in depth: there is no role hierarchy above "admin" yet (see saas-readiness.md).
  // The admin role is privileged: the same verified-individual gate, with a recent step-up.
  const refused = await requireAdminAction(user, "accounting.journal_post", { stepUp: true, message: "Insufficient permissions." });
  if (refused) return refused;

  const { id } = await params;

  try {
    const entry = await postJournalEntry(id, user.id);
    return NextResponse.json(entry);
  } catch (err) {
    if (err instanceof AccountingError) {
      return NextResponse.json(accountingErrorJson(err), { status: err.status });
    }
    return handlePrismaError(err);
  }
}
