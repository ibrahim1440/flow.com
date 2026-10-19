import { NextResponse } from "next/server";
import { requireAnySub, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { getCountSession, updateCountSession } from "@/lib/services/inventory-counts";

type Params = { params: Promise<{ id: string }> };

/** One count sheet with its lines, current balances and variances (inventory module). */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("inventory");
  if (error) return error;
  const { id } = await params;
  const s = await getCountSession(id);
  if (!s) return NextResponse.json({ error: "Count not found." }, { status: 404 });
  return NextResponse.json(s);
}

/**
 * Fill in an OPEN sheet: `{ lines?: [{ id, countedQty: number | null, notes? }], add?: [{ category,
 * entityId }], remove?: [lineId], title?, notes? }`. inventory › receive or › adjust: entering a
 * counted quantity books nothing (posting does, under inventory › adjust).
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireAnySub("inventory", ["receive", "adjust"]);
  if (error) return error;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) ?? {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  try {
    await updateCountSession(user, id, body);
    return NextResponse.json(await getCountSession(id));
  } catch (err) {
    return handleDomainError(err);
  }
}
