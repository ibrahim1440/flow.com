import { requireStation } from "@/lib/services/station/http";
import { v2Run } from "@/lib/services/station/roast-v2-http";
import { sessionBuckets } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/** GET — a prep session's buckets and the leftovers still in staging (D12 P3). */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireStation();
  if (error) return error;
  const { id } = await params;
  return v2Run(() => sessionBuckets(id));
}
