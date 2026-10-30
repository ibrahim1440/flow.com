// The database half of the customer / order visibility rule (services/sales/scope.ts). One question,
// asked identically by every customer and order endpoint that takes an id from the URL: is this
// record in the viewer's book? A record outside it answers 404 — the same refusal as a missing one,
// so an id cannot be used to confirm that another rep's customer or order exists.
import { prisma } from "@/lib/db";
import type { Permissions } from "@/lib/auth-shared";
import { customersScopedToOwner, orderedByOrForWhere, ownedCustomerWhere } from "./scope";

type Viewer = { id: string; role?: string | null; permissions: Permissions | Record<string, unknown> };
type Db = Pick<typeof prisma, "customer" | "order">;

export async function customerInScope(user: Viewer, customerId: string, db: Db = prisma): Promise<boolean> {
  if (!customersScopedToOwner(user)) return true;
  const row = await db.customer.findFirst({ where: { id: customerId, ...ownedCustomerWhere(user.id) }, select: { id: true } });
  return !!row;
}

export async function orderInScope(user: Viewer, orderId: string, db: Db = prisma): Promise<boolean> {
  if (!customersScopedToOwner(user)) return true;
  const row = await db.order.findFirst({ where: { id: orderId, ...orderedByOrForWhere(user.id) }, select: { id: true } });
  return !!row;
}
