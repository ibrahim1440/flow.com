import { requireRoastToStock, stockRun } from "@/lib/services/production/stock-http";
import { setDefaultGreen } from "@/lib/services/production/stock-orders";

type Params = { params: Promise<{ id: string }> };
/** PATCH {greenBeanId | null} — «الدفعة الخضراء الافتراضية»: an active green lot with stock; audited. */
export async function PATCH(request: Request, { params }: Params) {
  const { actor, error } = await requireRoastToStock({ write: true });
  if (error) return error;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const g = typeof body.greenBeanId === "string" && body.greenBeanId ? body.greenBeanId : null;
  return stockRun(() => setDefaultGreen(actor, id, g));
}
