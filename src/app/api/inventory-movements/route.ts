import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { parseLedgerFilter } from "@/lib/inventory/ledger-query";
import { enrichMovements, ledgerPage } from "@/lib/services/inventory-ledger";

/**
 * The movement ledger (inventory module, read-only).
 *
 *   GET /api/inventory-movements                → the newest 300, enriched (unchanged contract).
 *   GET /api/inventory-movements?page=1&…       → { total, page, pageSize, rows } with the filters
 *     type, category, source (sourceDocType), q (item name / code / batch / note), entityId,
 *     sourceDocId, from, to; pageSize 10 | 25 | 50 | 100 (default 25).
 * Export of the same filter: GET /api/inventory-movements/export (CSV).
 */
export async function GET(request: Request) {
  const { error } = await requireModule("inventory");
  if (error) return error;

  const sp = new URL(request.url).searchParams;
  try {
    if (sp.has("page")) return NextResponse.json(await ledgerPage(parseLedgerFilter(sp)));
    const movements = await prisma.inventoryMovement.findMany({ orderBy: { timestamp: "desc" }, take: 300 });
    return NextResponse.json(await enrichMovements(movements));
  } catch (err) {
    return handlePrismaError(err);
  }
}
