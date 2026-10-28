import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { cancelTransfer } from "@/lib/services/stock-transfers";

type Params = { params: Promise<{ id: string }> };

/**
 * POST { reason } — cancel a transfer: one step — its movements reversed, only while the goods are still at the
 * destination; in transit — everything returns to the source. inventory › transfer_cancel — a PRIVILEGED permission
 * (gate finding M-2, the owner): requireSub runs the central gate — a verified individual account and a recent step-up
 * (401 REAUTH_REQUIRED, which the dashboard's step-up dialog answers and retries); never held by a PIN-only account.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("inventory", "transfer_cancel");
  if (error) return error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const reason = typeof body?.reason === "string" ? body.reason : "";
    return NextResponse.json(await cancelTransfer((await params).id, reason, { id: user.id, name: user.name }, auditFromRequest(request, user.id, reason)));
  } catch (err) {
    return handleDomainError(err);
  }
}
