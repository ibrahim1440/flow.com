import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, privilegedGate, requireAuth } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { canDecideCommission, decideAccountingQuoteCommission } from "@/lib/services/sales/accounting-quote-commission";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/quotes/[id]/commission — «عمولة عرض المحاسب»: { decision: "ASSIGNED" | "NONE", reason }. A sales
 * supervisor (sales › lead_assign) or an accounting supervisor (accounting › supervise) — the owner through the same keys — on an
 * accountant's quotation for a rep's customer still PENDING and with nothing paid against it.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canDecideCommission(user.permissions)) return forbidden();
  // The gate of the key exercised (the accounting module is privileged as a whole).
  const refused = hasSubPrivilege(user.permissions, "sales", "lead_assign") ? await privilegedGate(user, "sales", "lead_assign") : await privilegedGate(user, "accounting", "supervise");
  if (refused) return refused;
  const { id } = await params;
  const b = (await request.json().catch(() => ({}))) as { decision?: unknown; reason?: unknown };
  try {
    const r = await prisma.$transaction((tx) => decideAccountingQuoteCommission(tx, { quoteId: id, decision: b.decision, reason: b.reason, actor: { id: user.id, permissions: user.permissions } }), TX_OPTS);
    return NextResponse.json(r);
  } catch (err) {
    return handleDomainError(err);
  }
}
