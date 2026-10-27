import { NextResponse } from "@/lib/api-response";
import { requireAnyModule } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { handlePrismaError } from "@/lib/api-error";
import { greenDrawCheck, lookupScan } from "@/lib/services/scan-lookup";

/**
 * GET /api/scan?code=…[&only=GREEN_LOT|MATERIAL][&productId=…&kg=…] — what a scanned label names (a green lot
 * «GL-00042», a material «MT-00007», a SKU barcode, or a lot serial / material code), for the one scan input of
 * counts, receiving, the roast sheet and the inventory search (20261114090000_green_lot_labels). Read-only; any of
 * inventory, production, purchases or labels. With productId / kg (the roast sheet) a green lot is also checked for
 * the draw: active, enough stock, the product's coffee.
 */
export async function GET(request: Request) {
  const { user, error } = await requireAnyModule("inventory", "production", "purchases", "labels");
  if (error) return error;
  const sp = new URL(request.url).searchParams;
  const only = sp.get("only");
  try {
    const r = await lookupScan(sp.get("code") ?? "", only === "GREEN_LOT" || only === "MATERIAL" ? only : undefined);
    if (!r.ok) {
      if (r.code === "AMBIGUOUS") return NextResponse.json({ error: `أكثر من لوت بهذا الرقم التسلسلي: ${r.scanned}. امسح الكود الجديد GL-… من ملصق اللوت.`, errorEn: `More than one lot has this serial number: ${r.scanned}. Scan the new GL-… code on the lot label.`, code: "SCAN_AMBIGUOUS", scanned: r.scanned }, { status: 409 });
      return NextResponse.json({
        error: r.code === "EMPTY" ? "امسح ملصقًا أو اكتب رمزه." : `لا يوجد صنف أو لوت بهذا الرمز: ${r.scanned}`,
        errorEn: r.code === "EMPTY" ? "Scan a label or type its code." : `No item or lot has this code: ${r.scanned}`,
        code: r.code === "EMPTY" ? "SCAN_EMPTY" : "SCAN_NOT_FOUND", scanned: r.scanned,
      }, { status: r.code === "EMPTY" ? 400 : 404 });
    }
    const productId = sp.get("productId");
    if (r.hit.kind === "GREEN_LOT" && (productId || sp.get("kg"))) {
      const draw = await greenDrawCheck(r.hit, productId, Number(sp.get("kg") ?? 0), hasSubPrivilege(user.permissions, "production", "roast_to_stock"));
      return NextResponse.json({ ...r, draw });
    }
    return NextResponse.json(r);
  } catch (err) {
    return handlePrismaError(err);
  }
}
