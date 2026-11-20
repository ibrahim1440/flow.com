import { NextResponse } from "@/lib/api-response";
import { requireModule, requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { classifyDraftLine, recordCostAccountDecision, unmappedOrderCostLines } from "@/lib/accounting/sales-account-rules";
import { unmappedDraftLines } from "@/lib/services/invoicing/postings";
import { requireInvoiceDuty } from "@/lib/services/invoicing/guard";
import { auditFromRequest } from "@/lib/accounting/audit";

/** «بنود غير مربوطة»: the revenue lines of draft documents that no rule of their SKU or category covers — for review before issue. */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json({ documents: await unmappedDraftLines(), orderLines: await unmappedOrderCostLines() });
  } catch (err) {
    return acctError(err);
  }
}

/**
 * `{ lineId, salesCategoryId }` — classify a draft's line (who may write an invoice draft), or
 * `{ lineId, generalAccountReason }` — the recorded decision that the line posts to the general account: the
 * account-mapping duty with its step-up, the same as changing a rule.
 */
export async function PUT(request: Request) {
  try {
    const body = await jsonBody(request);
    if (body.generalAccountReason !== undefined || body.costAccountReason !== undefined) {
      const { user, error } = await requireSub("accounting", "settings_manage");
      if (error) return error;
      const refused = await requirePrivilegedAction(user, "accounting.roles_map", { stepUp: true });
      if (refused) return refused;
      // `{ orderItemId, costAccountReason }`: the same decision for the cost of sales of one order line.
      if (body.costAccountReason !== undefined) return NextResponse.json(await recordCostAccountDecision(body.orderItemId, body.costAccountReason, auditFromRequest(request, user.id, null)));
      return NextResponse.json(await classifyDraftLine(body.lineId, { generalAccountReason: body.generalAccountReason }, auditFromRequest(request, user.id, null)));
    }
    const { user, error } = await requireInvoiceDuty("invoices_create");
    if (error) return error;
    return NextResponse.json(await classifyDraftLine(body.lineId, { salesCategoryId: body.salesCategoryId }, auditFromRequest(request, user.id, null)));
  } catch (err) {
    return acctError(err);
  }
}
