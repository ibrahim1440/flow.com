// The database half of the customer / order visibility rule (services/sales/scope.ts). One question,
// asked identically by every customer and order endpoint that takes an id from the URL: is this
// record in the viewer's book? A record outside it answers 404 — the same refusal as a missing one,
// so an id cannot be used to confirm that another rep's customer or order exists.
import { prisma } from "@/lib/db";
import type { Permissions } from "@/lib/auth-shared";
import { customersScopedToOwner, mayOrderUnassignedCustomers, orderedByOrForWhere, ownedCustomerWhere } from "./scope";

type Viewer = { id: string; role?: string | null; permissions: Permissions | Record<string, unknown> };
type Db = Pick<typeof prisma, "customer" | "order">;

export async function customerInScope(user: Viewer, customerId: string, db: Db = prisma): Promise<boolean> {
  if (!customersScopedToOwner(user)) return true;
  const row = await db.customer.findFirst({ where: { id: customerId, ...ownedCustomerWhere(user.id) }, select: { id: true } });
  return !!row;
}

/**
 * Owner M6 = أ (12 Nov 2026): may this viewer read the customer's MONEY (receivable, statement, credit used)? A scoped rep
 * only for a customer ASSIGNED to them (its account owner) — never a pool customer, never another rep's customer reached
 * through a deal of theirs; everyone who sees every customer, yes.
 */
export async function customerFiguresVisible(user: Viewer, customerId: string, db: Db = prisma): Promise<boolean> {
  if (!customersScopedToOwner(user)) return true;
  const row = await db.customer.findFirst({ where: { id: customerId, accountOwnerId: user.id }, select: { id: true } });
  return !!row;
}

export async function orderInScope(user: Viewer, orderId: string, db: Db = prisma): Promise<boolean> {
  if (!customersScopedToOwner(user)) return true;
  const row = await db.order.findFirst({ where: { id: orderId, ...orderedByOrForWhere(user.id) }, select: { id: true } });
  return !!row;
}

/**
 * May this viewer take an ORDER for this customer? "book": in their book (or they see every customer);
 * "unassigned": a customer with no account owner, allowed only with orders.unassigned_customers (owner
 * decision 3 Nov 2026) — the order neither assigns the customer nor opens its file; null: refused (another
 * rep's customer, or a pool customer without the key, or no such customer — the same 404).
 */
export async function orderCustomerAccess(user: Viewer, customerId: string, db: Db = prisma): Promise<"book" | "unassigned" | null> {
  if (await customerInScope(user, customerId, db)) return "book";
  if (!mayOrderUnassignedCustomers(user.permissions)) return null;
  const row = await db.customer.findFirst({ where: { id: customerId, accountOwnerId: null }, select: { id: true } });
  return row ? "unassigned" : null;
}

/** P0 SEC-04: an order line an operations read may show this viewer (opsScopedRep → only a line of an order in their book). */
export async function orderItemInOpsScope(user: Viewer, orderItemId: string): Promise<boolean> {
  const { opsScopedRep } = await import("./scope");
  if (!opsScopedRep(user)) return true;
  const item = await prisma.orderItem.findUnique({ where: { id: orderItemId }, select: { orderId: true } });
  return !!item && (await orderInScope(user, item.orderId));
}
