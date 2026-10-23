import { NextResponse } from "@/lib/api-response";
import { requireStation } from "@/lib/services/station/http";
import { runAsStationActor } from "@/lib/auth/station-delegate";
import { POST as recordRoast } from "@/app/api/roasting-batches/route";

/**
 * POST /api/station/roasting/record + Idempotency-Key — R4 «تسجيل الدفعة» from the station. The roast
 * is recorded by the ONE roast POST the ERP uses (POST /api/roasting-batches: idempotency, capacity,
 * operators, the schedule slot, the claim), so the station and «تسجيل دفعة» can never disagree.
 *
 *  · Off a device (W1 personal session): the request goes to that handler as it is; it runs its own
 *    guard on the ERP session.
 *  · On a paired device (W2): the station guard has run (device → station session → assignment →
 *    production › start_batch → no privileged key); the body's roaster is the station's roaster, and
 *    the handler runs as the station employee (runAsStationActor) — the ERP route itself still
 *    refuses any station session sent to it over HTTP.
 */
export async function POST(request: Request) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  if (!station) return recordRoast(request);
  const data = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return NextResponse.json({ error: "بيانات الدفعة غير صالحة.", errorEn: "The roast body is not valid." }, { status: 400 });
  if (typeof data.claimId !== "string" || !data.claimId) return NextResponse.json({ error: "ابدأ المهمة من الطابور أولًا.", errorEn: "Start the task from the queue first.", code: "CLAIM_REQUIRED" }, { status: 400 });
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(request.headers.get("idempotency-key") ? { "Idempotency-Key": request.headers.get("idempotency-key")! } : {}) },
    body: JSON.stringify({ ...data, roasterId: station.roasterId }),
  });
  return runAsStationActor(user, () => recordRoast(forwarded));
}
