import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requirePackagingStation, requiredKey } from "@/lib/services/station/http";
import { handOff } from "@/lib/services/station/prep";

/**
 * POST /api/station/handoffs {orderId, orderItemIds?, stagingNote?, packages?} + Idempotency-Key — P4
 * → P6 «تسليم للشحن» (J-18): the verified units of the order (or of the lines named) handed to the
 * dispatch team, with the staging place (free text, J-16) and the parcels. Per line, partial,
 * idempotent («سُجّل التسليم مرة واحدة»). It does NOT deliver: the ERP dispatch page shows the order
 * as handed off and records the delivery (D16).
 */
export async function POST(request: Request) {
  const { user, error, station } = await requirePackagingStation("preparation");
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.orderId !== "string" || !body.orderId) return NextResponse.json({ error: "اختر الطلب.", errorEn: "Choose the order." }, { status: 400 });
  try {
    const out = await handOff({ user, orderId: body.orderId, orderItemIds: body.orderItemIds, stagingNote: body.stagingNote, packages: body.packages, key: k.key, stationId: station?.id ?? null });
    return NextResponse.json(out, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
