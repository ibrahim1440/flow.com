import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { planFulfilment, explodeBom, type BomRequirement } from "@/lib/services/finished-products";

// Read-only fulfilment check for a set of prospective order lines.
//
// This is what the sales screen calls while the user is still typing, so it reserves
// NOTHING: it reports what the shelf could cover right now. The binding reservation
// happens later, inside the order's own transaction, and can legitimately come out lower
// if someone else buys the same stock in between.

type RawLine = { productSkuId?: unknown; quantityUnits?: unknown };

export async function POST(request: Request) {
  const { error } = await requireModule("orders");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { lines } = (body ?? {}) as { lines?: unknown };
  if (!Array.isArray(lines) || lines.length === 0)
    return NextResponse.json({ error: "lines must be a non-empty array." }, { status: 400 });

  const parsed: { productSkuId: string; quantityUnits: number }[] = [];
  for (const raw of lines as RawLine[]) {
    if (typeof raw.productSkuId !== "string" || !raw.productSkuId)
      return NextResponse.json({ error: "Each line requires a productSkuId." }, { status: 400 });

    const units = Number(raw.quantityUnits);
    if (!Number.isInteger(units) || units <= 0)
      return NextResponse.json(
        { error: `quantityUnits for ${raw.productSkuId} must be a whole number greater than zero.` },
        { status: 400 }
      );

    parsed.push({ productSkuId: raw.productSkuId, quantityUnits: units });
  }

  try {
    const skuIds = [...new Set(parsed.map((l) => l.productSkuId))];
    const known = await prisma.productSKU.findMany({
      where: { id: { in: skuIds } },
      select: { id: true },
    });
    if (known.length !== skuIds.length)
      return NextResponse.json({ error: "One or more products do not exist." }, { status: 400 });

    const plan = await planFulfilment(prisma, parsed);

    // For every line that cannot be met from the shelf, show what producing the shortfall
    // would consume. Section 6: only the shortfall reaches production, never the whole line.
    const withRequirements = await Promise.all(
      plan.map(async (row) => {
        const bom: BomRequirement[] =
          row.productionRequiredUnits > 0
            ? await explodeBom(prisma, row.productSkuId, row.productionRequiredUnits)
            : [];
        return {
          ...row,
          productionRequirement:
            row.productionRequiredUnits > 0
              ? {
                  units: row.productionRequiredUnits,
                  components: bom,
                  // A missing BOM is reported rather than silently treated as "nothing
                  // needed" — it means the SKU cannot actually be produced yet.
                  hasBom: bom.length > 0,
                  blockedBy: bom.filter((c) => c.shortfall > 0).map((c) => c.label),
                }
              : null,
        };
      })
    );

    return NextResponse.json({
      lines: withRequirements,
      totals: {
        orderedUnits: withRequirements.reduce((s, r) => s + r.orderedUnits, 0),
        allocatedUnits: withRequirements.reduce((s, r) => s + r.allocatedUnits, 0),
        productionRequiredUnits: withRequirements.reduce((s, r) => s + r.productionRequiredUnits, 0),
      },
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}
