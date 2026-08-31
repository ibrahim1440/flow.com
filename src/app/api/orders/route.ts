import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { kgForUnits } from "@/lib/services/finished-products";

export async function GET(request: Request) {
  // Production and Dispatch workers need to read orders to see what to roast / deliver
  const { error } = await requireAnyModule("orders", "production", "dispatch");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const customerId = searchParams.get("customerId");

  const where: Record<string, unknown> = {};
  if (customerId) where.customerId = customerId;
  if (status) {
    const statusList = status.split(",");
    where.items = { some: { productionStatus: statusList.length === 1 ? status : { in: statusList } } };
  }

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      customer: { include: { roastPreferences: true } },
      items: {
        include: {
          roastingBatches: { include: { qcRecords: true } },
          deliveries: true,
          greenBean: true,
        },
      },
      // Order Operations S0: minimal owner projection — no permissions/pin/credential fields.
      owner: { select: { id: true, name: true, role: true } },
      activities: { orderBy: { createdAt: "asc" } },
    },
  });
  return NextResponse.json(orders);
}

type RawItem = {
  productSkuId?: unknown;
  quantityUnits?: unknown;
};

type ResolvedItem = {
  beanTypeName: string;
  quantityKg:   number;
  quantityUnits: number;
  greenBeanId:  string | null;
  remainingQty: number;
  productId:    string | null;
  productSkuId: string;
};

async function resolveItems(
  items: RawItem[]
): Promise<{ ok: true; items: ResolvedItem[] } | { ok: false; error: NextResponse }> {
  const resolved: ResolvedItem[] = [];

  for (const item of items) {
    // SKU-only. A sales line is now a quantity of one finished product; the coffee,
    // origin, pack size, price and BOM all follow from the SKU, so none of them is
    // asked for. Legacy bean-based lines stay readable but cannot be created any more.
    if (typeof item.productSkuId !== "string" || !item.productSkuId) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: "Each order line requires a productSkuId. Select a finished product." },
          { status: 400 }
        ),
      };
    }

    const units = Number(item.quantityUnits);
    if (!Number.isInteger(units) || units <= 0) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: "quantityUnits must be a whole number greater than zero." },
          { status: 400 }
        ),
      };
    }

    const sku = await prisma.productSKU.findUnique({
      where: { id: item.productSkuId },
      include: { product: { select: { id: true, productNameEn: true, defaultGreenBeanId: true } } },
    });
    if (!sku)
      return { ok: false, error: NextResponse.json({ error: "Product SKU not found." }, { status: 400 }) };
    if (!sku.isActive)
      return {
        ok: false,
        error: NextResponse.json(
          { error: `"${sku.skuCode}" is inactive and cannot be sold.` },
          { status: 400 }
        ),
      };

    resolved.push({
      // Kept populated for the dispatch, history and export screens that read it.
      beanTypeName: sku.product.productNameEn,
      // Derived from units — never supplied by the client, never a rival total.
      quantityKg: kgForUnits(sku, units),
      quantityUnits: units,
      // Traceability only. A sales order never draws on green coffee (section 7);
      // this records which bean the SKU is made from so production can follow the chain.
      greenBeanId: sku.product.defaultGreenBeanId ?? null,
      remainingQty: kgForUnits(sku, units),
      productId: sku.productId,
      productSkuId: sku.id,
    });
  }

  return { ok: true, items: resolved };
}

export async function POST(request: Request) {
  const { error } = await requireSub("orders", "create");
  if (error) return error;

  try {
    const body = await request.json();
    const { items } = body;

    if (!body.customerId || typeof body.customerId !== "string") {
      return NextResponse.json({ error: "customerId is required" }, { status: 400 });
    }

    // An order with no lines is not a smaller order, it is a stuck one: it consumes an
    // order number, can be approved and reviewed, aggregates to "Waiting Preparation
    // Review" forever (aggregatePreparationStatus returns that for an empty item list)
    // and can never reach Ready for Shipping. Refuse it at the door.
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: "An order must have at least one line." },
        { status: 400 }
      );
    }

    const orderData = {
      customerId:        body.customerId as string,
      quotationNumber:   typeof body.quotationNumber === "string" ? body.quotationNumber.trim() || null : null,
      quotationSentDate: body.quotationSentDate ? new Date(body.quotationSentDate) : null,
      notes:             typeof body.notes === "string" ? body.notes.trim() || null : null,
    };

    const result = await resolveItems(items as RawItem[]);
    if (!result.ok) return result.error;
    const resolvedItems = result.items;

    // No stock gate here, deliberately (section 7).
    //
    // Order creation used to refuse the order when green coffee was short. That belongs
    // to a different stage now: a sales order reserves FINISHED GOODS and nothing else,
    // and whatever the shelf cannot cover becomes a production requirement rather than a
    // rejection. Production is what consumes green coffee, against the SKU's BOM, and it
    // does its own raw-material check at that point.
    //
    // The fulfilment split is computed after creation — see
    // POST /api/orders/fulfillment-preview for the pre-submit view and the preparation
    // review for the binding reservation.

    let order;
    for (let attempt = 0; attempt < 5; attempt++) {
      const lastOrder = await prisma.order.findFirst({ orderBy: { orderNumber: "desc" } });
      const nextNumber = (lastOrder?.orderNumber || 0) + 1;
      try {
        order = await prisma.order.create({
          data: {
            ...orderData,
            orderNumber: nextNumber,
            items: {
              create: resolvedItems,
            },
          },
          include: { customer: true, items: true },
        });
        break;
      } catch (e: unknown) {
        const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : null;
        if (code === "P2002" && attempt < 4) continue;
        throw e;
      }
    }

    if (!order) throw new Error("Order creation failed after retries.");
    return NextResponse.json(order, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
