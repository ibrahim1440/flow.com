import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { csvResponse } from "@/lib/accounting/ops/http";
import { apAging } from "@/lib/accounting/ops/ap";

/** «أعمار الدائنين» (Figma ACC-53): open items as of a day by bucket and supplier, against the AP control account. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const r = await apAging(qp(request, "asOf"), qp(request, "supplierId"));
    if (qp(request, "format") === "csv") {
      return csvResponse(`ap-aging-${r.asOf}`, ["supplier", "not_due", "d1_30", "d31_60", "d61_90", "d90_plus", "total"], r.suppliers.map((s) => [s.name, s.buckets.current, s.buckets.d1_30, s.buckets.d31_60, s.buckets.d61_90, s.buckets.d90_plus, s.total]));
    }
    return NextResponse.json(r);
  } catch (err) {
    return acctError(err);
  }
}
