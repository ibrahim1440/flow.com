import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { appendOrderActivity, lockOrderLifecycleResources } from "@/lib/services/order-operations";
import {
  assertStructuralEditAllowed,
  normalizeRequestedLine,
  lockOrderEditDemandKeys,
  assertNotBelowDelivered,
  assertShrinkNotBelowProduction,
  assertIdentityChangeAllowed,
  validateLineRemoval,
  releaseAllReservations,
  reconcileLineReservations,
  lineHistory,
  type RequestedLine,
  type LiveLine,
} from "@/lib/services/order-edit";

/**
 * Structurally edit an existing order.
 *
 * The whole request is one transaction. It previously was not: removals ran in a transaction
 * of their own and then each line update and insert ran as a bare prisma call after it, so a
 * request whose second line was invalid left the first one already rewritten.
 *
 * Everything about what an edit MEANS — which quantity is authoritative, what may be removed,
 * what has to be handed back — lives in order-edit.ts.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireSub("orders", "edit");
  if (error) return error;

  const { id } = await params;
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { body = {}; }

  // ── Writable order fields, by allowlist ────────────────────────────────────
  // approvalStatus, approvalDate, paymentStatus and vatInvoiceStatus are deliberately absent:
  // each has a dedicated transition route with its own authorization and audit trail.
  // Operational state — delivered quantities, reservation totals, productionStatus,
  // deliveryStatus, remainingQty — is owned by the operations that produce it and is never
  // writable from here.
  const orderData: Record<string, unknown> = {};
  if (body.customerId !== undefined)        orderData.customerId        = body.customerId;
  if (body.quotationNumber !== undefined)   orderData.quotationNumber   = body.quotationNumber ?? null;
  if (body.quotationSentDate !== undefined) {
    orderData.quotationSentDate = body.quotationSentDate
      ? new Date(body.quotationSentDate as string | number | Date)
      : null;
  }
  if (body.notes !== undefined)             orderData.notes             = body.notes ?? null;

  const PROTECTED_LINE_FIELDS = [
    "deliveredQty", "deliveredUnits", "remainingQty", "productionStatus",
    "deliveryStatus", "preparationDecision", "availableQuantity", "productionRequiredQuantity",
  ] as const;

  const items = body.items;
  const editingItems = Array.isArray(items);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (!order) throw { _appCode: 404, message: "Order not found." };

      if (editingItems) {
        assertStructuralEditAllowed(order.status);

        // ── Shape and identity, resolved server-side ──────────────────────────
        const requested: RequestedLine[] = (items as unknown[]).map((raw) => {
          const r = (raw ?? {}) as Record<string, unknown>;
          for (const f of PROTECTED_LINE_FIELDS) {
            if (r[f] !== undefined) {
              throw {
                _appCode: 400,
                message: `"${f}" is maintained by the system and cannot be set from an order edit.`,
              };
            }
          }
          return {
            id: typeof r.id === "string" ? r.id : undefined,
            beanTypeName: r.beanTypeName as string,
            productId: typeof r.productId === "string" && r.productId ? r.productId : null,
            productSkuId: typeof r.productSkuId === "string" && r.productSkuId ? r.productSkuId : null,
            quantityUnits:
              r.quantityUnits === undefined || r.quantityUnits === null ? null : Number(r.quantityUnits),
            quantityKg:
              r.quantityKg === undefined || r.quantityKg === null ? null : Number(r.quantityKg),
          };
        });

        const resolved = [];
        for (const raw of requested) resolved.push(await normalizeRequestedLine(tx, raw));

        const existing = await tx.orderItem.findMany({
          where: { orderId: id },
          select: {
            id: true, quantityKg: true, quantityUnits: true,
            deliveredQty: true, deliveredUnits: true,
            productSkuId: true, productId: true,
          },
        });
        const existingById = new Map<string, LiveLine>(existing.map((e) => [e.id, e]));
        const incomingIds = resolved.filter((r) => r.id).map((r) => r.id as string);
        for (const lineId of incomingIds) {
          if (!existingById.has(lineId)) throw { _appCode: 404, message: "Order item not found." };
        }
        const toRemove = existing.filter((e) => !incomingIds.includes(e.id)).map((e) => e.id);

        // ── Serialise against production scheduling and roasting ──────────────
        // Every EXISTING line this request touches, locked on the demand key those two
        // operations already use, before any demand-dependent decision below.
        await lockOrderEditDemandKeys(tx, [...incomingIds, ...toRemove]);

        // ── Then the row locks, in the canonical order, before any write ──────
        // StockAllocation → FinishedGoodsLot → OrderItem is the order every lifecycle
        // path takes, and this transaction ends up needing all three: the release and
        // trim helpers claim allocations and their lots, and the updates below write the
        // OrderItem rows. Taken lazily they would arrive in the opposite order — the
        // OrderItem written first, then the allocations reached for by the trim — which
        // is precisely the inversion that made cancel deadlock against preparation review
        // and that this helper exists to prevent. Cheap when there is nothing to lock.
        await lockOrderLifecycleResources(tx, id);

        // ── The lifecycle gate, re-asked under the locks ──────────────────────
        // The gate above ran on an unlocked read taken before this transaction held
        // anything. Cancel and complete both take the line locks acquired just now
        // before they may write Order.status, so holding them means no such transition
        // can commit from here on, and one that committed while this edit was waiting is
        // visible to this read. Without it an order cancelled mid-wait would still be
        // restructured — the gate would have been decided on a status that no longer
        // exists.
        const locked = await tx.order.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        });
        assertStructuralEditAllowed(locked.status);

        // Authoritative re-read now that nothing else can be moving these lines.
        const live = await tx.orderItem.findMany({
          where: { id: { in: [...incomingIds, ...toRemove] } },
          select: {
            id: true, quantityKg: true, quantityUnits: true,
            deliveredQty: true, deliveredUnits: true,
            productSkuId: true, productId: true,
          },
        });
        const liveById = new Map<string, LiveLine>(live.map((l) => [l.id, l]));

        // ── Validate everything BEFORE mutating anything ──────────────────────
        for (const line of resolved) {
          if (!line.id) continue;
          const current = liveById.get(line.id);
          if (!current) throw { _appCode: 404, message: "Order item not found." };
          assertNotBelowDelivered(current, line);
          await assertShrinkNotBelowProduction(tx, current, line);
          await assertIdentityChangeAllowed(tx, current, line);
        }
        for (const removeId of toRemove) {
          const current = liveById.get(removeId);
          if (current) await validateLineRemoval(tx, current);
        }

        // ── Removals: hand back both denominations, then delete ───────────────
        for (const removeId of toRemove) {
          await releaseAllReservations(tx, removeId);
        }
        if (toRemove.length > 0) {
          await tx.orderItem.deleteMany({ where: { id: { in: toRemove } } });
        }

        // ── Updates, then reconcile what each line still needs ────────────────
        for (const line of resolved) {
          if (!line.id) continue;
          await tx.orderItem.update({
            where: { id: line.id },
            data: {
              beanTypeName:  line.beanTypeName,
              quantityKg:    line.quantityKg,
              quantityUnits: line.quantityUnits,
              productId:     line.productId,
              productSkuId:  line.productSkuId,
              // remainingQty is owned by recalcOrderItemStatus after any production event;
              // writing the ordered quantity here corrupts post-production values.
            },
          });
          await reconcileLineReservations(tx, line.id);
        }

        // ── Additions ─────────────────────────────────────────────────────────
        for (const line of resolved) {
          if (line.id) continue;
          await tx.orderItem.create({
            data: {
              orderId:       id,
              beanTypeName:  line.beanTypeName,
              quantityKg:    line.quantityKg,
              quantityUnits: line.quantityUnits,
              productId:     line.productId,
              productSkuId:  line.productSkuId,
              remainingQty:  line.quantityKg,
            },
          });
        }

        await appendOrderActivity(tx, {
          orderId: id,
          type: "ORDER_ITEMS_EDITED",
          message:
            `Order lines edited by ${user.name}: ` +
            `${resolved.filter((r) => r.id).length} changed, ` +
            `${resolved.filter((r) => !r.id).length} added, ${toRemove.length} removed.`,
          authorId: user.id,
          authorName: user.name,
          metadata: {
            changed: resolved.filter((r) => r.id).map((r) => ({
              orderItemId: r.id, quantityUnits: r.quantityUnits, quantityKg: r.quantityKg,
            })),
            added: resolved.filter((r) => !r.id).length,
            removed: toRemove,
          },
        });
      }

      if (Object.keys(orderData).length > 0) {
        await tx.order.update({ where: { id }, data: orderData });
      }

      return tx.order.findUnique({
        where: { id },
        include: { customer: true, items: true },
      });
    }, TX_OPTS);

    return NextResponse.json(result);
  } catch (err) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}

/**
 * Physically delete an order.
 *
 * Distinct from cancellation, and far narrower: an order that has done anything at all is
 * cancelled, never erased. Deletion is for the order raised by mistake five minutes ago.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireSub("orders", "delete");
  if (error) return error;

  const { id } = await params;

  try {
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id },
        select: { id: true, items: { select: { id: true } } },
      });
      if (!order) throw { _appCode: 404, message: "Order not found." };

      const itemIds = order.items.map((i) => i.id);

      // The same demand keys the edit path takes, for the same reason: removing a line is
      // the most complete quantity change there is.
      await lockOrderEditDemandKeys(tx, itemIds);

      // And the same canonical row-lock order, for the same reason: this transaction
      // releases allocations and then deletes the order rows above them.
      await lockOrderLifecycleResources(tx, id);

      const live = await tx.orderItem.findMany({
        where: { id: { in: itemIds } },
        select: {
          id: true, quantityKg: true, quantityUnits: true,
          deliveredQty: true, deliveredUnits: true,
          productSkuId: true, productId: true,
        },
      });

      // Validate every line first, so a single line with history refuses the whole delete
      // rather than the order being half dismantled.
      for (const item of live) {
        if (item.deliveredQty > 0 || item.deliveredUnits > 0) {
          throw {
            _appCode: 409,
            message:
              "Cannot delete this order because it has production, QC, delivery, or inventory history. Cancel or close the order instead.",
          };
        }
        const history = await lineHistory(tx, item.id);
        if (history.batches > 0 || history.deliveries > 0 || history.productionOrders > 0) {
          throw {
            _appCode: 409,
            message:
              "Cannot delete this order because it has production, QC, delivery, or inventory history. Cancel or close the order instead.",
          };
        }
      }

      // Release before the cascade. StockAllocation cascades from OrderItem, but the lot
      // counters are maintained only by the release helpers — letting the cascade run first
      // leaves stock permanently marked as promised to an order that no longer exists.
      for (const item of live) await releaseAllReservations(tx, item.id);

      await tx.order.delete({ where: { id } });
    }, TX_OPTS);

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
