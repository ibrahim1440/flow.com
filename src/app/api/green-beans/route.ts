import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function GET(request: Request) {
  // Production workers need to see bean names and stock when creating roasting batches
  const { error } = await requireAnyModule("inventory", "production");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const all = searchParams.get("all") === "1";

  const beans = await prisma.greenBean.findMany({
    where: all ? undefined : { isActive: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json(beans);
}

function nullify(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

export async function POST(request: Request) {
  const { error, user } = await requireSub("inventory", "receive");
  if (error) return error;

  const raw = await request.json();

  const quantityKg = Number(raw.quantityKg ?? 0);
  if (!Number.isFinite(quantityKg) || quantityKg < 0) {
    return NextResponse.json({ error: "quantityKg must be a non-negative number." }, { status: 400 });
  }

  const serialNumber =
    raw.serialNumber?.trim() ||
    `GB-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(Math.random() * 900 + 100)}`;

  const data = {
    serialNumber,
    beanType:   raw.beanType?.trim()   || "Unknown",
    beanTypeAr: nullify(raw.beanTypeAr),
    country:    raw.country?.trim()    || "Unknown",
    countryAr:  nullify(raw.countryAr),
    region:     nullify(raw.region),
    regionAr:   nullify(raw.regionAr),
    variety:    nullify(raw.variety),
    process:    nullify(raw.process),
    processAr:  nullify(raw.processAr),
    altitude:   nullify(raw.altitude),
    location:   nullify(raw.location),
    quantityKg,
  };

  try {
    let bean;
    if (quantityKg > 0) {
      bean = await prisma.$transaction(async (tx) => {
        const created = await tx.greenBean.create({ data });
        await tx.inventoryMovement.create({
          data: {
            type:              "IN",
            category:          "RAW_MATERIAL",
            referenceEntityId: created.id,
            quantityChanged:   quantityKg,
            previousQuantity:  0,
            newQuantity:       quantityKg,
            sourceDocType:     "MANUAL_ADJUSTMENT",
            sourceDocId:       null,
            userId:            user.id,
            notes:             "Opening balance",
          },
        });
        return created;
      });
    } else {
      bean = await prisma.greenBean.create({ data });
    }
    return NextResponse.json(bean, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
