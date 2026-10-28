import { NextResponse } from "@/lib/api-response";
import { requireAnyModule, requireEdit } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { itemReorderPoints, setReorderPoints } from "@/lib/services/stock-reorder";

/**
 * Reorder points per item per location (20261117090000_locations_enhancements, owner decision 3).
 *   GET /api/inventory/reorder-points?itemKind=GREEN_BEAN|MATERIAL&entityId=… → { sites: [{ id, nameAr, qty, reorderPoint, low }] }
 *   PUT /api/inventory/reorder-points { itemKind, entityId, points: [{ locationId, reorderPoint | null }] } — the item's
 *       settings (inventory › edit, as editing the item); audited.
 */
export async function GET(request: Request) {
  const { error } = await requireAnyModule("inventory", "packaging", "production", "purchases");
  if (error) return error;
  const sp = new URL(request.url).searchParams;
  try {
    return NextResponse.json(await itemReorderPoints(sp.get("itemKind"), sp.get("entityId")));
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function PUT(request: Request) {
  const { user, error } = await requireEdit("inventory");
  if (error) return error;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  try {
    return NextResponse.json(await setReorderPoints(body, { id: user.id }, auditFromRequest(request, user.id)));
  } catch (err) {
    return handleDomainError(err);
  }
}
