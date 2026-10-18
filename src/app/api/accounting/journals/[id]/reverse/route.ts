import { NextResponse } from "next/server";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { reverseJournalEntry } from "@/lib/accounting/journal-service";
import { AccountingError, accountingErrorJson } from "@/lib/accounting/errors";

type Params = { params: Promise<{ id: string }> };
const REASON_MAX_LENGTH = 500;

export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_reverse");
  if (error) return error;
  // Defense in depth: there is no role hierarchy above "admin" yet (see saas-readiness.md).
  // The spec requires reversal to be gated by explicit permission + mandatory reason; admin-only
  // is the strictest interpretation available without a dedicated Role model.
  // The admin role is privileged: the same verified-individual gate, with a recent step-up.
  const refused = await requireAdminAction(user, "accounting.journal_reverse", { stepUp: true, message: "Insufficient permissions." });
  if (refused) return refused;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { reason } = (body ?? {}) as { reason?: unknown };
  if (typeof reason !== "string" || !reason.trim()) {
    return NextResponse.json({ error: "reason is required to reverse a journal entry." }, { status: 400 });
  }
  if (reason.length > REASON_MAX_LENGTH) {
    return NextResponse.json({ error: `reason must be at most ${REASON_MAX_LENGTH} characters.` }, { status: 400 });
  }

  try {
    const reversal = await reverseJournalEntry(id, user.id, reason);
    return NextResponse.json(reversal, { status: 201 });
  } catch (err) {
    if (err instanceof AccountingError) {
      return NextResponse.json(accountingErrorJson(err), { status: err.status });
    }
    return handlePrismaError(err);
  }
}
