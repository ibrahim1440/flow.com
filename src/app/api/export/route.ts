import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { canSeeCustomerContact, CUSTOMER_NAME_SELECT } from "@/lib/auth/customer-detail";
import { withDeliveryLots } from "@/lib/services/delivery-lots";
import { customersScopedToOwner, orderVisibilityWhere } from "@/lib/services/sales/scope";

export async function GET(request: Request) {
  const { user, error } = await requireModule("history");
  if (error) return error;
  // F4 / review F-1: the history export carries the customer's name; the contact record only for
  // holders of the customers module. (The history page's export columns use the name only.)
  const customer = canSeeCustomerContact(user.permissions) ? (true as const) : { select: CUSTOMER_NAME_SELECT };

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") || "orders";
  // Council gate S1: a scoped sales rep exports the orders of their own book only — the same rule as
  // GET /api/orders (services/sales/scope.ts). Operations and managers export everything, as before.
  const scoped = customersScopedToOwner(user);
  const orderWhere = orderVisibilityWhere(user);

  let data: unknown;

  switch (type) {
    case "orders":
      data = await prisma.order.findMany({
        where: orderWhere,
        include: { customer, items: { include: { roastingBatches: true, deliveries: true } } },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      break;
    case "production":
      data = await prisma.roastingBatch.findMany({
        where: { isBlend: false, ...(scoped ? { orderItem: { order: orderWhere } } : {}) },
        include: { orderItem: { include: { order: { include: { customer } } } }, greenBean: true },
        orderBy: { date: "desc" },
        take: 500,
      });
      break;
    case "qc":
      data = await prisma.qcRecord.findMany({
        ...(scoped ? { where: { batch: { orderItem: { order: orderWhere } } } } : {}),
        include: { batch: { include: { orderItem: { include: { order: { include: { customer } } } } } } },
        orderBy: { date: "desc" },
        take: 500,
      });
      break;
    case "deliveries":
      // Phase D: each delivery carries `lots` — its DeliveryLine rows, or for one recorded before
      // them, the single lot its ledger row names.
      data = await withDeliveryLots(prisma, await prisma.delivery.findMany({
        ...(scoped ? { where: { orderItem: { order: orderWhere } } } : {}),
        include: { orderItem: { include: { order: { include: { customer } } } } },
        orderBy: { date: "desc" },
        take: 500,
      }));
      break;
    case "inventory":
      data = await prisma.greenBean.findMany({ orderBy: { beanType: "asc" }, take: 200 });
      break;
    default:
      return NextResponse.json({ error: "Invalid export type" }, { status: 400 });
  }

  return NextResponse.json(data);
}
