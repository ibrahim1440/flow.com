import { NextResponse } from "@/lib/api-response";
import { requireAnyModule } from "@/lib/auth-server";
import { enabledSalesActivities } from "@/lib/accounting/sales-account-rules";

/**
 * The sales activities a NEW document may be recorded under: the ones activated in the deployment's settings
 * (SALES_ACTIVITIES_ENABLED), none by default. The order form offers these and only these; with none, it shows no
 * activity field at all. The names only — no account, no rule.
 */
export async function GET() {
  const { error } = await requireAnyModule("orders", "sales", "accounting");
  if (error) return error;
  return NextResponse.json({ activities: enabledSalesActivities() });
}
