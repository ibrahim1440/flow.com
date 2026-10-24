import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { returnInvoice } from "@/lib/accounting/ops/ap";

type Params = { params: Promise<{ id: string }> };

/** Return a submitted invoice to draft, with a reason. accounting › ap (step-up). */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "ap");
  if (error) return error;
  try {
    const b = await jsonBody(request);
    return NextResponse.json(await returnInvoice((await params).id, String(b.reason ?? ""), user.id));
  } catch (err) {
    return acctError(err);
  }
}
