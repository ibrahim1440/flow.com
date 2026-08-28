import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { explodeBom } from "@/lib/services/finished-products";

type Params = { params: Promise<{ id: string }> };

// The bill of materials for one sellable unit of a SKU.
//
// A ROASTED_COFFEE line consumes kilograms of roasted/intermediate stock and names a
// CoffeeProduct. It may NOT name a green bean: green coffee is consumed by roasting
// alone, and the chain is
//   GreenBean -> Roasting -> roasted stock -> Packaging (this BOM) -> FinishedGoodsLot.
// A MATERIAL line consumes whole pieces of a MaterialItem (bags, labels, cartons).

type RawComponent = {
  type?: unknown;
  coffeeProductId?: unknown;
  materialItemId?: unknown;
  quantityPerUnit?: unknown;
  notes?: unknown;
};

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireAnyModule("inventory", "orders", "production");
  if (error) return error;

  const { id } = await params;

  try {
    const sku = await prisma.productSKU.findUnique({ where: { id }, select: { id: true } });
    if (!sku) return NextResponse.json({ error: "Product not found." }, { status: 404 });

    const components = await prisma.bomComponent.findMany({
      where: { productSkuId: id },
      include: {
        coffeeProduct: { select: { id: true, productNameEn: true } },
        materialItem: {
          select: { id: true, code: true, name: true, quantityOnHand: true, unitOfMeasure: true },
        },
      },
      orderBy: [{ type: "asc" }, { createdAt: "asc" }],
    });

    return NextResponse.json({
      productSkuId: id,
      components,
      perUnit: await explodeBom(prisma, id, 1),
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}

/**
 * Replace the whole BOM for this SKU.
 *
 * PUT rather than per-row CRUD because a bill of materials is edited as one document:
 * a partial save that dropped the bag but kept the label would produce a BOM nobody
 * intended. The delete and the re-create run in one transaction, so a failed validation
 * leaves the previous BOM exactly as it was.
 */
export async function PUT(request: Request, { params }: Params) {
  const { error } = await requireEdit("inventory");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { components } = (body ?? {}) as { components?: unknown };
  if (!Array.isArray(components))
    return NextResponse.json({ error: "components must be an array." }, { status: 400 });

  type Parsed = {
    type: "ROASTED_COFFEE" | "MATERIAL";
    coffeeProductId: string | null;
    materialItemId: string | null;
    quantityPerUnit: number;
    unitOfMeasure: "KG" | "PIECE";
    notes: string | null;
  };

  const parsed: Parsed[] = [];
  const seenCoffee = new Set<string>();
  const seenMaterial = new Set<string>();

  for (const raw of components as RawComponent[]) {
    const qty = Number(raw.quantityPerUnit);
    if (!Number.isFinite(qty) || qty <= 0)
      return NextResponse.json(
        { error: "Each component needs a quantityPerUnit greater than zero." },
        { status: 400 }
      );

    const notes = typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null;

    if (raw.type === "ROASTED_COFFEE") {
      if (typeof raw.coffeeProductId !== "string" || !raw.coffeeProductId)
        return NextResponse.json(
          { error: "A ROASTED_COFFEE component requires a coffeeProductId." },
          { status: 400 }
        );
      if (seenCoffee.has(raw.coffeeProductId))
        return NextResponse.json(
          { error: "The same coffee appears twice in this BOM. Combine the quantities instead." },
          { status: 400 }
        );
      seenCoffee.add(raw.coffeeProductId);
      parsed.push({
        type: "ROASTED_COFFEE",
        coffeeProductId: raw.coffeeProductId,
        materialItemId: null,
        quantityPerUnit: qty,
        unitOfMeasure: "KG",
        notes,
      });
      continue;
    }

    if (raw.type === "MATERIAL") {
      if (typeof raw.materialItemId !== "string" || !raw.materialItemId)
        return NextResponse.json(
          { error: "A MATERIAL component requires a materialItemId." },
          { status: 400 }
        );
      if (seenMaterial.has(raw.materialItemId))
        return NextResponse.json(
          { error: "The same material appears twice in this BOM. Combine the quantities instead." },
          { status: 400 }
        );
      seenMaterial.add(raw.materialItemId);
      parsed.push({
        type: "MATERIAL",
        coffeeProductId: null,
        materialItemId: raw.materialItemId,
        quantityPerUnit: qty,
        unitOfMeasure: "PIECE",
        notes,
      });
      continue;
    }

    return NextResponse.json(
      { error: "Each component's type must be ROASTED_COFFEE or MATERIAL." },
      { status: 400 }
    );
  }

  try {
    const sku = await prisma.productSKU.findUnique({
      where: { id },
      select: { id: true, weightGrams: true },
    });
    if (!sku) return NextResponse.json({ error: "Product not found." }, { status: 404 });

    // Referenced rows must exist, checked before anything is deleted.
    if (seenCoffee.size > 0) {
      const found = await prisma.coffeeProduct.findMany({
        where: { id: { in: [...seenCoffee] } },
        select: { id: true },
      });
      if (found.length !== seenCoffee.size)
        return NextResponse.json({ error: "One or more coffee products do not exist." }, { status: 400 });
    }
    if (seenMaterial.size > 0) {
      const found = await prisma.materialItem.findMany({
        where: { id: { in: [...seenMaterial] } },
        select: { id: true },
      });
      if (found.length !== seenMaterial.size)
        return NextResponse.json({ error: "One or more material items do not exist." }, { status: 400 });
    }

    // Sanity check, reported as a warning rather than an error: the coffee in the BOM
    // should roughly match the SKU's net weight. A 250 g SKU whose BOM consumes 1 kg of
    // roasted coffee is almost certainly a typo, but roast loss and deliberate overfill
    // are real, so this informs rather than blocks.
    const coffeeKg = parsed
      .filter((p) => p.type === "ROASTED_COFFEE")
      .reduce((sum, p) => sum + p.quantityPerUnit, 0);
    const netKg = sku.weightGrams / 1000;
    const warnings: string[] = [];
    if (coffeeKg > 0 && (coffeeKg > netKg * 1.5 || coffeeKg < netKg * 0.5)) {
      warnings.push(
        `BOM consumes ${Number(coffeeKg.toFixed(3))}kg of roasted coffee per unit but the SKU's net weight is ${Number(netKg.toFixed(3))}kg.`
      );
    }
    if (coffeeKg === 0) warnings.push("This BOM has no roasted coffee component.");

    const saved = await prisma.$transaction(async (tx) => {
      await tx.bomComponent.deleteMany({ where: { productSkuId: id } });
      for (const p of parsed) {
        await tx.bomComponent.create({ data: { productSkuId: id, ...p } });
      }
      return tx.bomComponent.findMany({
        where: { productSkuId: id },
        include: {
          coffeeProduct: { select: { id: true, productNameEn: true } },
          materialItem: { select: { id: true, code: true, name: true, quantityOnHand: true } },
        },
        orderBy: [{ type: "asc" }, { createdAt: "asc" }],
      });
    });

    return NextResponse.json({ productSkuId: id, components: saved, warnings });
  } catch (err) {
    return handlePrismaError(err);
  }
}
