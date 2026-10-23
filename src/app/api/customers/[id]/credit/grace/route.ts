import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { parseGraceInput } from "@/lib/services/customers/credit";
import { placeGrace } from "@/lib/services/customers/credit-db";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/customers/[id]/credit/grace — «أيام سماح» (customers › sales_hold): { days 1–90,
 * reason?, confirmRepeat? }. Records the grace on the customer and in its credit log; places no
 * hold. A customer that had a grace before needs `confirmRepeat: true` (409
 * GRACE_REPEAT_UNCONFIRMED carries the count and the last one). Refused while a hold is in force.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("customers", "sales_hold");
  if (error) return error;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parseGraceInput(body ?? {});
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, errorEn: parsed.errorEn, code: parsed.code }, { status: parsed.status });
  try {
    const result = await prisma.$transaction((tx) => placeGrace(tx, { customerId: id, actorId: user.id, ...parsed.value, now: new Date() }), TX_OPTS);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // The repeat refusal carries the history the dialog shows.
    if (err && typeof err === "object" && (err as { code?: string }).code === "GRACE_REPEAT_UNCONFIRMED") {
      const e = err as { message: string; errorEn: string; graces: unknown };
      return NextResponse.json({ error: e.message, errorEn: e.errorEn, code: "GRACE_REPEAT_UNCONFIRMED", graces: e.graces }, { status: 409 });
    }
    return handleDomainError(err);
  }
}
