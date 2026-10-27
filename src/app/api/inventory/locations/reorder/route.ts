import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { reorderLocations } from "@/lib/services/stock-locations";

/** POST { ids: [locationId, …] } — the order the locations are listed in (pickers, the inventory page). inventory › adjust. */
export async function POST(request: Request) {
  const { user, error } = await requireSub("inventory", "adjust");
  if (error) return error;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    return NextResponse.json(await reorderLocations(body?.ids, { id: user.id, name: user.name }, auditFromRequest(request, user.id)));
  } catch (err) {
    return handleDomainError(err);
  }
}
