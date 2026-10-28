import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { requireStation } from "@/lib/services/station/http";
import { greenDrawCheck, lookupScan } from "@/lib/services/scan-lookup";

/**
 * GET /api/station/roasting/lot?code=…&productId=…&kg=… — the roasting station scans the sack it draws from
 * (20261114090000_green_lot_labels). The lot is refused when inactive, short of the green weight, or (for a roaster
 * without production › roast_to_stock) not the coffee of the product; otherwise the station sends its id with the roast
 * (POST /api/station/roasting/record → the one roast POST, which re-checks stock atomically). Same guard as every
 * roasting-station API (device → station session → assignment → production › start_batch).
 */
export async function GET(request: Request) {
  const { user, error } = await requireStation();
  if (error) return error;
  const sp = new URL(request.url).searchParams;
  try {
    const r = await lookupScan(sp.get("code") ?? "", "GREEN_LOT");
    if (!r.ok && r.code === "AMBIGUOUS") return NextResponse.json({ error: `أكثر من لوت بهذا الرقم التسلسلي: ${r.scanned}. امسح الكود الجديد GL-… من ملصق اللوت.`, errorEn: `More than one lot has this serial number: ${r.scanned}. Scan the new GL-… code on the lot label.`, code: "SCAN_AMBIGUOUS", scanned: r.scanned }, { status: 409 });
    if (!r.ok) {
      return NextResponse.json({
        error: r.code === "EMPTY" ? "امسح ملصق كيس البن الأخضر." : `هذا ليس ملصق لوت بن أخضر معروف: ${r.scanned}`,
        errorEn: r.code === "EMPTY" ? "Scan the green-coffee sack label." : `Not a known green-coffee lot label: ${r.scanned}`,
        code: r.code === "EMPTY" ? "SCAN_EMPTY" : "SCAN_NOT_FOUND", scanned: r.scanned,
      }, { status: r.code === "EMPTY" ? 400 : 404 });
    }
    if (r.hit.kind !== "GREEN_LOT") return NextResponse.json({ error: "ليس لوت بن أخضر.", errorEn: "Not a green-coffee lot.", code: "SCAN_NOT_FOUND" }, { status: 404 });
    const draw = await greenDrawCheck(r.hit, sp.get("productId"), Number(sp.get("kg") ?? 0), hasSubPrivilege(user.permissions, "production", "roast_to_stock"), sp.get("roasterId"));
    if (!draw.ok) return NextResponse.json({ error: draw.ar, errorEn: draw.en, code: draw.code, lot: r.hit }, { status: 409 });
    return NextResponse.json({ lot: r.hit, draw });
  } catch (err) {
    return handleDomainError(err);
  }
}
