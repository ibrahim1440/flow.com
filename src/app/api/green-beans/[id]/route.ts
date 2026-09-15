import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
  const { error } = await requireSub("inventory", "adjust");
  if (error) return error;

  const { id } = await params;
  try {
    const body = await request.json();

    if ("quantityKg" in body) {
      return NextResponse.json(
        { error: "Inventory quantities cannot be modified directly. Please use the Inventory Adjustment or Purchase APIs." },
        { status: 400 }
      );
    }

    const {
      serialNumber, beanType, beanTypeAr,
      country, countryAr, region, regionAr,
      variety, process, processAr,
      altitude, location, isActive, receivedDate,
    } = body;

    const bean = await prisma.greenBean.update({
      where: { id },
      data: {
        serialNumber, beanType, beanTypeAr,
        country, countryAr, region, regionAr,
        variety, process, processAr,
        altitude, location, isActive,
        receivedDate: receivedDate ? new Date(receivedDate) : undefined,
      },
    });
    return NextResponse.json(bean);
  } catch (err) {
    return handlePrismaError(err);
  }
}

/**
 * Physically delete a green coffee.
 *
 * The previous implementation called delete and waited for a foreign-key error to protect
 * roasting history. That error could never arrive. Every reference to GreenBean is
 * ON DELETE SET NULL — RoastingBatch, ProductionOrder, OrderItem, CuppingSession and
 * CoffeeProduct.defaultGreenBeanId — CustomerRoastPreference is ON DELETE CASCADE, and the
 * two remaining references, PurchaseRecord.itemId and InventoryMovement.referenceEntityId,
 * are untyped strings with no constraint at all. So the delete always succeeded, the guard
 * was unreachable code, and the message it would have printed was never printed: every
 * batch roasted from that coffee silently lost the record of what it was roasted FROM,
 * every customer preference for it disappeared, and the purchase that received it and the
 * ledger rows that moved it were left pointing at nothing.
 *
 * Traceability is the one thing a roastery ERP cannot be casual about. So the references
 * are counted explicitly, and anything that represents history refuses the delete.
 *
 * ── Why a row lock, and why it is enough ───────────────────────────────────
 * Counting before deleting is only meaningful if nothing can add a reference in between.
 * The lock is taken on the GreenBean row itself, first, and held to commit — and the one
 * writer that matters already takes the same row: a roast decrements the bean with a
 * conditional UPDATE before it inserts its batch, and an UPDATE takes the row-exclusive
 * lock this SELECT ... FOR UPDATE waits for. So the two serialise whichever way round they
 * arrive: if the roast commits first, the count below sees its batch and refuses; if this
 * transaction commits first, the roast finds no bean to decrement and refuses. Neither can
 * leave a batch whose provenance has been nulled out from under it.
 *
 * No cycle is introduced: this transaction acquires GreenBean and nothing else, so it never
 * waits on another resource while holding it.
 */
export async function DELETE(_request: Request, { params }: Params) {
  const { error } = await requireSub("inventory", "adjust");
  if (error) return error;

  const { id } = await params;

  try {
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "GreenBean" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) throw { _appCode: 404, message: "Green bean not found." };

      // Counted, not inferred. Each of these is either operational history or a record
      // somebody entered on purpose; none of them may disappear as a side effect.
      const [batches, productionOrders, orderItems, cuppingSessions, preferences, products, purchases, movements] =
        await Promise.all([
          tx.roastingBatch.count({ where: { greenBeanId: id } }),
          tx.productionOrder.count({ where: { greenBeanId: id } }),
          tx.orderItem.count({ where: { greenBeanId: id } }),
          tx.cuppingSession.count({ where: { greenBeanId: id } }),
          tx.customerRoastPreference.count({ where: { greenBeanId: id } }),
          tx.coffeeProduct.count({ where: { defaultGreenBeanId: id } }),
          // Untyped links: a GREEN_BEAN purchase records the bean in itemId, and the ledger
          // records it in referenceEntityId. Neither has a constraint behind it, which is
          // exactly why they have to be checked here rather than left to the database.
          tx.purchaseRecord.count({ where: { type: "GREEN_BEAN", itemId: id } }),
          tx.inventoryMovement.count({ where: { category: "RAW_MATERIAL", referenceEntityId: id } }),
        ]);

      const total =
        batches + productionOrders + orderItems + cuppingSessions + preferences + products +
        purchases + movements;

      if (total > 0) {
        throw {
          _appCode: 409,
          message:
            "Green coffee cannot be deleted because it has operational history — roasting, " +
            "production, orders, cupping, purchases, stock movements, product defaults or " +
            "customer preferences still refer to it. Deactivate it instead.",
        };
      }

      await tx.greenBean.delete({ where: { id } });
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
