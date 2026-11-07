// «بيع مباشر» waiting for its discount (D10 gate H1): until a supervisor approves, the order is not a sale yet. It is
// created in the legacy pre-preparation status «Waiting Approval» (the automatic preparation never runs from it) and every
// other path of the order system refuses it, server-side, with one code — ORDER_AWAITING_DISCOUNT (409):
//   invoice drafts on the order (from the order, manual, on delivery) · deliveries / dispatch · «اربط بصفقة» and deal
//   links · preparation review, the legacy approval, status transitions (cancel stays allowed) · line edits.
// The direct-sale service itself moves the status off PENDING / REJECTED BEFORE it completes the sale, so its own calls pass.
type Db = { order: { findUnique: (a: { where: { id: string }; select: { discountApprovalStatus: true } }) => Promise<{ discountApprovalStatus: string } | null> } };

export const AWAITING_DISCOUNT = ["PENDING", "REJECTED"] as const;
export const AWAITING_DISCOUNT_AR = "الطلب بيع مباشر ينتظر موافقة المشرف على الخصم — ما يتحرك قبلها.";
export const AWAITING_DISCOUNT_EN = "This direct sale is waiting for a supervisor's discount approval — nothing moves before it.";

export function isAwaitingDiscount(status: string | null | undefined): boolean {
  return !!status && (AWAITING_DISCOUNT as readonly string[]).includes(status);
}

export const awaitingDiscountRefusal = () => ({ _appCode: 409, code: "ORDER_AWAITING_DISCOUNT", message: AWAITING_DISCOUNT_AR, error: AWAITING_DISCOUNT_AR, errorAr: AWAITING_DISCOUNT_AR, errorEn: AWAITING_DISCOUNT_EN });

/** Throws the 409 refusal when the order waits for (or had refused) its direct-sale discount. */
export async function assertNotAwaitingDiscount(db: Db, orderId: string | null | undefined): Promise<void> {
  if (!orderId) return;
  const o = await db.order.findUnique({ where: { id: orderId }, select: { discountApprovalStatus: true } });
  if (o && isAwaitingDiscount(o.discountApprovalStatus)) throw awaitingDiscountRefusal();
}
