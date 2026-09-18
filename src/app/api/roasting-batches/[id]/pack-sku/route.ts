import { NextResponse } from "next/server";
import { POST as packV2 } from "../pack/route";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/roasting-batches/[id]/pack-sku — COMPATIBILITY ADAPTER.
 *
 * This endpoint no longer implements packaging. It translates its old request shape into
 * the one Unified Packaging V2 speaks and hands the work to the same route the screen
 * uses, so there is exactly ONE implementation of inventory mutation for packaging and no
 * way to reach an older one.
 *
 * Why an adapter rather than a deletion: "pack N whole units of this SKU" maps onto the V2
 * model without loss — it is N packages filled to the SKU's nominal weight, which V2
 * classifies as STANDARD and therefore as sellable units. The translation is faithful, so
 * any caller still speaking the old shape keeps working and keeps every V2 invariant:
 * gram reconciliation, partial classification, material accounting, idempotency,
 * authorization, the batch row lock, and PackagingSource lineage.
 *
 * Why it mattered: the implementation this replaced drew coffee from the BOM's
 * per-unit figure rather than from the weight actually put in a package. A bill of
 * materials claiming 0.4 kg per unit of a 500 g SKU would have produced fully sellable
 * 500 g units while drawing only 400 g — fabricating 100 g of finished goods per unit,
 * with no actualContentGrams to contradict it and no lineage row to trace it. It also
 * wrote lots with none of the V2 columns, so those lots were invisible to the
 * reconciliation that the rest of this feature depends on.
 *
 * The nominal weight is resolved by the V2 route from the SKU itself. This adapter never
 * chooses a fill weight, because choosing one here would be a second opinion about what a
 * complete package is.
 */
export async function POST(request: Request, ctx: Params) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (typeof b.productSkuId !== "string" || !b.productSkuId) {
    return NextResponse.json({ error: "productSkuId is required." }, { status: 400 });
  }
  const units = Number(b.units);
  if (!Number.isInteger(units) || units <= 0) {
    return NextResponse.json(
      { error: "units must be a whole number greater than zero." },
      { status: 400 }
    );
  }

  // Rebuilt rather than forwarded: the body has already been consumed, and a Request's
  // stream cannot be read twice. Headers are carried across verbatim so the caller's
  // Idempotency-Key still names the operation — a retry through this adapter must be
  // recognised as the same operation, not packed a second time.
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({
      lines: [{ kind: "pack", productSkuId: b.productSkuId, packages: units }],
    }),
  });

  const res = await packV2(forwarded, ctx);

  // The old shape's callers read unitsPacked and skuCode. Answered from what V2 actually
  // committed, never from what was asked for, so a caller cannot be told it packed
  // something the server did not do.
  if (res.status !== 201) return res;
  const v2 = (await res.json()) as {
    standardUnitsCreated: number;
    gramsConsumed: number;
    remainingGrams: number;
    reservedUnits?: number;
    reservedToOrderItemId?: string | null;
    lots: { id: string; skuCode: string; classification: string; units: number }[];
    materialsConsumed: { label: string; quantity: number }[];
  };
  const lot = v2.lots.find((l) => l.classification === "STANDARD") ?? v2.lots[0];

  return NextResponse.json(
    {
      lotId: lot?.id ?? null,
      skuCode: lot?.skuCode ?? null,
      unitsPacked: v2.standardUnitsCreated,
      unitsAvailableOnLot: lot?.units ?? 0,
      reservedUnits: v2.reservedUnits ?? 0,
      reservedToOrderItemId: v2.reservedToOrderItemId ?? null,
      freeUnits: Math.max(0, v2.standardUnitsCreated - (v2.reservedUnits ?? 0)),
      roastedCoffeeConsumedKg: +(v2.gramsConsumed / 1000).toFixed(3),
      roastedAvailableKgRemaining: +(v2.remainingGrams / 1000).toFixed(3),
      materialsConsumed: v2.materialsConsumed,
      // Says plainly which implementation answered, so a caller — or an auditor reading a
      // stored PackagingOperation response — can tell this went through V2.
      packagedVia: "unified-packaging-v2",
    },
    { status: 201, headers: res.headers }
  );
}
