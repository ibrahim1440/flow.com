import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { parseHoldInput } from "@/lib/services/customers/credit";
import { placeHold } from "@/lib/services/customers/credit-db";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/customers/[id]/credit/hold — «إيقاف البيع» (customers › sales_hold; owner design: holds
 * are manual only). { reason, days 1–365 | untilPaid: true, autoLiftAtEnd?, autoLiftOnPayment? }.
 * While it is in force every path that creates a quotation or an order for the customer refuses
 * 409 CUSTOMER_SALES_HOLD; existing orders and deliveries continue. Logged.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("customers", "sales_hold");
  if (error) return error;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parseHoldInput(body ?? {});
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, errorEn: parsed.errorEn, code: parsed.code }, { status: parsed.status });
  try {
    const hold = await prisma.$transaction((tx) => placeHold(tx, { customerId: id, actorId: user.id, hold: parsed.value, now: new Date() }), TX_OPTS);
    return NextResponse.json({ hold }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
