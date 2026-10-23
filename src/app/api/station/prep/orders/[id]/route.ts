import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requirePackagingStation } from "@/lib/services/station/http";
import { prepOrder } from "@/lib/services/station/prep";

/** GET /api/station/prep/orders/[id] — one order at the preparation tab (P2–P4, P6, P7). Read only. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { error } = await requirePackagingStation("preparation");
  if (error) return error;
  const { id } = await ctx.params;
  try {
    const o = await prepOrder(id);
    if (!o) return NextResponse.json({ error: "الطلب غير موجود أو لا بنود فيه للتجهيز.", errorEn: "Order not found, or nothing in it to prepare." }, { status: 404 });
    return NextResponse.json(o, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
