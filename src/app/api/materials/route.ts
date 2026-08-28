import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

// Stocked packaging materials: bags, labels, cartons. These are what a BOM's MATERIAL
// components consume. Before this existed, PurchaseType.PACKAGING recorded the cost of
// buying bags and nothing recorded holding them, so a BOM had nothing real to point at.

const MATERIAL_CATEGORIES = ["PACKAGING", "LABEL", "CONSUMABLE", "OTHER"] as const;
const UNITS_OF_MEASURE = ["UNIT", "KG", "GRAM", "PIECE"] as const;

const isCategory = (v: unknown): v is (typeof MATERIAL_CATEGORIES)[number] =>
  typeof v === "string" && (MATERIAL_CATEGORIES as readonly string[]).includes(v);
const isUom = (v: unknown): v is (typeof UNITS_OF_MEASURE)[number] =>
  typeof v === "string" && (UNITS_OF_MEASURE as readonly string[]).includes(v);

export async function GET(request: Request) {
  const { error } = await requireAnyModule("inventory", "packaging", "production");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const activeOnly = searchParams.get("activeOnly") !== "false";
  const q = (searchParams.get("q") ?? "").trim();

  try {
    const items = await prisma.materialItem.findMany({
      where: {
        ...(activeOnly ? { isActive: true } : {}),
        ...(q
          ? {
              OR: [
                { code: { contains: q, mode: "insensitive" as const } },
                { name: { contains: q, mode: "insensitive" as const } },
                { nameAr: { contains: q, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      include: { _count: { select: { bomComponents: true } } },
      orderBy: [{ isActive: "desc" }, { category: "asc" }, { code: "asc" }],
      take: 500,
    });

    return NextResponse.json(
      items.map((m) => ({
        id: m.id,
        code: m.code,
        name: m.name,
        nameAr: m.nameAr,
        category: m.category,
        unitOfMeasure: m.unitOfMeasure,
        quantityOnHand: m.quantityOnHand,
        reorderPoint: m.reorderPoint,
        isActive: m.isActive,
        notes: m.notes,
        usedInProductCount: m._count.bomComponents,
        belowReorderPoint: m.reorderPoint > 0 && m.quantityOnHand <= m.reorderPoint,
      }))
    );
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function POST(request: Request) {
  const { error } = await requireEdit("inventory");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const code = typeof b.code === "string" ? b.code.trim() : "";
  if (!code) return NextResponse.json({ error: "code is required." }, { status: 400 });

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required." }, { status: 400 });

  if (b.category !== undefined && !isCategory(b.category))
    return NextResponse.json(
      { error: `category must be one of: ${MATERIAL_CATEGORIES.join(", ")}.` },
      { status: 400 }
    );
  if (b.unitOfMeasure !== undefined && !isUom(b.unitOfMeasure))
    return NextResponse.json(
      { error: `unitOfMeasure must be one of: ${UNITS_OF_MEASURE.join(", ")}.` },
      { status: 400 }
    );

  const quantityOnHand = b.quantityOnHand === undefined ? 0 : Number(b.quantityOnHand);
  if (!Number.isFinite(quantityOnHand) || quantityOnHand < 0)
    return NextResponse.json({ error: "quantityOnHand must be zero or more." }, { status: 400 });

  const reorderPoint = b.reorderPoint === undefined ? 0 : Number(b.reorderPoint);
  if (!Number.isFinite(reorderPoint) || reorderPoint < 0)
    return NextResponse.json({ error: "reorderPoint must be zero or more." }, { status: 400 });

  try {
    const clash = await prisma.materialItem.findUnique({ where: { code } });
    if (clash)
      return NextResponse.json({ error: `Material code "${code}" already exists.` }, { status: 409 });

    const item = await prisma.materialItem.create({
      data: {
        code,
        name,
        nameAr: typeof b.nameAr === "string" && b.nameAr.trim() ? b.nameAr.trim() : null,
        category: isCategory(b.category) ? b.category : "PACKAGING",
        unitOfMeasure: isUom(b.unitOfMeasure) ? b.unitOfMeasure : "PIECE",
        quantityOnHand,
        reorderPoint,
        isActive: b.isActive === undefined ? true : b.isActive === true,
        notes: typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null,
      },
    });
    return NextResponse.json(item, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
