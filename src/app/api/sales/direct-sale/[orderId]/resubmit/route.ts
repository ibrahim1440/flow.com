// POST /api/sales/direct-sale/[orderId]/resubmit — after a refused discount, the rep sends the sale again: { discountPercent }.
// At or under the threshold it completes now; above it, it waits for a supervisor again (resubmitDirectSale).
import { NextResponse } from "@/lib/api-response";
import { requireAuth, forbidden } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { AccountingError } from "@/lib/accounting/errors";
import { invError } from "@/lib/services/invoicing/refusals";
import { mayDirectSell, resubmitDirectSale } from "@/lib/services/sales/direct-sale";

type Params = { params: Promise<{ orderId: string }> };

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!mayDirectSell(user.permissions)) return forbidden();
  const { orderId } = await params;
  let b: Record<string, unknown>;
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  try {
    return NextResponse.json(await resubmitDirectSale({ orderId, discountPercent: b.discountPercent, actor: user, ctx: auditFromRequest(request, user.id) }));
  } catch (err) {
    if (err instanceof AccountingError) return invError(err);
    return handleDomainError(err);
  }
}
