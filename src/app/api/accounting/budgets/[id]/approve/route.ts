import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { approveBudget } from "@/lib/accounting/budgets";

type Params = { params: Promise<{ id: string }> };

/** «اعتماد» (accounting › journal_approve, the central gate: verified individual + step-up): DRAFT → APPROVED, locked from here; a revision archives the version it replaces. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_approve");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await approveBudget(id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
