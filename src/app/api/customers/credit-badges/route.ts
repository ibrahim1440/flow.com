import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";
import { customerVisibilityWhere } from "@/lib/services/sales/scope";
import { handleDomainError } from "@/lib/api-error";
import { creditBadges } from "@/lib/services/customers/credit-db";
import { checkCreditStandingLater } from "@/lib/notifications/credit-watch";

/**
 * GET /api/customers/credit-badges[?ids=a,b] — the customers list's red badges («متجاوز حد
 * الائتمان», «متأخر السداد N يوم», «البيع موقوف», «مهلة سماح حتى …»), for the customers the list
 * shows (the first 200 by name, as GET /api/customers) or the ids given (at most 200). Flags only,
 * never amounts; customers with nothing to say are absent. Read-only (a list settles nothing).
 */
export async function GET(request: Request) {
  const { user, error } = await requireAnyModule("customers", "orders");
  if (error) return error;
  try {
    const raw = new URL(request.url).searchParams.get("ids");
    // A scoped sales rep's badges cover their own book only, asked by id or not.
    const where = customerVisibilityWhere(user);
    const asked = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200) : null;
    const ids = (await prisma.customer.findMany({
      where: asked ? { id: { in: asked }, ...where } : where,
      ...(asked ? {} : { orderBy: { name: "asc" as const }, take: 200 }),
      select: { id: true },
    })).map((c) => c.id);
    const badges = await creditBadges(prisma, ids, new Date());
    // feat/notifications: a standing that changed since it was last notified is notified (once), after the response.
    checkCreditStandingLater(ids);
    return NextResponse.json({ badges });
  } catch (err) {
    return handleDomainError(err);
  }
}
