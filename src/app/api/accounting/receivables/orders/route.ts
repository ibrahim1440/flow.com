import { prisma } from "@/lib/db";
import { accountingRoute, query } from "@/lib/accounting/http";

/** Orders of a customer that have no live invoice yet (for "invoice from order"). */
export const GET = accountingRoute(null, async ({ request }) => {
  const customerId = query(request).get("customerId");
  const orders = await prisma.order.findMany({ where: { ...(customerId ? { customerId } : {}), status: { notIn: ["Cancelled", "Rejected"] } }, orderBy: { orderNumber: "desc" }, take: 100, select: { id: true, orderNumber: true, status: true, customerId: true, createdAt: true } });
  const invoiced = new Set((await prisma.salesInvoice.findMany({ where: { orderId: { in: orders.map((o) => o.id) }, kind: "INVOICE", status: { not: "REVERSED" } }, select: { orderId: true } })).map((i) => i.orderId));
  return orders.filter((o) => !invoiced.has(o.id));
});
