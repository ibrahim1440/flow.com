import { NextResponse } from "@/lib/api-response";
import { requireSub, stockChangeGate } from "@/lib/auth-server";
import { assertVerifiedActor } from "@/lib/hr/identity";
import { transferShortfallGate } from "@/lib/services/transfer-shortfall-gate";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { receiveTransfer } from "@/lib/services/stock-transfers";

type Params = { params: Promise<{ id: string }> };

/**
 * POST { lines?: [{ lineNo, qtyReceived, varianceReason? }], note? } — «استلام» a two-step transfer at its destination
 * (20261117090000_locations_enhancements). A line not listed is received in full. inventory › transfer_receive.
 * A green / material shortfall is written off from «في الطريق» with its reason — an ordinary stock adjustment (its posting
 * and audit unchanged). The owner's decision before release: the receiver records it with inventory › transfer_receive
 * alone (no inventory › adjust); the supervisors are notified at once (inventory.transfer_shortfall, in the app and by
 * e-mail). Finished goods are received in full.
 * Council F1 (transfer-shortfall-gate.ts): a shortfall only from a verified individual account (never a PIN-only
 * session); the transfer's own creator / sender needs inventory › adjust and the stock-change gate (segregation of duties).
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("inventory", "transfer_receive");
  if (error) return error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const id = (await params).id;
    const refused = await transferShortfallGate(user, id, body ?? {}, {
      verified: (u) => assertVerifiedActor(u, "inventory.transfer_shortfall").then(() => true, () => false),
      adjustGate: () => stockChangeGate(user, "inventory", "adjust"),
    });
    if (refused) return refused;
    return NextResponse.json(await receiveTransfer(id, body ?? {}, { id: user.id, name: user.name, canWriteOff: true, user }, auditFromRequest(request, user.id)));
  } catch (err) {
    return handleDomainError(err);
  }
}
