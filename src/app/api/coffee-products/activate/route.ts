import { NextResponse } from "@/lib/api-response";
import { requireEdit } from "@/lib/auth-server";
import { parseSelection, selectionWhere } from "@/lib/services/product-catalog";
import { bulkUpdate } from "@/lib/services/product-catalog-db";

/**
 * Bulk «تفعيل» / deactivate (Figma 256:3410 selection bar). Body: `{ productIds, isActive }` or
 * `{ filter, excludeIds?, isActive }` (see ../move). One transaction. A deactivated product and
 * all its SKUs leave the new-order product pickers; existing orders are untouched. Response
 * `{ updated, ids, skipped: [{ id, reason }] }`.
 */
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
  if (typeof b.isActive !== "boolean") return NextResponse.json({ error: "isActive must be true or false.", field: "isActive" }, { status: 400 });
  const sel = parseSelection(b);
  if (!sel.ok) return NextResponse.json({ error: sel.error, field: sel.field }, { status: 400 });
  return bulkUpdate(selectionWhere(sel.value), sel.value, { isActive: b.isActive });
}
