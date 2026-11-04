import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { seesAllSales } from "@/lib/services/sales/scope";

/**
 * GET /api/orders/deal-options?customerId=… — «طلب مباشر» on the order form: the customer's OPEN deals the creator can
 * see (their own; every one with the all-sales view), newest first. With several the form lets the creator pick; with
 * one the order joins it; with none a deal is opened for the order (services/sales/direct-order-deal.ts). orders ›
 * create; a customer outside the creator's book answers an empty list (never confirms another rep's deals).
 */
export async function GET(request: Request) {
  const { user, error } = await requireSub("orders", "create");
  if (error) return error;
  const customerId = new URL(request.url).searchParams.get("customerId") ?? "";
  if (!customerId) return NextResponse.json({ deals: [] });
  try {
    if (!hasModuleAccess(user.permissions, "sales") || !(await customerInScope(user, customerId))) return NextResponse.json({ deals: [] });
    const deals = await prisma.opportunity.findMany({
      where: { customerId, outcome: "OPEN", ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }) },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 20,
      select: { id: true, title: true, updatedAt: true, owner: { select: { id: true, name: true } }, stage: { select: { nameAr: true, nameEn: true } } },
    });
    return NextResponse.json({ deals });
  } catch (err) {
    return handleDomainError(err);
  }
}
