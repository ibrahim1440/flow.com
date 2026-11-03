import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { customersScopedToOwner, mayOrderUnassignedCustomers } from "@/lib/services/sales/scope";

/**
 * GET /api/orders/customer-options — the UNASSIGNED customers (no account owner) a scoped rep holding
 * orders.unassigned_customers may take an order for (owner decision 3 Nov 2026, accounting council). Name only: no
 * phone, e-mail, address or balance — the customer's file stays closed to the rep. Everyone else gets [] (a rep
 * without the key; anyone who already sees every customer through GET /api/customers).
 */
export async function GET() {
  const { user, error } = await requireSub("orders", "create");
  if (error) return error;
  if (!customersScopedToOwner(user) || !mayOrderUnassignedCustomers(user.permissions)) {
    return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });
  }
  const rows = await prisma.customer.findMany({
    where: { accountOwnerId: null }, orderBy: { name: "asc" }, take: 500,
    select: { id: true, name: true, nameAr: true },
  });
  return NextResponse.json(rows.map((r) => ({ ...r, unassigned: true })), { headers: { "Cache-Control": "no-store" } });
}
