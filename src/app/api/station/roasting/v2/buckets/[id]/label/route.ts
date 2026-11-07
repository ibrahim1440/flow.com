import { requireStation } from "@/lib/services/station/http";
import { v2Run } from "@/lib/services/station/roast-v2-http";
import { markLabelPrinted } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/** POST — the bucket's label was printed. */
export async function POST(_request: Request, { params }: Params) {
  const { error } = await requireStation();
  if (error) return error;
  const { id } = await params;
  return v2Run(() => markLabelPrinted(id));
}
