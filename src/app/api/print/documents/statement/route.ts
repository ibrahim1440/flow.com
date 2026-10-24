import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { documentPrintGate } from "@/lib/print/server/auth";
import { acctError } from "@/lib/accounting/http";
import { refuse } from "@/lib/accounting/refusals";
import { balanceFromRequest, cashFlowFromRequest, incomeFromRequest, vatFromRequest } from "@/lib/accounting/report-routes";
import { sellerSnapshot } from "@/lib/services/invoicing/settings";

export const dynamic = "force-dynamic";

/**
 * GET /api/print/documents/statement?report=income|balance|cashflow|vat&<the report's own query> — the data of a
 * printed financial statement / VAT return working paper (A5) on the shared A4 document. Who: the accounting module.
 * The document gate (PRINT_DOCUMENTS_ENABLED) applies as for every A4 document: 401 → 403 → 409 → 400.
 */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  const gated = documentPrintGate();
  if (gated) return gated;
  try {
    const report = new URL(request.url).searchParams.get("report");
    const data = report === "income" ? await incomeFromRequest(request)
      : report === "balance" ? await balanceFromRequest(request)
      : report === "cashflow" ? await cashFlowFromRequest(request)
      : report === "vat" ? await vatFromRequest(request) : null;
    if (!data) throw refuse("BAD_INPUT", "report is income, balance, cashflow or vat.");
    return NextResponse.json({ report, data, seller: await sellerSnapshot(prisma), printedAt: new Date().toISOString() });
  } catch (err) {
    return acctError(err);
  }
}
