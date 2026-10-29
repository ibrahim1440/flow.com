import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { depositAccounts } from "@/lib/services/sales/receipts";

/**
 * GET /api/accounting/cash-accounts — the postable cash / bank accounts (and the card-clearing account) a voucher may be
 * deposited to («سند قبض», BATCH22 WP-D) or paid from («سندات الموردين» «الحساب»), with each method's default role
 * account. The accounting module reads. Empty before the chart of accounts exists (production today).
 */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json(await depositAccounts(prisma));
  } catch (err) {
    return handleDomainError(err);
  }
}
