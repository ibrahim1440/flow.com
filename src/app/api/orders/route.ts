import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

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
    },
  });
  return NextResponse.json(orders);
}

type RawItem = {
  beanTypeName: string;
  quantityKg:   unknown;
  greenBeanId?: string;
  productId?:   string;
  productSkuId?: string;
};

type ResolvedItem = {
  beanTypeName: string;
  quantityKg:   number;
  greenBeanId:  string | null;
  remainingQty: number;
  productId:    string | null;
  productSkuId: string | null;
};

async function resolveItems(
  items: RawItem[]
): Promise<{ ok: true; items: ResolvedItem[] } | { ok: false; error: NextResponse }> {
  const resolved: ResolvedItem[] = [];

  for (const item of items) {
    const qty = Number(item.quantityKg);
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, error: NextResponse.json({ error: "quantityKg must be a positive number." }, { status: 400 }) };
    }

    let resolvedProductId:    string | null = null;
    let resolvedProductSkuId: string | null = null;

    if (typeof item.productSkuId === "string" && item.productSkuId) {
      const sku = await prisma.productSKU.findUnique({ where: { id: item.productSkuId } });
      if (!sku)
        return { ok: false, error: NextResponse.json({ error: "Product SKU not found." }, { status: 400 }) };
      if (typeof item.productId === "string" && item.productId && sku.productId !== item.productId)
        return { ok: false, error: NextResponse.json({ error: "SKU does not belong to the specified product." }, { status: 400 }) };
      resolvedProductId    = sku.productId;
      resolvedProductSkuId = sku.id;
    } else if (typeof item.productId === "string" && item.productId) {
      const product = await prisma.coffeeProduct.findUnique({ where: { id: item.productId } });
      if (!product)
        return { ok: false, error: NextResponse.json({ error: "Product not found." }, { status: 400 }) };
      resolvedProductId = product.id;
    }

    resolved.push({
      beanTypeName: item.beanTypeName,
      quantityKg:   qty,
      greenBeanId:  item.greenBeanId || null,
      remainingQty: qty,
      productId:    resolvedProductId,
      productSkuId: resolvedProductSkuId,
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

    const orderData = {
      customerId:        body.customerId as string,
      quotationNumber:   typeof body.quotationNumber === "string" ? body.quotationNumber.trim() || null : null,
      quotationSentDate: body.quotationSentDate ? new Date(body.quotationSentDate) : null,
      notes:             typeof body.notes === "string" ? body.notes.trim() || null : null,
    };

    const result = await resolveItems(items as RawItem[]);
    if (!result.ok) return result.error;
    const resolvedItems = result.items;

    const beanIds = [...new Set(
      resolvedItems
        .filter((i) => i.greenBeanId)
        .map((i) => i.greenBeanId as string)
    )];

    if (beanIds.length > 0) {
      const greenBeans = await prisma.greenBean.findMany({ where: { id: { in: beanIds } } });
      const stockMap = new Map(greenBeans.map((b) => [b.id, b.quantityKg]));

      const demandMap = new Map<string, number>();
      for (const item of resolvedItems) {
        if (!item.greenBeanId) continue;
        demandMap.set(item.greenBeanId, (demandMap.get(item.greenBeanId) || 0) + item.quantityKg);
      }

      const insufficient: string[] = [];
      for (const [beanId, demand] of demandMap) {
        const available = stockMap.get(beanId) ?? 0;
        if (demand > available) {
          const bean = greenBeans.find((b) => b.id === beanId);
          insufficient.push(`${bean?.beanType ?? "Unknown"}: need ${demand}kg, available ${available}kg`);
        }
      }

      if (insufficient.length > 0) {
        return NextResponse.json(
          { error: "Insufficient stock", details: insufficient },
          { status: 400 }
        );
      }
    }

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
