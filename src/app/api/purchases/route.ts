import { flushPostings } from "@/lib/accounting/ops/cost-ledger";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { parsePeriod, periodStart } from "@/lib/inventory/purchases-query";
import { receiveGreen } from "@/lib/services/purchase-receipts";

/**
 * The purchase register. Without parameters: the newest 200 (unchanged). With `period` (30 | 90 |
 * 365 | all) the rows are those dated inside the period, up to 1,000 — the page's period filter
 * (Figma 221:748). The CSV of the same period and sort: GET /api/purchases/export.
 */
export async function GET(request: Request) {
  const { error } = await requireModule("inventory");
  if (error) return error;

  const sp = new URL(request.url).searchParams;
  const start = sp.has("period") ? periodStart(parsePeriod(sp.get("period"))) : null;
  const purchases = await prisma.purchaseRecord.findMany({
    where: start ? { purchaseDate: { gte: start } } : undefined,
    orderBy: [{ purchaseDate: "desc" }, { createdAt: "desc" }],
    take: sp.has("period") ? 1000 : 200,
    include: { supplier: true },
  });
  return NextResponse.json(purchases);
}

export async function POST(request: Request) {
  const { error, user } = await requireSub("inventory", "receive");
  if (error) return error;

  const body = await request.json();
  const { supplierId, itemId, quantity, costPerUnit, purchaseDate, notes } = body;

  if (!supplierId || !itemId || !quantity || !costPerUnit || !purchaseDate) {
    return NextResponse.json(
      { error: "supplierId, itemId, quantity, costPerUnit, and purchaseDate are required." },
      { status: 400 }
    );
  }
  // JSON 1e9999 parses to Infinity, which passes `<= 0` and is stored in the double precision
  // stock and cost columns; a negative cost writes a negative totalCost. A string is no amount.
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: "quantity must be a finite number greater than zero." }, { status: 400 });
  }
  if (typeof costPerUnit !== "number" || !Number.isFinite(costPerUnit) || costPerUnit <= 0) {
    return NextResponse.json({ error: "costPerUnit must be a finite number greater than zero." }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // The shared receive service (src/lib/services/purchase-receipts.ts): the lock, the purchase record, the IN
      // movement, the lot's balance and the GRN (cost + entry), exactly as this route always booked them.
      const { purchase, updatedBean } = await receiveGreen(tx, user, { supplierId, greenBeanId: itemId, quantity, costPerUnit, purchaseDate: new Date(purchaseDate), notes: notes ?? null });
      await flushPostings(tx);
      return { purchase, updatedBean };
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
