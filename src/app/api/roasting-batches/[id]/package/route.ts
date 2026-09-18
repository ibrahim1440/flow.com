import { NextResponse } from "next/server";
import { requireEdit } from "@/lib/auth-server";

/**
 * PUT /api/roasting-batches/[id]/package — RETIRED.
 *
 * This was the legacy kilogram packaging path: fixed 3 kg / 1 kg / 250 g / 150 g bag
 * counters on the batch, producing one kg-tracked FinishedGoodsLot per roast. Unified
 * Packaging V2 replaced it, and it is refused here rather than left reachable.
 *
 * Disabled rather than adapted, which is the opposite of the decision taken for
 * ../pack-sku. That route's request — "pack N whole units of this SKU" — maps onto V2
 * without loss, so it delegates. This one does not map at all:
 *
 *   - Its inputs are bag SIZES, not SKUs. Nothing guarantees a 3 kg or 150 g SKU exists
 *     for the coffee being packed, so there is no product to pack into.
 *   - Its output is a kg-tracked lot (isUnitTracked=false, availableQty in kilograms).
 *     V2 produces unit-tracked packages. Translating one into the other would silently
 *     change what the stock IS, and 8.45 kg against a 1 KG SKU is not a whole number of
 *     bags — the conversion the schema already documents as impossible to do honestly.
 *
 * So there is no faithful adapter to write, and writing an unfaithful one would put
 * fabricated unit stock on the shelf. Refusal is the correct behaviour.
 *
 * EXISTING DATA IS UNAFFECTED. The kg-tracked lots this route created in the past remain
 * readable, allocatable and shippable through the legacy bean-based order lines exactly as
 * before — Production still holds 19.710 kg across four such lots. Only the creation of
 * NEW legacy stock is refused; nothing is migrated, rewritten or hidden.
 *
 * Kept as a route, rather than deleted outright, so a caller still speaking the old shape
 * receives an explicit, actionable refusal instead of a bare 404 that reads like a
 * deployment fault. 410 Gone is the honest status: the endpoint existed and is now
 * permanently withdrawn.
 *
 * Authorization is still checked first. A refusal that skipped it would tell an
 * unauthenticated caller which endpoints exist and how the system has changed.
 */
export async function PUT() {
  const { error } = await requireEdit("packaging");
  if (error) return error;

  return NextResponse.json(
    {
      error:
        "Kilogram packaging has been retired. Use the single packaging operation " +
        "(POST /api/roasting-batches/{id}/pack), which records each package, its actual " +
        "weight, and any declared loss.",
      replacedBy: "POST /api/roasting-batches/{id}/pack",
    },
    { status: 410 }
  );
}
