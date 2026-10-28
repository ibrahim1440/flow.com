import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { cancelCreditNote } from "@/lib/accounting/ops/supplier-claims";

type Params = { params: Promise<{ id: string }> };

/** Cancel a supplier credit note — { reason }: its entry reversed, the claim open again. accounting › ap (step-up). */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "ap");
  if (error) return error;
  try {
    const b = await jsonBody(request);
    const reason = String(b.reason ?? "");
    return NextResponse.json(await cancelCreditNote((await params).id, reason, auditFromRequest(request, user.id, reason)));
  } catch (err) {
    return acctError(err);
  }
}
