import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { supplierStatement } from "@/lib/accounting/ops/ap";
import { opsRefuse } from "@/lib/accounting/ops/refusals";

/** «كشف حساب المورد»: the AP control lines of one supplier from the books, with a running balance. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const id = qp(request, "supplierId");
    if (!id) throw opsRefuse("SUPPLIER_REQUIRED");
    return NextResponse.json(await supplierStatement(id, qp(request, "from"), qp(request, "to")));
  } catch (err) {
    return acctError(err);
  }
}
