import { onOpeningStock } from "@/lib/accounting/ops/inventory-events";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { greenLotFields, sackFields, sackMismatch } from "@/lib/services/green-lots";
import { receivingLocationId, setStockLocation } from "@/lib/services/stock-locations";

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

export async function POST(request: Request) {
  const { error, user } = await requireSub("inventory", "receive");
  if (error) return error;

  const raw = await request.json();

  const quantityKg = Number(raw.quantityKg ?? 0);
  if (!Number.isFinite(quantityKg) || quantityKg < 0) {
    return NextResponse.json({ error: "quantityKg must be a non-negative number." }, { status: 400 });
  }

  const sacks = sackFields(raw);
  if ("error" in sacks) return NextResponse.json({ ...sacks, code: "SACKS_INVALID" }, { status: 400 });

  // The lot form's fields, mapped once (src/lib/services/green-lots.ts) — the one-step purchase invoice uses the same.
  const data = { ...greenLotFields(raw), quantityKg };

  try {
    let bean;
    if (quantityKg > 0) {
      bean = await prisma.$transaction(async (tx) => {
        // Phase 3: the opening stock is received at a site, named explicitly (raw.locationId, active; else the
        // default receiving site) — this transaction is that one receipt.
        const locationId = await receivingLocationId(tx, raw.locationId);
        await setStockLocation(tx, locationId);
        const created = await tx.greenBean.create({ data });
        const movement = await tx.inventoryMovement.create({
          data: {
            type:              "IN",
            category:          "RAW_MATERIAL",
            referenceEntityId: created.id,
            quantityChanged:   quantityKg,
            previousQuantity:  0,
            newQuantity:       quantityKg,
            // An opening balance is receiving, not a count (review P3-8): its own label.
            sourceDocType:     "OPENING_BALANCE",
            sourceDocId:       created.id,
            userId:            user.id,
            notes:             "Opening balance",
            locationId,
          },
        });
        // Accounting A3: an opening balance carries no cost; the opening valuation costs it.
        await onOpeningStock(tx, { kind: "GREEN_BEAN", entityId: created.id, qty: quantityKg, actor: user.id, movementId: movement.id });
        return created;
      });
    } else {
      bean = await prisma.greenBean.create({ data });
    }
    // A soft warning only (the lot is saved): the sacks do not add up to the quantity received.
    const sackWarning = sackMismatch(bean.sackCount, bean.sackWeightKg, bean.quantityKg);
    return NextResponse.json(sackWarning ? { ...bean, sackWarning } : bean, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
