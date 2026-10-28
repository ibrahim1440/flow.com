import { NextResponse } from "@/lib/api-response";
import { requireAnyModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { inTransitSummary, transferableLots } from "@/lib/services/stock-transfers";

/**
 * GET /api/inventory/transfers/lots?location=<id> — the finished lots a transfer can take from that location
 * (unit-tracked, AVAILABLE, with free units), oldest first. Without a location: what is «في الطريق» now
 * (the two-step transfers in transit and their lines). 20261117090000_locations_enhancements.
 */
export async function GET(request: Request) {
  const { error } = await requireAnyModule("inventory", "packaging", "production", "dispatch");
  if (error) return error;
  const location = new URL(request.url).searchParams.get("location");
  try {
    return NextResponse.json(location ? { lots: await transferableLots(location) } : { inTransit: await inTransitSummary() });
  } catch (err) {
    return handleDomainError(err);
  }
}
