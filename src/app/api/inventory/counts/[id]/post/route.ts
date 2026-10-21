import { NextResponse } from "@/lib/api-response";
import { requireAuth, stockChangeGate } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { normalizeAdjustmentReason } from "@/lib/services/inventory-adjustment";
import { getCountSession, postCountSession } from "@/lib/services/inventory-counts";

type Params = { params: Promise<{ id: string }> };

/**
 * Post a count session: every counted line with a variance becomes an inventory ADJUSTMENT in one
 * transaction, through the shared adjustment service (applyInventoryAdjustment — the movement, the
 * balance and the INVENTORY_ADJUSTED person audit, exactly as POST /api/inventory/adjust). Body
 * `{ reason }` — required, the same rule as a single count (normalizeAdjustmentReason).
 *
 * Privileged stock change (owner decision 4): inventory › adjust, a verified individual, a username +
 * PIN credential and a fresh step-up — admins included (stockChangeGate; SIMPLE MODE: the sub and a
 * recent step-up). Judged before any lookup.
 */
export async function POST(request: Request, { params }: Params) {
  const { error, user } = await requireAuth();
  if (error) return error;
  const refused = await stockChangeGate(user, "inventory", "adjust");
  if (refused) return refused;

  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) ?? {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const explained = normalizeAdjustmentReason(body.reason);
  if (!explained.ok) return NextResponse.json({ error: explained.message, code: "COUNT_REASON_REQUIRED" }, { status: 400 });

  try {
    const r = await postCountSession(user, id, explained.reason);
    return NextResponse.json({ ...r, session: await getCountSession(id) });
  } catch (err) {
    return handleDomainError(err);
  }
}
