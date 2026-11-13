// POST /api/customers/[id]/credit/override { amount, kind: ORDER | QUOTE_ORDER | DIRECT_SALE, reason } — P1 ERR-02
// «اطلب اعتماد المشرف»: after a 409 CREDIT_LIMIT, the rep asks a supervisor (customers › sales_hold, never the rep) to
// let THIS order through. Only for a customer in the caller's own book; refused when the order is within the limit.
import { NextResponse } from "@/lib/api-response";
import { requireAnyModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { requestCreditOverride } from "@/lib/services/customers/credit-limit";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAnyModule("orders", "sales", "customers");
  if (error) return error;
  const { id } = await params;
  let b: Record<string, unknown>;
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  try {
    return NextResponse.json(await requestCreditOverride(user, { customerId: id, amount: b.amount, kind: b.kind, reason: b.reason, resume: b.resume }), { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
