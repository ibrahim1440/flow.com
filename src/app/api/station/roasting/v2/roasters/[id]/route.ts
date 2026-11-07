import { requireStation } from "@/lib/services/station/http";
import { v2Run } from "@/lib/services/station/roast-v2-http";
import { roasterState } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/** GET — the roaster's drum, its baskets waiting for the scale, and whether a charge would pass. */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireStation();
  if (error) return error;
  const { id } = await params;
  return v2Run(() => roasterState(id));
}
