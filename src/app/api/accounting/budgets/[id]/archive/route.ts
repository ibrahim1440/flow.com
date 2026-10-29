import { NextResponse } from "@/lib/api-response";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { archiveBudget } from "@/lib/accounting/budgets";
import { journalDutyGate, requireRegisterWrite } from "@/lib/accounting/register-access";
import { prisma } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

/**
 * «أرشفة» (accounting › budgets — the register's maintenance duty): a draft or an approved budget → ARCHIVED (final).
 * Archiving an APPROVED budget withdraws an approval, so it also needs accounting › journal_approve through the central
 * gate (verified individual + step-up), like approving it.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("budgets");
  if (error) return error;
  const { id } = await params;
  const b = await prisma.glBudget.findUnique({ where: { id }, select: { status: true } });
  if (b?.status === "APPROVED") {
    const refused = await journalDutyGate(user, "journal_approve");
    if (refused) return refused;
  }
  try {
    return NextResponse.json(await archiveBudget(id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
