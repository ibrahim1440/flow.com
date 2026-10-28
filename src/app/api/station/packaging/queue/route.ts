import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requirePackagingStation } from "@/lib/services/station/http";
import { packagingQueue } from "@/lib/services/station/packaging";
import { prisma } from "@/lib/db";
import { productionLocation } from "@/lib/services/stock-locations";

/**
 * GET /api/station/packaging/queue — PA1 «دفعات جاهزة للتعبئة» (released batches only; the ones
 * waiting for QC as «غير متاحة») and P5 (material shortages, rejected batches). Polled with a
 * version (H5): an unchanged queue answers 304.
 */
export async function GET(request: Request) {
  const g = await requirePackagingStation("packaging");
  if (g.error) return g.error;
  try {
    const q = await packagingQueue();
    // The station's «الموقع» badge: its own location (packSiteId takes it first); without one, each roast is packed where
    // it was roasted — the badge names the production site as that default.
    const own = g.station?.id ? await prisma.station.findUnique({ where: { id: g.station.id }, select: { location: { select: { id: true, nameAr: true, nameEn: true, isActive: true, type: true } } } }) : null;
    const loc = own?.location && own.location.isActive && own.location.type !== "TRANSIT" ? own.location : null;
    const prod = loc ? null : await productionLocation(prisma).catch(() => null);
    const site = loc ? { id: loc.id, nameAr: loc.nameAr, nameEn: loc.nameEn, source: "station" as const } : prod ? { id: prod.id, nameAr: prod.nameAr, nameEn: prod.nameEn, source: "roast" as const } : null;
    const body = { ...q, site };
    const etag = `"${q.version}-${site?.id ?? "none"}"`;
    if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    return NextResponse.json(body, { headers: { ETag: etag, "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
