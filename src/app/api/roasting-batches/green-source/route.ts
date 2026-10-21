import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { greenSourceFacts } from "@/lib/services/green-source";
import { pickGreenLot } from "@/lib/green-source";

/**
 * GET /api/roasting-batches/green-source?productId=… | ?orderItemId=…[&kg=…]
 *
 * What the roast sheet shows as its info line (production simplification item 1): the product's
 * default green lot, the active lots of the same bean and origin (for the O1 FIFO fallback the
 * sheet computes with the same pickGreenLot the server applies), the product's expected loss for
 * the live loss warning, and — when `kg` is given — the lot a roast of that weight would take.
 * Read-only; the same permission as recording the roast (production › start_batch).
 */
export async function GET(request: Request) {
  const { error } = await requireSub("production", "start_batch");
  if (error) return error;
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  const orderItemId = url.searchParams.get("orderItemId");
  if (!productId === !orderItemId) {
    return NextResponse.json({ error: "Give exactly one of productId or orderItemId." }, { status: 400 });
  }
  const kgRaw = url.searchParams.get("kg");
  const kg = kgRaw === null ? 0 : Number(kgRaw);
  if (!Number.isFinite(kg) || kg < 0) return NextResponse.json({ error: "kg must be a non-negative number." }, { status: 400 });
  try {
    const facts = await greenSourceFacts(prisma, productId ? { productId } : { orderItemId });
    if (!facts) return NextResponse.json({ error: "Product or order line not found." }, { status: 404 });
    return NextResponse.json({ ...facts, pick: pickGreenLot(facts.defaultLot, facts.candidates, kg) });
  } catch (err) {
    return handleDomainError(err);
  }
}
