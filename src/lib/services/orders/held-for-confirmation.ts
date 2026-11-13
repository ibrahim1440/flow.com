// The station board's view of the owner-decision-أ hold (services/orders/payment-hold.ts): which of these orders wait for
// the accountant to confirm the money taken at the sale (PENDING) or had that receipt rejected (REJECTED). Only the state —
// no figure, no customer. Kept apart so the board's own code names nothing about money (its privacy test).
import { prisma } from "@/lib/db";

export type ConfirmHold = "PENDING" | "REJECTED";

export async function heldForConfirmation(ids: string[]): Promise<Map<string, ConfirmHold>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.order.findMany({ where: { id: { in: ids }, paymentHold: { in: ["PENDING", "REJECTED"] } }, select: { id: true, paymentHold: true } });
  return new Map(rows.map((r) => [r.id, r.paymentHold as ConfirmHold]));
}
