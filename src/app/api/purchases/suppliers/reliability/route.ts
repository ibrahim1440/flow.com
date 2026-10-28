import { NextResponse } from "@/lib/api-response";
import { acctError, qp } from "@/lib/accounting/http";
import { requireApRead } from "@/lib/accounting/ops/http";
import { supplierReliability } from "@/lib/accounting/ops/supplier-claims";

/**
 * «موثوقية المورد» (20261119090000_supplier_shortfall) — per supplier over a period (?from=&to=, invoice dates;
 * default: the year to date): fill rate, shortage value, claimed and recovered. The AP read gate (values).
 */
export async function GET(request: Request) {
  const { error } = await requireApRead();
  if (error) return error;
  try {
    return NextResponse.json(await supplierReliability({ from: qp(request, "from"), to: qp(request, "to"), supplierId: qp(request, "supplierId") }));
  } catch (err) {
    return acctError(err);
  }
}
