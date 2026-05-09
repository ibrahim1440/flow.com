import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";

export async function GET(request: Request) {
  const { error } = await requireModule("history");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") || "orders";

  let data: unknown;

  switch (type) {
    case "orders":
      data = await prisma.order.findMany({
        include: { customer: true, items: { include: { roastingBatches: true, deliveries: true } } },
        orderBy: { createdAt: "desc" },
      });
      break;
    case "production":
      data = await prisma.roastingBatch.findMany({
        include: { orderItem: { include: { order: { include: { customer: true } } } }, greenBean: true },
        orderBy: { date: "desc" },
      });
      break;
    case "qc":
      data = await prisma.qcRecord.findMany({
        include: { batch: { include: { orderItem: { include: { order: { include: { customer: true } } } } } } },
        orderBy: { date: "desc" },
      });
      break;
    case "deliveries":
      data = await prisma.delivery.findMany({
        include: { orderItem: { include: { order: { include: { customer: true } } } } },
        orderBy: { date: "desc" },
      });
      break;
    case "inventory":
      data = await prisma.greenBean.findMany({ orderBy: { beanType: "asc" } });
      break;
    default:
      return NextResponse.json({ error: "Invalid export type" }, { status: 400 });
  }

  return NextResponse.json(data);
}
