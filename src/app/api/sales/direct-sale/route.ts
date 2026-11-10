// «بيع مباشر» — POST: the order, its deal (WON), the invoice draft and its request to the accountant, in ONE transaction
// (services/sales/direct-sale.ts). Idempotent by body.requestKey: a second tap replays the first sale (200, replayed).
import { NextResponse } from "@/lib/api-response";
import { requireAuth, forbidden } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { AccountingError } from "@/lib/accounting/errors";
import { invError } from "@/lib/services/invoicing/refusals";
import { createDirectSale, mayDirectSell } from "@/lib/services/sales/direct-sale";

export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!mayDirectSell(user.permissions)) return forbidden();
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body.", code: "BAD_INPUT" }, { status: 400 }); }
  try {
    const r = await createDirectSale(
      { customerId: body.customerId, lines: body.lines, requestKey: body.requestKey, note: body.note, discountPercent: body.discountPercent, payment: body.payment, reference: body.reference },
      user,
      auditFromRequest(request, user.id),
    );
    return NextResponse.json(r, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    if (err instanceof AccountingError) return invError(err);
    return handleDomainError(err);
  }
}
