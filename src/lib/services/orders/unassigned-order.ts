// Owner decision (3 Nov 2026, accounting council): a rep holding orders.unassigned_customers took an order for a
// customer with no account owner. The order neither assigns the customer nor opens a deal (no commission); the sales
// supervisors (sales › lead_assign) and the admins are told once per order, inside the order's own transaction.
import type { Prisma } from "@/generated/prisma/client";
import { notify } from "@/lib/notifications/notify";

type Tx = Prisma.TransactionClient;

/**
 * R1-c gate: the reads the notice needs (the customer's name, the admins) — done BEFORE the order's transaction by the route,
 * so that only the notice's own write runs under the order-number lock (it was three statements there, now one).
 */
export async function unassignedNoticeFacts(db: Pick<Tx, "customer" | "employee">, customerId: string) {
  const [c, admins] = await Promise.all([
    db.customer.findUnique({ where: { id: customerId }, select: { name: true, nameAr: true } }),
    db.employee.findMany({ where: { role: "admin", active: true }, select: { id: true } }),
  ]);
  return { customer: c, admins: admins.map((e) => e.id) };
}

export async function notifyUnassignedCustomerOrder(
  tx: Tx,
  order: { id: string; orderNumber: number; customerId: string },
  rep: { id: string; name: string },
  facts?: Awaited<ReturnType<typeof unassignedNoticeFacts>>,
) {
  const { customer: c, admins } = facts ?? (await unassignedNoticeFacts(tx, order.customerId));
  return notify(tx, {
    event: "sales.unassigned_customer_order", dedupeKey: order.id, actorId: rep.id,
    facts: { repName: rep.name, customerName: c?.nameAr || c?.name || "", customerNameEn: c?.name || "", orderNumber: order.orderNumber },
    people: { admins }, entity: { type: "Order", id: order.id },
  });
}
