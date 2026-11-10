// The pure halves of «طلب مباشر» (direct-order-deal.ts): no database here, so unit tests import this module without a
// DATABASE_URL (test hygiene, 10 Nov 2026). direct-order-deal.ts re-exports all of it — callers are unchanged.
import { Prisma } from "@/generated/prisma/client";
import { hasModuleAccess, type Permissions } from "@/lib/auth-shared";
import { DEFAULT_VAT_RATE } from "@/lib/services/invoicing/pricing";
import { seesAllSales } from "./scope";

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;
const ZERO = new Decimal(0);
const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const DIRECT_ORDER_REASON = "تلقائي: طلب مباشر";
export const DIRECT_ORDER_CANCEL_REASON = "تلقائي: إلغاء الطلب";
/** Order statuses whose value no longer counts (eligibleDocument, the deal amount). */
export const DEAD_ORDER_STATUSES = ["Cancelled", "Rejected"] as const;
export const directOrderRequestKey = (orderId: string) => `direct-order:${orderId}`;
export const directDealTitle = (customer: { name: string; nameAr: string | null }) => `طلب مباشر — ${customer.nameAr || customer.name}`.slice(0, 200);

export type Actor = { id: string; name: string; permissions: Permissions | Record<string, unknown> };

/** The order's value, VAT included — catalogue price × ordered quantity (units for a SKU line, else kilograms). Pure. */
export function priceDirectOrder(items: { quantityUnits: number | null; quantityKg: number; price: number | null }[], vatPercent = DEFAULT_VAT_RATE): { net: Decimal; tax: Decimal; gross: Decimal } {
  let net = ZERO;
  for (const i of items) {
    const price = i.price && i.price > 0 ? new Decimal(i.price.toFixed(2)) : ZERO;
    const qty = new Decimal(String(i.quantityUnits ?? i.quantityKg ?? 0));
    net = net.plus(round2(price.times(qty)));
  }
  net = round2(net);
  const tax = round2(net.times(new Decimal(vatPercent)).dividedBy(100));
  return { net, tax, gross: round2(net.plus(tax)) };
}

/**
 * Who owns the deal opened for a direct order (owner decisions, gate M3 / L2). Pure.
 *   · the customer has an ACTIVE account owner → that owner, whoever placed the order — commission follows the book
 *     (a rep who only holds some deal on another rep's account does not earn on it);
 *   · no account owner (the pool) → the creator, but only when the creator is a rep (holds the sales module);
 *   · otherwise null → NO deal is opened: an operations or other non-sales user's order for a pool customer stays
 *     unlinked, exactly like a rep's order for a pool customer (owner decision 3 Nov 2026).
 */
export function directDealOwner(actor: Actor, customer: { accountOwnerId: string | null }, accountOwnerActive: boolean): string | null {
  if (customer.accountOwnerId && accountOwnerActive) return customer.accountOwnerId;
  if (customer.accountOwnerId) return hasModuleAccess(actor.permissions as Permissions, "sales") ? actor.id : null;
  return hasModuleAccess(actor.permissions as Permissions, "sales") ? actor.id : null;
}

/** Who may use «اربط بصفقة» on this order: its owner, a supervisor (lead_assign), or the admin role (with the sales view). */
export function mayLinkOrderDeal(actor: Actor, order: { ownerId: string | null }): boolean {
  if (order.ownerId && order.ownerId === actor.id) return true;
  return seesAllSales(actor.permissions);
}
