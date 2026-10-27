import { NextResponse } from "@/lib/api-response";
import { requireAnyModule, requireAnySub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { categoryTree, createCategory } from "@/lib/services/item-categories";
import { refusal } from "@/lib/inventory/category-response";

/**
 * Unified inventory — item categories (20261112090000_item_categories).
 *   GET  /api/inventory/categories[?archived=1]  → the tree (roots then their children) with item / low-stock counts.
 *   POST /api/inventory/categories                → { nameAr, nameEn?, parentId?, template? (new roots), defaultUnit? }.
 * Writes are catalogue maintenance: inventory › receive or adjust (as bean records and counts), audited in the
 * settings trail (section "inventory").
 */
export async function GET(request: Request) {
  const { error } = await requireAnyModule("inventory", "packaging", "production");
  if (error) return error;
  const archived = new URL(request.url).searchParams.get("archived") === "1";
  try {
    return NextResponse.json(await categoryTree({ includeArchived: archived }));
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireAnySub("inventory", ["receive", "adjust"]);
  if (error) return error;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  try {
    const r = await createCategory(body, { id: user.id, name: user.name });
    return r.ok ? NextResponse.json(r.data, { status: 201 }) : refusal(r);
  } catch (err) {
    return handlePrismaError(err);
  }
}
