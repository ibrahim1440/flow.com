import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { parseLedgerFilter } from "@/lib/inventory/ledger-query";
import { csvResponseHeaders, riyadhStamp, toCsv } from "@/lib/inventory/csv";
import { ledgerExportRows } from "@/lib/services/inventory-ledger";

/**
 * GET /api/inventory-movements/export?<the ledger's filters> — the filtered ledger as CSV (UTF-8 with
 * BOM, Riyadh time), newest first, at most 10,000 rows (the response says so in X-Export-Truncated
 * when there are more). Inventory module, read-only — the same access as reading the ledger.
 */
export async function GET(request: Request) {
  const { error } = await requireModule("inventory");
  if (error) return error;
  try {
    const { rows, truncated, total } = await ledgerExportRows(parseLedgerFilter(new URL(request.url).searchParams));
    const csv = toCsv(
      ["time_riyadh", "type", "category", "item", "item_ar", "code", "unit", "before", "after", "change", "source", "source_ref", "user", "notes", "movement_id"],
      rows.map((m) => [riyadhStamp(m.timestamp), m.type, m.category, m.entityLabel, m.entityLabelAr, m.entityCode, m.unit, m.previousQuantity, m.newQuantity, m.quantityChanged, m.sourceDocType, m.sourceRef, m.userName, m.notes, m.id]),
    );
    const stamp = riyadhStamp(new Date()).slice(0, 10);
    return new Response(csv, { headers: { ...csvResponseHeaders(`inventory-ledger-${stamp}.csv`), "X-Export-Rows": String(rows.length), "X-Export-Total": String(total), "X-Export-Truncated": truncated ? "1" : "0" } });
  } catch (err) {
    return handlePrismaError(err);
  }
}
