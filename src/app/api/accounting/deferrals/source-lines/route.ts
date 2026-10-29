import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { linesWithCapacity } from "@/lib/accounting/purchase-line-capacity";

/**
 * The EXPENSE lines of posted purchase invoices a prepaid schedule may be made from (?supplierId): the ONE capacity per
 * line shared with «الأصول الثابتة» (council F1), with what already uses it («مستخدم في: أصل ثابت / تأجيل»). The
 * accounting module (read-only).
 */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json({ rows: await linesWithCapacity({ supplierId: qp(request, "supplierId") }) });
  } catch (err) {
    return acctError(err);
  }
}
