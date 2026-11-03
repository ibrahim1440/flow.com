// Owner decision (3 Nov 2026, accounting council): a rep holding orders.unassigned_customers took an order for a
// customer with no account owner. The order neither assigns the customer nor opens a deal (no commission); the sales
// supervisors (sales › lead_assign) and the admins are told once per order, inside the order's own transaction.
import type { Prisma } from "@/generated/prisma/client";
import { notify } from "@/lib/notifications/notify";

type Tx = Prisma.TransactionClient;

export async function notifyUnassignedCustomerOrder(tx: Tx, order: { id: string; orderNumber: number; customerId: string }, rep: { id: string; name: string }) {
  const c = await tx.customer.findUnique({ where: { id: order.customerId }, select: { name: true, nameAr: true } });
  const admins = (await tx.employee.findMany({ where: { role: "admin", active: true }, select: { id: true } })).map((e) => e.id);
  return notify(tx, {
    event: "sales.unassigned_customer_order", dedupeKey: order.id, actorId: rep.id,
    facts: { repName: rep.name, customerName: c?.nameAr || c?.name || "", customerNameEn: c?.name || "", orderNumber: order.orderNumber },
    people: { admins }, entity: { type: "Order", id: order.id },
  });
}
