import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { roastQueue } from "@/lib/services/roast-queue";
import { requireScheduleView, scheduleError } from "@/lib/services/schedule/http";
import { kg2 } from "@/lib/services/schedule/planner";

/**
 * GET /api/production/schedule/coffees — the coffees «تخطيط الدفعات» (RM7) offers: those the roast
 * queue still needs (the same requirement the production screen and the roast sheet read), and — for a
 * holder of production › roast_to_stock — every other active coffee, to plan for stock.
 */
export async function GET() {
  const { can, error } = await requireScheduleView();
  if (error) return error;
  try {
    const queue = await roastQueue(prisma);
    const needed = queue.filter((c) => c.demandKg > 0).map((c) => ({
      productId: c.productId, nameAr: c.productNameAr || c.productNameEn, nameEn: c.productNameEn, demandKg: kg2(c.demandKg),
      orders: c.orders.slice(0, 4).map((o) => o.orderNumber),
    }));
    const stock = can.roastToStock
      ? (await prisma.coffeeProduct.findMany({ where: { isActive: true, id: { notIn: needed.map((n) => n.productId) } }, select: { id: true, productNameAr: true, productNameEn: true }, orderBy: { productNameEn: "asc" } }))
        .map((p) => ({ productId: p.id, nameAr: p.productNameAr || p.productNameEn, nameEn: p.productNameEn, demandKg: "0.00", orders: [] as number[] }))
      : [];
    return NextResponse.json({ needed, stock, can });
  } catch (err) {
    return scheduleError(err);
  }
}
