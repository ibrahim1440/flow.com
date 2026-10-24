import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { voidPayment } from "@/lib/accounting/ops/ap";

type Params = { params: Promise<{ id: string }> };

/** Void a payment (bounced, recorded in error): its entry is reversed, the invoices owe again. accounting › ap (step-up). */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "ap");
  if (error) return error;
  try {
    const b = await jsonBody(request);
    return NextResponse.json(await voidPayment((await params).id, String(b.reason ?? ""), auditFromRequest(request, user.id, String(b.reason ?? ""))));
  } catch (err) {
    return acctError(err);
  }
}
