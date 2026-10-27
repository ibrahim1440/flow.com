import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { greenLotPage } from "@/lib/services/green-lot-page";

type Params = { params: Promise<{ ref: string }> };

/**
 * GET /api/inventory/green-lots/:ref — one green-coffee lot's page (the QR code on its label opens it): the lot, its
 * sacks, its receipts (supplier, supplier invoice no., kg — no price), the roasts drawn from it, its counts and its
 * label print history. `ref` is the lot id or its label code «GL-00042». Inventory module, read-only.
 */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("inventory");
  if (error) return error;
  const { ref } = await params;
  try {
    const page = await greenLotPage(decodeURIComponent(ref));
    if (!page) return NextResponse.json({ error: "لا يوجد لوت بهذا الرمز.", errorEn: "Lot not found.", code: "LOT_NOT_FOUND" }, { status: 404 });
    return NextResponse.json(page);
  } catch (err) {
    return handlePrismaError(err);
  }
}
