import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function GET() {
  const { error } = await requireEdit("labels");
  if (error) return error;

  const skus = await prisma.productSKU.findMany({
    include: {
      product: { select: { id: true, productNameEn: true, productNameAr: true } },
    },
    orderBy: { skuCode: "asc" },
  });
  return NextResponse.json(skus);
}

export async function POST(request: Request) {
  const { error } = await requireEdit("labels");
  if (error) return error;

  try {
    const body = await request.json();

    if (!body.productId || typeof body.productId !== "string")
      return NextResponse.json({ error: "productId is required." }, { status: 400 });
    if (!body.skuCode || typeof body.skuCode !== "string" || !body.skuCode.trim())
      return NextResponse.json({ error: "skuCode is required." }, { status: 400 });

    const weightGrams = Number(body.weightGrams);
    if (!Number.isFinite(weightGrams) || weightGrams <= 0)
      return NextResponse.json({ error: "weightGrams must be a positive number." }, { status: 400 });

    const price = (body.price !== undefined && body.price !== null) ? Number(body.price) : 0;
    if (!Number.isFinite(price) || price < 0)
      return NextResponse.json({ error: "price must be a non-negative number." }, { status: 400 });

    const product = await prisma.coffeeProduct.findUnique({ where: { id: body.productId } });
    if (!product)
      return NextResponse.json({ error: "Product not found." }, { status: 404 });

    const sku = await prisma.productSKU.create({
      data: {
        productId:   body.productId,
        skuCode:     body.skuCode.trim(),
        weightGrams,
        isBulk:      body.isBulk === true,
        price,
      },
    });
    return NextResponse.json(sku, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
