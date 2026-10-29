import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireApRead } from "@/lib/accounting/ops/http";
import { listPayments, recordPayment, type PaymentInput } from "@/lib/accounting/ops/ap";
import { branchFilterOf } from "@/lib/accounting/locations";

export async function GET(request: Request) {
  const { error } = await requireApRead();
  if (error) return error;
  try {
    return NextResponse.json(await listPayments({ supplierId: qp(request, "supplierId"), branches: branchFilterOf(request) }));
  } catch (err) {
    return acctError(err);
  }
}

/** Record a supplier payment applied in full to posted invoices: Dr AP / Cr BANK. accounting › ap (step-up). */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "ap");
  if (error) return error;
  try {
    return NextResponse.json(await recordPayment((await jsonBody(request)) as unknown as PaymentInput, auditFromRequest(request, user.id, "supplier payment")), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
