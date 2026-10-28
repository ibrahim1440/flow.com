import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { acctError, qp } from "@/lib/accounting/http";
import { requireApRead } from "@/lib/accounting/ops/http";
import { listClaims, shortfallSettings } from "@/lib/accounting/ops/supplier-claims";
import { purchaseCan } from "@/lib/purchases/gates";

/**
 * «مطالبات الموردين» (20261119090000_supplier_shortfall) — the supplier claims: open by default (?status=ALL|SETTLED|VOID),
 * per supplier (?supplierId=), oldest first with their age and the > 60 days flag. The AP read gate. `can` says which
 * settlement the viewer may record (the routes re-check): a credit note — `ap` (accounting › ap); replacement goods —
 * `receive` (inventory › receive); an abandonment — `adjust` (inventory › adjust, with the stock-change step-up).
 */
export async function GET(request: Request) {
  const { user, error } = await requireApRead();
  if (error) return error;
  try {
    const r = await listClaims({ supplierId: qp(request, "supplierId"), status: qp(request, "status") });
    const s = await shortfallSettings(prisma);
    return NextResponse.json({
      ...r, settings: { tolerancePercent: s.tolerancePercent, abandonReverseVat: s.abandonReverseVat },
      can: purchaseCan(user.permissions),
    });
  } catch (err) {
    return acctError(err);
  }
}
