import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { lotTrace } from "@/lib/services/lot-trace";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/inventory/lots/:id/trace — a finished-goods lot's chain (purchase → green lot → roasting
 * batch → packaging → orders / dispatch), read from the existing relations (src/lib/services/lot-trace.ts).
 * Inventory module, read-only. The customer appears by name only (no contact record, owner policy F4).
 */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("inventory");
  if (error) return error;
  const { id } = await params;
  try {
    const t = await lotTrace(id);
    if (!t) return NextResponse.json({ error: "Lot not found." }, { status: 404 });
    return NextResponse.json(t);
  } catch (err) {
    return handlePrismaError(err);
  }
}
