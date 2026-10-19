import { NextResponse } from "next/server";
import { requireEdit } from "@/lib/auth-server";
import { parseSelection, selectionWhere, text } from "@/lib/services/product-catalog";
import { bulkUpdate } from "@/lib/services/product-catalog-db";

/**
 * Bulk «نقل إلى تصنيف» (Figma 256:3410 selection bar). Body: `{ productIds, categoryId | null }`,
 * or `{ filter: { q, categoryId, status }, excludeIds?, categoryId | null }` for «تحديد كل
 * النتائج» (everything the filter matches, not only the visible page). `categoryId: null` moves
 * to «بلا تصنيف». One transaction; the category must exist and not be archived. Moving writes no
 * stock movement. Response `{ updated, ids, skipped: [{ id, reason }] }`.
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
  if (!("categoryId" in b)) return NextResponse.json({ error: "categoryId is required (null for «بلا تصنيف»).", field: "categoryId" }, { status: 400 });
  if (b.categoryId !== null && typeof b.categoryId !== "string")
    return NextResponse.json({ error: "categoryId must be an id or null.", field: "categoryId" }, { status: 400 });
  const sel = parseSelection(b);
  if (!sel.ok) return NextResponse.json({ error: sel.error, field: sel.field }, { status: 400 });
  return bulkUpdate(selectionWhere(sel.value), sel.value, { categoryId: text(b.categoryId) });
}
