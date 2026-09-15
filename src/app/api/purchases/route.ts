import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function GET() {
  const { error } = await requireModule("inventory");
  if (error) return error;

  const purchases = await prisma.purchaseRecord.findMany({
    orderBy: { purchaseDate: "desc" },
    take: 200,
    include: { supplier: true },
  });
  return NextResponse.json(purchases);
}

export async function POST(request: Request) {
  const { error, user } = await requireSub("inventory", "receive");
  if (error) return error;

  const body = await request.json();
  const { supplierId, itemId, quantity, costPerUnit, purchaseDate, notes } = body;

  if (!supplierId || !itemId || !quantity || !costPerUnit || !purchaseDate) {
    return NextResponse.json(
      { error: "supplierId, itemId, quantity, costPerUnit, and purchaseDate are required." },
      { status: 400 }
    );
  }
  if (quantity <= 0) {
    return NextResponse.json({ error: "quantity must be greater than zero." }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // ── Serialise against a concurrent delete of this coffee ────────────────
      // PurchaseRecord.itemId and InventoryMovement.referenceEntityId are untyped strings
      // with no foreign key behind them, so inserting them takes no lock on the coffee they
      // name and the database will not stop them naming one that is being deleted. Reading
      // the row first proves only that it existed a moment ago.
      //
      // Locking it is what makes the guard in DELETE /api/green-beans/[id] mean anything: that
      // route locks this same row, counts the references, and refuses if any exist. Taking the
      // lock BEFORE the loose rows are written puts the two transactions in a queue — either
      // the delete sees these rows and refuses, or this transaction finds the coffee gone and
      // rolls back. Without it the delete can count zero, commit, and leave a purchase and a
      // ledger entry describing stock that arrived for a coffee that no longer exists.
      //
      // FOR UPDATE rather than FOR KEY SHARE because this transaction goes on to update the
      // row anyway; it is the same lock, taken earlier, and it introduces no new ordering —
      // GreenBean is still the first thing this transaction acquires.
      const locked = await tx.$queryRaw<{ id: string; quantityKg: number }[]>`
        SELECT "id", "quantityKg" FROM "GreenBean" WHERE "id" = ${itemId} FOR UPDATE`;
      const bean = locked[0];
      if (!bean) throw { _appCode: 404, message: "Green bean not found." };

      const previousQuantity = bean.quantityKg;
      const newQuantity = previousQuantity + quantity;
      const totalCost = +(quantity * costPerUnit).toFixed(4);

      const purchase = await tx.purchaseRecord.create({
        data: {
          supplierId,
          type: "GREEN_BEAN",
          itemId,
          quantity,
          costPerUnit,
          totalCost,
          purchaseDate: new Date(purchaseDate),
          notes: notes ?? null,
          userId: user.id,
        },
        include: { supplier: true },
      });

      await tx.inventoryMovement.create({
        data: {
          type: "IN",
          category: "RAW_MATERIAL",
          referenceEntityId: itemId,
          quantityChanged: quantity,
          previousQuantity,
          newQuantity,
          sourceDocType: "PURCHASE",
          sourceDocId: purchase.id,
          userId: user.id,
          notes: notes ?? null,
        },
      });

      const updatedBean = await tx.greenBean.update({
        where: { id: itemId },
        data: { quantityKg: { increment: quantity } },
      });

      return { purchase, updatedBean };
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
