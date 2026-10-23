// Workstations W4 — settling the preparation station's picks when dispatch delivers a line.
// Called by POST /api/deliveries inside its transaction (after the OrderItem lock, the stock draw and
// the DeliveryLine rows). The picks never moved stock; this only closes them: the delivered units
// mark the line's open picks DELIVERED (those of a lot the delivery drew first, handed-off before
// merely picked, then oldest), splitting one that is only partly covered. Nothing else changes.
import type { Prisma } from "@/generated/prisma/client";
import { settlePicks } from "@/lib/station/lot-match";

export async function settlePicksOnDelivery(tx: Prisma.TransactionClient, a: { orderItemId: string; units: number; lotIds: string[]; deliveryId: string }) {
  if (a.units <= 0) return 0;
  const open = await tx.preparationPick.findMany({
    where: { orderItemId: a.orderItemId, status: { in: ["PICKED", "HANDED_OFF"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (open.length === 0) return 0;
  const { settle } = settlePicks(open.map((p) => ({ id: p.id, units: p.units, lotId: p.finishedGoodsLotId, status: p.status, createdAt: p.createdAt })), a.units, a.lotIds);
  const now = new Date();
  for (const s of settle) {
    const p = open.find((x) => x.id === s.id)!;
    await tx.preparationPick.update({ where: { id: p.id }, data: { units: s.units, status: "DELIVERED", settledAt: now } });
    if (s.rest > 0) {
      await tx.preparationPick.create({
        data: {
          orderId: p.orderId, orderItemId: p.orderItemId, finishedGoodsLotId: p.finishedGoodsLotId, batchNumber: p.batchNumber,
          units: s.rest, status: p.status, handoffId: p.handoffId, requestKey: `${p.requestKey}:rest:${a.deliveryId}`.slice(0, 200),
          pickedById: p.pickedById, pickedByName: p.pickedByName, stationId: p.stationId, createdAt: p.createdAt,
        },
      });
    }
  }
  return settle.reduce((n, s) => n + s.units, 0);
}
