import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { productionProgressMany } from "@/lib/services/production-planning";

// Read access is deliberately wider than write access. Production runs these orders, but
// preparation and sales both need to answer "where is the coffee for order #123?" without
// being able to change anything, and both already hold one of these modules.
const READ_MODULES = ["production", "orders", "qc", "packaging"] as const;

/**
 * GET /api/production-orders?status=PENDING,IN_PRODUCTION
 *
 * The production work list. Progress figures come from the real roasting batches and
 * packed lots behind each order — see productionProgressMany, which computes them for the
 * whole page in one pair of queries rather than one pair per row.
 */
export async function GET(request: Request) {
  const { error } = await requireAnyModule(...READ_MODULES);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("status");
  const sourceOrderItemId = searchParams.get("orderItemId");

  const where = {
    ...(statusParam ? { status: { in: statusParam.split(",") as never } } : {}),
    ...(sourceOrderItemId ? { sourceOrderItemId } : {}),
  };

  try {
    const orders = await prisma.productionOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        productionNumber: true,
        status: true,
        targetUnits: true,
        targetWeightKg: true,
        expectedGreenBeanKg: true,
        createdAt: true,
        updatedAt: true,
        productSku: {
          select: {
            id: true, skuCode: true, name: true, weightGrams: true,
            product: { select: { id: true, productNameEn: true, countryEn: true } },
          },
        },
        greenBean: { select: { id: true, serialNumber: true, beanType: true } },
        sourceOrderItem: {
          select: {
            id: true, quantityUnits: true, deliveredUnits: true,
            order: { select: { id: true, orderNumber: true, status: true, customer: { select: { name: true } } } },
          },
        },
        _count: { select: { roastingBatches: true } },
      },
    });

    const progress = await productionProgressMany(prisma, orders);

    return NextResponse.json(
      orders.map((o) => ({ ...o, progress: progress.get(o.id) ?? null }))
    );
  } catch (err) {
    return handlePrismaError(err);
  }
}
