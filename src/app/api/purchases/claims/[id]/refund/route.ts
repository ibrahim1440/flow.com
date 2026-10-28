import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { refundClaim } from "@/lib/accounting/ops/supplier-claims";

type Params = { params: Promise<{ id: string }> };

/**
 * «استرداد من المورد» against an open claim — { amount (≤ open net + VAT), method BANK_TRANSFER | CASH, reference?,
 * receivedDate? }: Dr bank / cash, Cr supplier claims (net share), Cr VAT input (VAT share). accounting › ap (step-up).
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "ap");
  if (error) return error;
  try {
    const b = await jsonBody(request);
    return NextResponse.json(await refundClaim((await params).id, { amount: b.amount as string | number, method: String(b.method ?? ""), reference: (b.reference as string | null) ?? null, receivedDate: (b.receivedDate as string | null) ?? null }, auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
