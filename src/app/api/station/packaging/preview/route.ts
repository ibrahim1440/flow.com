import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { prisma } from "@/lib/db";
import { asStation, requirePackagingStation } from "@/lib/services/station/http";
import { firstShortage, maxPackagesFor } from "@/lib/services/station/packaging";
import { riyadhDay } from "@/lib/order-stage";
import { POST as packPost } from "@/app/api/roasting-batches/[id]/pack/route";

/**
 * POST /api/station/packaging/preview {batchId, productSkuId, packages} — PA2's material check: the
 * pack route's own preview (nothing written), plus how many packages the material shelf allows
 * (`maxPackages`, «تعبئة 12 الآن»). A shortage is told once per material per day to the people
 * who restock and plan (production.packaging_material_short).
 */
export async function POST(request: Request) {
  const g = await requirePackagingStation("packaging");
  if (g.error) return g.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const batchId = typeof body.batchId === "string" && body.batchId ? body.batchId : null;
  const skuId = typeof body.productSkuId === "string" && body.productSkuId ? body.productSkuId : null;
  const packages = Number(body.packages);
  if (!batchId || !skuId || !Number.isInteger(packages) || packages <= 0) return NextResponse.json({ error: "اختر الصنف وأدخل عدد العبوات.", errorEn: "Choose the size and enter the number of packages." }, { status: 400 });
  try {
    const url = new URL(`/api/roasting-batches/${encodeURIComponent(batchId)}/pack`, request.url);
    const res = await asStation(g, () => packPost(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview: true, lines: [{ productSkuId: skuId, packages }] }) }), { params: Promise.resolve({ id: batchId }) }));
    if (!res.ok) return res;
    const preview = await res.json();
    const materials = (preview.materials ?? []) as { materialItemId: string; label: string; required: number; available: number; missing: number }[];
    const short = firstShortage(materials);
    const maxPackages = Math.min(packages, maxPackagesFor(packages, materials), preview.lines?.[0]?.actualGramsEach > 0 ? Math.floor((preview.availableGrams ?? 0) / preview.lines[0].actualGramsEach) : packages);
    if (short) {
      const batch = await prisma.roastingBatch.findUnique({ where: { id: batchId }, select: { batchNumber: true } });
      const { notify } = await import("@/lib/notifications/notify");
      await notify(prisma, {
        event: "production.packaging_material_short", dedupeKey: `${short.materialItemId}:${riyadhDay(new Date()).start.toISOString().slice(0, 10)}`, actorId: g.user.id,
        entity: { type: "MaterialItem", id: short.materialItemId },
        facts: { material: short.material, required: short.required, available: short.available, batchNumber: batch?.batchNumber ?? "" },
      }).catch((e: unknown) => console.error("[station] shortage notice not written:", e instanceof Error ? e.message : e));
    }
    return NextResponse.json({ ...preview, maxPackages, shortage: short }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
