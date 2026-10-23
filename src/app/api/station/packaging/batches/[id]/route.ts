import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { asStation, requirePackagingStation } from "@/lib/services/station/http";
import { packagingTaskFacts } from "@/lib/services/station/packaging";
import { GET as packGet } from "@/app/api/roasting-batches/[id]/pack/route";

/**
 * GET /api/station/packaging/batches/[id] — PA2: the pack route's own answer (the coffee left, this
 * coffee's sizes with counts from open demand — GET /api/roasting-batches/[id]/pack, unchanged) and
 * the order line the packages will be reserved to.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await requirePackagingStation("packaging");
  if (g.error) return g.error;
  const { id } = await ctx.params;
  try {
    const res = await asStation(g, () => packGet(new Request(request.url, { method: "GET" }), { params: Promise.resolve({ id }) }));
    if (!res.ok) return res;
    const pack = await res.json();
    const task = await packagingTaskFacts(id);
    if (!task) return NextResponse.json({ error: "الدفعة غير موجودة.", errorEn: "Batch not found." }, { status: 404 });
    return NextResponse.json({ ...pack, ...task }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
