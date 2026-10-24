import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { postInvoice } from "@/lib/accounting/ops/ap";

type Params = { params: Promise<{ id: string }> };

/** Approve = post (never one's own — SoD). accounting › ap (step-up). */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "ap");
  if (error) return error;
  try {
    return NextResponse.json(await postInvoice((await params).id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
