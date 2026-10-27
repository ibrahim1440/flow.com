import { NextResponse } from "@/lib/api-response";
import { requireAnyModule, requireAnySub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { createTransfer, listTransfers } from "@/lib/services/stock-transfers";

/**
 * «تحويل مخزون» (20261115090000_stock_locations).
 *   GET  /api/inventory/transfers[?location=&from=&to=&status=POSTED|CANCELLED&dateFrom=&dateTo=&by=<creator user id>]
 *   POST /api/inventory/transfers  { fromLocationId, toLocationId, transferDate?, notes?, requestKey?,
 *                                    lines: [{ itemKind: GREEN_BEAN|MATERIAL, entityId, qty, notes? }] } — one step:
 *        both balances move now (no journal entry: valuation is company-wide).
 * Writes: inventory › receive or adjust (moving goods between sites changes no quantity the company holds).
 */
export async function GET(request: Request) {
  const { error } = await requireAnyModule("inventory", "packaging", "production");
  if (error) return error;
  const sp = new URL(request.url).searchParams;
  try {
    return NextResponse.json(await listTransfers({ location: sp.get("location"), from: sp.get("from"), to: sp.get("to"), status: sp.get("status"), dateFrom: sp.get("dateFrom"), dateTo: sp.get("dateTo"), by: sp.get("by") }));
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireAnySub("inventory", ["receive", "adjust"]);
  if (error) return error;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  try {
    const r = await createTransfer(body, { id: user.id, name: user.name }, auditFromRequest(request, user.id));
    return NextResponse.json(r, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
