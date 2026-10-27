import { NextResponse } from "@/lib/api-response";
import { requireAnySub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { updateCategory } from "@/lib/services/item-categories";
import { refusal } from "@/lib/inventory/category-response";

type Params = { params: Promise<{ id: string }> };

/** PATCH { nameAr?, nameEn?, defaultUnit?, archived?: boolean } — rename, unit, archive / restore (never the type). */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireAnySub("inventory", ["receive", "adjust"]);
  if (error) return error;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  try {
    const r = await updateCategory(id, body, { id: user.id, name: user.name });
    return r.ok ? NextResponse.json(r.data) : refusal(r);
  } catch (err) {
    return handlePrismaError(err);
  }
}
