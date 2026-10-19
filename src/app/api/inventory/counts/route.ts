import { NextResponse } from "next/server";
import { requireAnySub, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { createCountSession, getCountSession, listCountSessions } from "@/lib/services/inventory-counts";

/**
 * Count sessions («الجرد والتسويات»). GET lists the latest sessions (inventory module). POST starts
 * one with `{ items: [{ category: RAW_MATERIAL | PACKAGING_MATERIAL, entityId }], title?, notes? }`:
 * the catalogue-maintenance duty — inventory › receive or › adjust (requireAnySub, as for bean
 * records). Starting or filling in a count sheet changes no stock; POSTING it does, and that is
 * POST /api/inventory/counts/:id/post under inventory › adjust (stockChangeGate).
 */
export async function GET() {
  const { error } = await requireModule("inventory");
  if (error) return error;
  return NextResponse.json(await listCountSessions());
}

export async function POST(request: Request) {
  const { user, error } = await requireAnySub("inventory", ["receive", "adjust"]);
  if (error) return error;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) ?? {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  try {
    const id = await createCountSession(user, body);
    return NextResponse.json(await getCountSession(id), { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
