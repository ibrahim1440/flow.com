import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { cancelTransfer } from "@/lib/services/stock-transfers";

type Params = { params: Promise<{ id: string }> };

/** POST { reason } — cancel a transfer: its movements reversed, only while the goods are still at the destination. inventory › adjust. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("inventory", "adjust");
  if (error) return error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const reason = typeof body?.reason === "string" ? body.reason : "";
    return NextResponse.json(await cancelTransfer((await params).id, reason, { id: user.id, name: user.name }, auditFromRequest(request, user.id, reason)));
  } catch (err) {
    return handleDomainError(err);
  }
}
