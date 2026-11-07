import { requireStation } from "@/lib/services/station/http";
import { v2Run } from "@/lib/services/station/roast-v2-http";
import { prepPlan } from "@/lib/services/station/roast-v2";

/** GET ?bucketKg= — the prep plan (D12 P1): today's queue per coffee, in green kg and suggested buckets. */
export async function GET(request: Request) {
  const { error } = await requireStation();
  if (error) return error;
  const kg = Number(new URL(request.url).searchParams.get("bucketKg"));
  return v2Run(() => prepPlan(Number.isFinite(kg) && kg > 0 ? kg : undefined));
}
