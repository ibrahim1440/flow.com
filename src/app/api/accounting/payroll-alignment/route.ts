import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError } from "@/lib/accounting/http";
import { payrollAlignment } from "@/lib/accounting/ops/payroll-alignment";

/** Payroll in the ledger (option a): each HR posting key against the account of its posting role. Read-only. */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json(await payrollAlignment());
  } catch (err) {
    return acctError(err);
  }
}
