import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { parseLiftInput } from "@/lib/services/customers/credit";
import { liftHold } from "@/lib/services/customers/credit-db";

type Params = { params: Promise<{ id: string }> };

/** POST /api/customers/[id]/credit/lift — «رفع الإيقاف» by hand (customers › sales_hold), { reason }. Logged. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("customers", "sales_hold");
  if (error) return error;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parseLiftInput(body ?? {});
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, errorEn: parsed.errorEn, code: parsed.code }, { status: parsed.status });
  try {
    const lifted = await prisma.$transaction((tx) => liftHold(tx, { customerId: id, actorId: user.id, reason: parsed.value.reason, now: new Date() }), TX_OPTS);
    return NextResponse.json(lifted);
  } catch (err) {
    return handleDomainError(err);
  }
}
