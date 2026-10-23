import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requirePackagingStation } from "@/lib/services/station/http";
import { matchForLine } from "@/lib/services/station/prep";

/**
 * POST /api/station/lots/match {orderItemId, entry} — P2/P3 (owner decision W1, J-15 manual entry):
 * the typed lot number against the lots reserved for THIS order line. The last four characters
 * only on a unique match (→ product, SKU, lot, units to count); several → «ambiguous», the full
 * number is required; none → «wrong», nothing is accepted. Read only: nothing is recorded.
 */
export async function POST(request: Request) {
  const { error } = await requirePackagingStation("preparation");
  if (error) return error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.orderItemId !== "string" || !body.orderItemId) return NextResponse.json({ error: "اختر البند.", errorEn: "Choose the order line." }, { status: 400 });
  try {
    return NextResponse.json(await matchForLine(body.orderItemId, body.entry), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
