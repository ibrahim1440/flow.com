import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";

export async function GET() {
  const { error } = await requireModule("inventory");
  if (error) return error;

  const movements = await prisma.inventoryMovement.findMany({
    orderBy: { timestamp: "desc" },
    take: 300,
  });

  // Batch-enrich: collect unique IDs per category
  const rawIds = [...new Set(
    movements.filter((m) => m.category === "RAW_MATERIAL" && m.referenceEntityId).map((m) => m.referenceEntityId!)
  )];
  const fglIds = [...new Set(
    movements.filter((m) => m.category === "FINISHED_GOODS" && m.referenceEntityId).map((m) => m.referenceEntityId!)
  )];
  const empIds = [...new Set(movements.filter((m) => m.userId).map((m) => m.userId!))];

  const [beans, lots, emps] = await Promise.all([
    rawIds.length
      ? prisma.greenBean.findMany({
          where: { id: { in: rawIds } },
          select: { id: true, beanType: true, beanTypeAr: true },
        })
      : [],
    fglIds.length
      ? prisma.finishedGoodsLot.findMany({
          where: { id: { in: fglIds } },
          select: {
            id: true,
            batchNumber: true,
            product: { select: { productNameEn: true, productNameAr: true } },
          },
        })
      : [],
    empIds.length
      ? prisma.employee.findMany({
          where: { id: { in: empIds } },
          select: { id: true, name: true },
        })
      : [],
  ]);

  const beanMap = new Map(beans.map((b) => [b.id, b]));
  const fglMap = new Map(lots.map((l) => [l.id, l]));
  const empMap = new Map(emps.map((e) => [e.id, e.name]));

  const enriched = movements.map((m) => {
    let entityLabel: string | null = null;
    let entityLabelAr: string | null = null;

    if (m.referenceEntityId) {
      if (m.category === "RAW_MATERIAL") {
        const b = beanMap.get(m.referenceEntityId);
        entityLabel = b?.beanType ?? null;
        entityLabelAr = b?.beanTypeAr ?? null;
      } else {
        const l = fglMap.get(m.referenceEntityId);
        entityLabel = l?.batchNumber ?? null;
        entityLabelAr = l?.product?.productNameAr ?? l?.product?.productNameEn ?? null;
      }
    }

    return {
      ...m,
      entityLabel,
      entityLabelAr,
      userName: m.userId ? (empMap.get(m.userId) ?? null) : null,
    };
  });

  return NextResponse.json(enriched);
}
