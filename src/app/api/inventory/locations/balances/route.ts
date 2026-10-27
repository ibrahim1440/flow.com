import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";

/**
 * GET /api/inventory/locations/balances — where the stock is: per green lot and per material, its balance at each
 * location (qty > 0), and each finished lot's location. The inventory page's location filter and breakdown read it;
 * the company-wide totals stay on the items themselves.
 */
export async function GET() {
  const { error } = await requireAnyModule("inventory", "packaging", "production", "purchases");
  if (error) return error;
  try {
    const [bal, lots] = await Promise.all([
      prisma.stockBalance.findMany({ where: { qty: { gt: 0 } }, select: { itemKind: true, entityId: true, locationId: true, qty: true } }),
      prisma.finishedGoodsLot.findMany({ select: { id: true, locationId: true } }),
    ]);
    const green: Record<string, { locationId: string; qty: number }[]> = {};
    const material: Record<string, { locationId: string; qty: number }[]> = {};
    for (const b of bal) (b.itemKind === "GREEN_BEAN" ? green : material)[b.entityId] = [...((b.itemKind === "GREEN_BEAN" ? green : material)[b.entityId] ?? []), { locationId: b.locationId, qty: b.qty }];
    return NextResponse.json({ green, material, finished: Object.fromEntries(lots.map((l) => [l.id, l.locationId])) });
  } catch (err) {
    return handleDomainError(err);
  }
}
