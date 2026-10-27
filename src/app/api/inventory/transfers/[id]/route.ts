import { NextResponse } from "@/lib/api-response";
import { requireAnyModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { getTransfer } from "@/lib/services/stock-transfers";

type Params = { params: Promise<{ id: string }> };

/** GET — the transfer, its lines (items, quantities, value at cost), its movements, its cost moves and its activity log. */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireAnyModule("inventory", "packaging", "production");
  if (error) return error;
  try {
    const t = await getTransfer((await params).id);
    return t ? NextResponse.json(t) : NextResponse.json({ error: "التحويل غير موجود.", errorEn: "Transfer not found.", code: "TRANSFER_NOT_FOUND" }, { status: 404 });
  } catch (err) {
    return handleDomainError(err);
  }
}
