import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError } from "@/lib/accounting/http";
import { accountingDashboard } from "@/lib/accounting/dashboard";

/** «نظرة عامة»: the accounting KPIs, the six-month trend and the close issues of the open months. */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json(await accountingDashboard());
  } catch (err) {
    return acctError(err);
  }
}
