import { NextResponse } from "@/lib/api-response";
import { requireAnySub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { reorderCategories } from "@/lib/services/item-categories";
import { refusal } from "@/lib/inventory/category-response";

/** POST { parentId: string | null, ids: string[] } — the new order of one level of the tree. */
export async function POST(request: Request) {
  const { user, error } = await requireAnySub("inventory", ["receive", "adjust"]);
  if (error) return error;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : null;
  try {
    const r = await reorderCategories(parentId, body.ids, { id: user.id, name: user.name });
    return r.ok ? NextResponse.json(r.data) : refusal(r);
  } catch (err) {
    return handlePrismaError(err);
  }
}
