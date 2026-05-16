import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function GET() {
  const { error } = await requireModule("inventory");
  if (error) return error;

  const purchases = await prisma.purchaseRecord.findMany({
    orderBy: { purchaseDate: "desc" },
    include: { supplier: true },
  });
  return NextResponse.json(purchases);
}

export async function POST(request: Request) {
  const { error, user } = await requireSub("inventory", "adjust");
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
      const bean = await tx.greenBean.findUnique({
        where: { id: itemId },
        select: { id: true, quantityKg: true },
      });
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
