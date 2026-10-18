import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { canSeeCustomerContact, CUSTOMER_NAME_SELECT } from "@/lib/auth/customer-detail";

export async function GET(request: Request) {
  const { user, error } = await requireModule("history");
  if (error) return error;
  // F4 / review F-1: the history export carries the customer's name; the contact record only for
  // holders of the customers module. (The history page's export columns use the name only.)
  const customer = canSeeCustomerContact(user.permissions) ? (true as const) : { select: CUSTOMER_NAME_SELECT };

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") || "orders";

  let data: unknown;

  switch (type) {
    case "orders":
      data = await prisma.order.findMany({
        include: { customer, items: { include: { roastingBatches: true, deliveries: true } } },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      break;
    case "production":
      data = await prisma.roastingBatch.findMany({
        where: { isBlend: false },
        include: { orderItem: { include: { order: { include: { customer } } } }, greenBean: true },
        orderBy: { date: "desc" },
        take: 500,
      });
      break;
    case "qc":
      data = await prisma.qcRecord.findMany({
        include: { batch: { include: { orderItem: { include: { order: { include: { customer } } } } } } },
        orderBy: { date: "desc" },
        take: 500,
      });
      break;
    case "deliveries":
      data = await prisma.delivery.findMany({
        include: { orderItem: { include: { order: { include: { customer } } } } },
        orderBy: { date: "desc" },
        take: 500,
      });
      break;
    case "inventory":
      data = await prisma.greenBean.findMany({ orderBy: { beanType: "asc" }, take: 200 });
      break;
    default:
      return NextResponse.json({ error: "Invalid export type" }, { status: 400 });
  }

  return NextResponse.json(data);
}
