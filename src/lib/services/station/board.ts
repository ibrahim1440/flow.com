// «لوحة الطلبات المباشرة» (D15, option C) — the board's read and its guard (server). Read-only: nothing here writes,
// claims or moves anything. The stage rule and the card shape are in lib/station/board.ts (shared with the screen).
//
// Who may read it:
//   · a paired, ACTIVE station device whose station — its own or a linked one — is an ORDERS_BOARD station. No employee
//     signs in on a board (it only shows): the device cookie is the credential, exactly as the S2 roster read.
//   · off a device (W1), the person's own ERP session with the orders module.
// A device of another station type is refused (it would otherwise read orders without anybody signed in).
//
// Privacy (owner decision, 8 Nov 2026): no customer is selected at all — not even the name — and no price, amount,
// payment or invoice field. The order number, its source, quantities, stage and times only.
import { opsOrderWhere } from "@/lib/services/sales/scope";
import { createHash } from "node:crypto";
import { heldForConfirmation } from "@/lib/services/orders/held-for-confirmation";
import type { Prisma } from "@/generated/prisma/client";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { orderPipelines } from "@/lib/services/orders/pipeline";
import { claimLive } from "@/lib/station/prep-rules";
import { STATION_DEVICE_COOKIE } from "@/lib/station/device";
import {
  boardStage, openColumns, orderSource, riyadhDayStart, sortCards, type BoardAnswer, type BoardOrder,
} from "@/lib/station/board";
import { DEVICE_REQUIRED, DEVICE_REVOKED, WRONG_STATION, deviceFromToken, deviceStations } from "./guard";

export const BOARD_STATION_TYPE = "ORDERS_BOARD";

/** The board's guard. `error` is the refusal to return as it is. */
export async function requireBoardViewer(): Promise<{ mode: "device" | "personal"; error: null; orderWhere: Prisma.OrderWhereInput } | { mode: null; error: Response }> {
  const jar = await cookies();
  const token = jar.get(STATION_DEVICE_COOKIE)?.value ?? null;
  if (!token) {
    const r = await requireModule("orders");
    // P0 SEC-04: off a board device, a sales rep's board is their own orders (opsOrderWhere); the floor sees all of it.
    return r.error ? { mode: null, error: r.error } : { mode: "personal", error: null, orderWhere: opsOrderWhere(r.user) };
  }
  const dev = await deviceFromToken(token);
  if (dev.state === "none" || dev.state === "unknown") return { mode: null, error: DEVICE_REQUIRED().response() };
  if (dev.state === "revoked") return { mode: null, error: DEVICE_REVOKED().response() };
  const served = await deviceStations(dev.device, dev.station);
  if (!served.some((s) => s.type === BOARD_STATION_TYPE)) return { mode: null, error: WRONG_STATION().response() };
  return { mode: "device", error: null, orderWhere: {} };
}

const OFF_BOARD = ["Completed", "Cancelled", "Rejected"];

const ORDER_SELECT = {
  id: true, orderNumber: true, status: true, channel: true, createdAt: true,
  owner: { select: { name: true } },
  opportunityLinks: { select: { id: true }, take: 1 },
  items: {
    select: {
      id: true, quantityUnits: true, deliveredUnits: true, quantityKg: true, deliveredQty: true, productId: true,
      productSku: { select: { productId: true, weightGrams: true } },
      deliveries: { select: { date: true }, orderBy: { date: "desc" }, take: 1 },
    },
  },
} satisfies Prisma.OrderSelect;

/** The board as it is now: every card, the open columns and a version of both (the poll's ETag). */
export async function boardSnapshot(now = new Date(), orderWhere: Prisma.OrderWhereInput = {}): Promise<BoardAnswer> {
  const dayStart = riyadhDayStart(now);
  const rows = await prisma.order.findMany({
    where: {
      AND: [orderWhere, { OR: [
        { status: { notIn: OFF_BOARD } },
        // «سُلّم اليوم»: completed orders with a delivery today (the last one decides, below).
        { status: "Completed", items: { some: { deliveries: { some: { date: { gte: dayStart } } } } } },
      ] }],
    },
    select: ORDER_SELECT,
    orderBy: { orderNumber: "asc" },
  });
  const ids = rows.map((o) => o.id);
  const [pipelines, handed, claims, directSales, held] = await Promise.all([
    orderPipelines(prisma, rows),
    ids.length ? prisma.preparationPick.groupBy({ by: ["orderId"], where: { orderId: { in: ids }, status: "HANDED_OFF" }, _sum: { units: true } }) : [],
    ids.length ? prisma.workItemClaim.findMany({ where: { stationType: "PACKAGING", itemType: "Order", itemId: { in: ids }, status: "ACTIVE" }, select: { itemId: true, status: true, expiresAt: true, claimedByName: true } }) : [],
    // Only the orders without a recorded channel need the «بيع مباشر» evidence.
    (() => {
      const unknown = rows.filter((o) => !o.channel).map((o) => o.id);
      return unknown.length ? prisma.hrAuditLog.findMany({ where: { action: "DIRECT_SALE_CREATED", entityType: "Order", entityId: { in: unknown } }, select: { entityId: true } }) : [];
    })(),
    heldForConfirmation(ids),
  ]);
  const handedBy = new Map(handed.map((h) => [h.orderId, h._sum.units ?? 0]));
  const direct = new Set(directSales.map((d) => d.entityId));
  const nowMs = now.getTime();

  const orders: BoardOrder[] = [];
  for (const o of rows) {
    const p = pipelines.get(o.id) ?? null;
    let last: Date | null = null;
    let units = 0, kg = 0, outstanding = 0, delivered = 0;
    for (const i of o.items) {
      const d = i.deliveries[0]?.date ?? null;
      if (d && (!last || d > last)) last = d;
      if (i.quantityUnits !== null) {
        units += i.quantityUnits;
        outstanding += Math.max(0, i.quantityUnits - i.deliveredUnits);
        delivered += i.deliveredUnits;
      } else {
        kg += i.quantityKg;
        outstanding += Math.max(0, i.quantityKg - i.deliveredQty);
        delivered += i.deliveredQty;
      }
    }
    const handedOff = handedBy.get(o.id) ?? 0;
    const stage = boardStage({ status: o.status, pipelineStage: p?.stage ?? null, handedOffUnits: handedOff, lastDeliveryAt: last }, now);
    if (!stage) continue;
    const source = orderSource({ channel: o.channel, directSale: direct.has(o.id), dealLinked: o.opportunityLinks.length > 0 });
    const claim = stage === "prep" ? claims.find((c) => c.itemId === o.id && claimLive(c, nowMs)) ?? null : null;
    orders.push({
      id: o.id,
      orderNumber: o.orderNumber,
      stage,
      hold: o.status === "On Hold",
      confirmHold: held.get(o.id) ?? null,
      source,
      repName: source === "SALES" ? o.owner?.name ?? null : null,
      units,
      kg: Math.round(kg * 1000) / 1000,
      lines: o.items.length,
      partial: stage === "ship" ? handedOff < outstanding : stage !== "done" && delivered > 0,
      preparingBy: claim?.claimedByName ?? null,
      createdAt: o.createdAt.toISOString(),
      deliveredAt: stage === "done" && last ? last.toISOString() : null,
    });
  }
  const sorted = sortCards(orders);
  const version = createHash("sha256").update(JSON.stringify(sorted)).digest("base64url").slice(0, 22);
  return { orders: sorted, columns: openColumns(sorted), version, serverTime: now.toISOString() };
}
