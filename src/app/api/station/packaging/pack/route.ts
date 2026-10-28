import { NextResponse } from "@/lib/api-response";
import { asStation, requirePackagingStation, requiredKey } from "@/lib/services/station/http";
import { POST as packPost } from "@/app/api/roasting-batches/[id]/pack/route";

/**
 * POST /api/station/packaging/pack {batchId, productSkuId, packages} + Idempotency-Key — PA2
 * «تأكيد تعبئة N عبوات». Recorded by the ERP's ONE packaging operation (POST
 * /api/roasting-batches/[id]/pack: released batches only, the material draw, the reservation to the
 * owning order line, the replay by key — «إعادة الضغط تعرض النتيجة نفسها»). Packages are filled to
 * the size's nominal weight; a partial package or a loss line stays an ERP action.
 */
export async function POST(request: Request) {
  const g = await requirePackagingStation("packaging");
  if (g.error) return g.error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const batchId = typeof body.batchId === "string" && body.batchId ? body.batchId : null;
  const skuId = typeof body.productSkuId === "string" && body.productSkuId ? body.productSkuId : null;
  const packages = Number(body.packages);
  if (!batchId || !skuId || !Number.isInteger(packages) || packages <= 0) return NextResponse.json({ error: "اختر الصنف وأدخل عدد العبوات.", errorEn: "Choose the size and enter the number of packages." }, { status: 400 });
  const url = new URL(`/api/roasting-batches/${encodeURIComponent(batchId)}/pack`, request.url);
  const forwarded = new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": k.key }, body: JSON.stringify({ lines: [{ productSkuId: skuId, packages }], ...(g.station ? { stationId: g.station.id } : {}) }) });
  return asStation(g, () => packPost(forwarded, { params: Promise.resolve({ id: batchId }) }));
}
