import { NextResponse } from "@/lib/api-response";
import { requireModule, requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { listSalesAccountRules, setSalesAccountRule } from "@/lib/accounting/sales-account-rules";
import { auditFromRequest } from "@/lib/accounting/audit";

/** «قواعد حسابات المبيعات»: the revenue / cost-of-sales account by sales activity, then category or SKU. */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json(await listSalesAccountRules());
  } catch (err) {
    return acctError(err);
  }
}

/**
 * `{ activity, categoryId? | productSkuId?, revenueAccountId?, cogsAccountId? }` — set or clear (null) the accounts of
 * one scope. Same duty and step-up as the role mapping: it decides where money posts.
 */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("accounting", "settings_manage");
  if (error) return error;
  const refused = await requirePrivilegedAction(user, "accounting.roles_map", { stepUp: true });
  if (refused) return refused;
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await setSalesAccountRule({ activity: body.activity, categoryId: body.categoryId, productSkuId: body.productSkuId }, { revenueAccountId: body.revenueAccountId, cogsAccountId: body.cogsAccountId }, auditFromRequest(request, user.id, typeof body.reason === "string" ? body.reason : null)));
  } catch (err) {
    return acctError(err);
  }
}
