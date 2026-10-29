import { NextResponse } from "@/lib/api-response";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { canCreditNote, canIssueInvoices } from "@/lib/services/invoicing/access";
import { scopedCustomerIds } from "@/lib/services/invoicing/http";
import { requestQueue } from "@/lib/services/invoicing/requests";
import { invError } from "@/lib/services/invoicing/refusals";

/**
 * GET /api/sales/invoices/requests — «طلبات الفواتير», the accountant's queue: every requested draft, oldest first, with
 * its age in Riyadh business days (Friday / Saturday off), the legal limit «آخر موعد نظامي» (the 15th of the month
 * after the supply) and its colour. ?count=1 answers the sidebar badge only. Who: sales › invoices_issue or
 * invoices_credit_note (read only: no step-up), within the viewer's customer scope.
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canIssueInvoices(user.permissions) && !canCreditNote(user.permissions)) return forbidden();
  try {
    const scope = await scopedCustomerIds(user);
    const items = await requestQueue({ customerIds: scope });
    const notes = canCreditNote(user.permissions), invoices = canIssueInvoices(user.permissions);
    const mine = items.filter((r) => (r.kind === "INVOICE" ? invoices : notes));
    if (new URL(request.url).searchParams.get("count") === "1") return NextResponse.json({ count: mine.length, red: mine.filter((r) => r.tone === "red").length });
    return NextResponse.json({ items: mine, count: mine.length });
  } catch (err) {
    return invError(err);
  }
}
