import { NextResponse } from "@/lib/api-response";
import { requireAnyModule } from "@/lib/auth-server";
import { acctError } from "@/lib/accounting/http";
import { locationOptions, UNASSIGNED } from "@/lib/accounting/locations";

/**
 * «الموقع» (BATCH22 WP-B): the pick list of the location filter and select — the active branches (FinBranch) and the
 * stock sites mapped to each. Names only (no figures). Readable by every module whose lists carry the filter: the
 * accountant workspace, sales (invoices, receipts), purchases and inventory. `unassigned` is the «غير محدد» token.
 */
export async function GET() {
  const { error } = await requireAnyModule("accounting", "sales", "purchases", "commissions", "inventory", "orders");
  if (error) return error;
  try {
    return NextResponse.json({ locations: await locationOptions(), unassigned: UNASSIGNED });
  } catch (err) {
    return acctError(err);
  }
}
