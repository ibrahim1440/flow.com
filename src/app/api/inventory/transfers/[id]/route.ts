import { NextResponse } from "@/lib/api-response";
import { requireAnyModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { getTransfer } from "@/lib/services/stock-transfers";
import { canReadCost } from "@/lib/services/transfer-shortfall-gate";

type Params = { params: Promise<{ id: string }> };

/**
 * GET — the transfer, its lines (items, quantities; the value at cost and the cost moves for a cost reader only —
 * accounting, or inventory › valuation), its movements and its activity log.
 */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireAnyModule("inventory", "packaging", "production");
  if (error) return error;
  try {
    const t = await getTransfer((await params).id, { costs: canReadCost(user.permissions) });
    return t ? NextResponse.json(t) : NextResponse.json({ error: "التحويل غير موجود.", errorEn: "Transfer not found.", code: "TRANSFER_NOT_FOUND" }, { status: 404 });
  } catch (err) {
    return handleDomainError(err);
  }
}
