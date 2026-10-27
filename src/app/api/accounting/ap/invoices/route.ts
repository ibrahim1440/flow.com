import { NextResponse } from "@/lib/api-response";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { acctError, qp } from "@/lib/accounting/http";
import { opsRefuse } from "@/lib/accounting/ops/refusals";
import { requireApRead, requireDraftWriter } from "@/lib/accounting/ops/http";
import { listInvoices } from "@/lib/accounting/ops/ap";
import { isSimpleMode } from "@/lib/simple-mode";
import { sodPolicy } from "@/lib/accounting/sod";

/** «فواتير الموردين» (Figma ACC-50): the list, the counts per status, what the viewer may do. */
export async function GET(request: Request) {
  const { user, error } = await requireApRead();
  if (error) return error;
  try {
    const r = await listInvoices({ status: qp(request, "status"), supplierId: qp(request, "supplierId") });
    return NextResponse.json({ ...r, viewer: { id: user.id }, simpleMode: isSimpleMode(), sodSelfAllowed: (await sodPolicy()).allowSelfApproval, can: { draft: hasSubPrivilege(user.permissions, "purchases", "invoices") || hasSubPrivilege(user.permissions, "accounting", "ap"), ap: hasSubPrivilege(user.permissions, "accounting", "ap") } });
  } catch (err) {
    return acctError(err);
  }
}

/**
 * Gone (council review SA1): supplier invoices are entered as purchase invoices — POST /api/purchases/invoices, one
 * document for stock (received in the same save), expenses, import VAT and landed costs. This legacy route's STOCK
 * line capitalised value with no goods received; no screen uses it any more. The gate still answers first, so an
 * unauthorised caller learns nothing about the route.
 */
export async function POST() {
  const { error } = await requireDraftWriter();
  if (error) return error;
  return acctError(opsRefuse("LEGACY_AP_ROUTE_GONE"));
}
