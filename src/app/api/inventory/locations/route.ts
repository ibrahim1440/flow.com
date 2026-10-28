import { NextResponse } from "@/lib/api-response";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { createLocation, lastReceivingLocationId, listLocations } from "@/lib/services/stock-locations";

/**
 * Stock locations (20261115090000_stock_locations).
 *   GET  /api/inventory/locations[?all=1] → { locations (with what each holds), defaultId, productionId, lastReceivingId }.
 *        Inactive locations only with ?all=1 (the master page); pickers show the active ones. On the master page a viewer
 *        who holds the accounting module also gets each site's `valueEstimate` (Σ qty × company moving-average cost).
 *   POST /api/inventory/locations          → { code, nameAr, nameEn?, type, address?, notes?, isDefault? }.
 * Writes: inventory › adjust (the owner's privilege for the stock master data); each one in the person audit.
 */
export async function GET(request: Request) {
  // dispatch (20261117090000): the dispatch screen's «الشحن من» picker.
  const { user, error } = await requireAnyModule("inventory", "packaging", "production", "purchases", "accounting", "dispatch");
  if (error) return error;
  try {
    const all = new URL(request.url).searchParams.get("all") === "1";
    const locations = await listLocations({ includeInactive: all, withValue: all && hasModuleAccess(user.permissions, "accounting") });
    return NextResponse.json({
      locations,
      defaultId: locations.find((l) => l.isDefault)?.id ?? null,
      productionId: locations.find((l) => l.isProduction)?.id ?? null,
      lastReceivingId: await lastReceivingLocationId(user.id),
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("inventory", "adjust");
  if (error) return error;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  try {
    return NextResponse.json(await createLocation(body, { id: user.id, name: user.name }, auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
