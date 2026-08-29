import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireAuth } from "@/lib/auth-server";
import { canEdit } from "@/lib/auth";
import { handlePrismaError } from "@/lib/api-error";

export async function GET() {
  // Widened beyond `labels`: the coffee/origin list is the parent of every finished
  // product, so the Products section (gated on `inventory`) and the order and packaging
  // screens all need to read it. Gated on `labels` alone, the origin dropdown came back
  // empty — and therefore unusable — for anyone without the Labels module.
  const { error } = await requireAnyModule("labels", "inventory", "orders", "production", "packaging");
  if (error) return error;

  const products = await prisma.coffeeProduct.findMany({ orderBy: { productNameEn: "asc" } });
  return NextResponse.json(products);
}

function nullify(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

export async function POST(request: Request) {
  // Creating an origin is a catalog action, so edit rights on EITHER the Labels module
  // (where it used to live) or Inventory (which gates the Products section that now
  // offers it) are accepted. Deliberately not widened to read-only modules.
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canEdit(user.permissions, "labels") && !canEdit(user.permissions, "inventory")) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  try {
    const body = await request.json();

    if (!body.productNameEn || typeof body.productNameEn !== "string" || !body.productNameEn.trim())
      return NextResponse.json({ error: "productNameEn is required." }, { status: 400 });
    if (!body.countryEn || typeof body.countryEn !== "string" || !body.countryEn.trim())
      return NextResponse.json({ error: "countryEn is required." }, { status: 400 });

    let expectedRoastLoss: number | undefined;
    if (body.expectedRoastLoss !== undefined && body.expectedRoastLoss !== null && body.expectedRoastLoss !== "") {
      expectedRoastLoss = Number(body.expectedRoastLoss);
      if (!Number.isFinite(expectedRoastLoss) || expectedRoastLoss < 0 || expectedRoastLoss > 50)
        return NextResponse.json({ error: "expectedRoastLoss must be a number between 0 and 50." }, { status: 400 });
    }

    if (body.defaultGreenBeanId) {
      const bean = await prisma.greenBean.findUnique({ where: { id: body.defaultGreenBeanId } });
      if (!bean)
        return NextResponse.json({ error: "Default green bean not found." }, { status: 400 });
    }

    const product = await prisma.coffeeProduct.create({
      data: {
        productNameEn:     body.productNameEn.trim(),
        countryEn:         body.countryEn.trim(),
        productNameAr:     nullify(body.productNameAr),
        countryAr:         nullify(body.countryAr),
        regionEn:          nullify(body.regionEn),
        regionAr:          nullify(body.regionAr),
        varietyEn:         nullify(body.varietyEn),
        varietyAr:         nullify(body.varietyAr),
        processEn:         nullify(body.processEn),
        processAr:         nullify(body.processAr),
        altitude:          nullify(body.altitude),
        cupNotesEn:        nullify(body.cupNotesEn),
        cupNotesAr:        nullify(body.cupNotesAr),
        roastPathEn:       nullify(body.roastPathEn),
        roastPathAr:       nullify(body.roastPathAr),
        defaultGreenBeanId: (typeof body.defaultGreenBeanId === "string" && body.defaultGreenBeanId) ? body.defaultGreenBeanId : null,
        ...(expectedRoastLoss !== undefined ? { expectedRoastLoss } : {}),
      },
    });
    return NextResponse.json(product, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
