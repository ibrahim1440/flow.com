import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function POST(request: Request) {
  const { error, user } = await requireSub("inventory", "adjust");
  if (error) return error;

  const body = await request.json();
  const { entityId, newActualQuantity, notes } = body;

  if (!entityId || newActualQuantity === undefined || newActualQuantity === null) {
    return NextResponse.json(
      { error: "entityId and newActualQuantity are required." },
      { status: 400 }
    );
  }
  if (newActualQuantity < 0) {
    return NextResponse.json(
      { error: "newActualQuantity cannot be negative." },
      { status: 400 }
    );
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const bean = await tx.greenBean.findUnique({
        where: { id: entityId },
        select: { id: true, quantityKg: true },
      });
      if (!bean) throw { _appCode: 404, message: "Green bean not found." };

      const previousQuantity = bean.quantityKg;
      const quantityChanged = +( newActualQuantity - previousQuantity).toFixed(4);

      // No-op: floating-point safe threshold of 1g
      if (Math.abs(quantityChanged) < 0.001) {
        return { noChange: true as const, currentQuantity: previousQuantity };
      }

      await tx.inventoryMovement.create({
        data: {
          type: "ADJUSTMENT",
          category: "RAW_MATERIAL",
          referenceEntityId: entityId,
          quantityChanged,
          previousQuantity,
          newQuantity: newActualQuantity,
          sourceDocType: "MANUAL_ADJUSTMENT",
          sourceDocId: null,
          userId: user.id,
          notes: notes ?? null,
        },
      });

      const updatedBean = await tx.greenBean.update({
        where: { id: entityId },
        data: { quantityKg: newActualQuantity },
      });

      return { noChange: false as const, updatedBean, quantityChanged };
    });

    if (outcome.noChange) {
      return NextResponse.json({
        message: "No change recorded. Quantity already matches the system value.",
        currentQuantity: outcome.currentQuantity,
      });
    }

    return NextResponse.json(outcome, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
