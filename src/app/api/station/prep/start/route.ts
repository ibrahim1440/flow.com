import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requirePackagingStation, requiredKey } from "@/lib/services/station/http";
import { startPrep } from "@/lib/services/station/prep";

/**
 * POST /api/station/prep/start {orderId} + Idempotency-Key — P1 «بدء تجهيز #…»: the order is claimed
 * for the caller (WorkItemClaim). Moves no stock. Refused for an order on hold or not ready.
 */
export async function POST(request: Request) {
  const { user, error } = await requirePackagingStation("preparation");
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.orderId !== "string" || !body.orderId) return NextResponse.json({ error: "اختر الطلب من الطابور.", errorEn: "Choose the order from the queue." }, { status: 400 });
  try {
    const out = await startPrep({ user, orderId: body.orderId, key: k.key });
    return NextResponse.json(out, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
