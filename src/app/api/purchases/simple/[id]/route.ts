import { NextResponse } from "@/lib/api-response";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { purchaseSaveGate } from "@/lib/purchases/gates";
import { saveSimpleInvoice } from "@/lib/accounting/ops/simple-purchase";
import { readSimpleRequest } from "@/lib/accounting/ops/simple-http";

type Params = { params: Promise<{ id: string }> };

/** «فواتير بسيطة»: save a simple DRAFT again (multipart with a new receipt, or JSON keeping the one attached). Gates as POST. */
export async function PATCH(request: Request, { params }: Params) {
  let req: Awaited<ReturnType<typeof readSimpleRequest>>;
  try { req = await readSimpleRequest(request); } catch (err) { return acctError(err); }
  const action = req.input?.action === "post" ? "post" : "draft";
  const { user, error } = await purchaseSaveGate(action);
  if (error) return error;
  try {
    return NextResponse.json(await saveSimpleInvoice(req.input, req.file, (await params).id, auditFromRequest(request, user.id, "simple invoice"), { mayPost: action === "post" }));
  } catch (err) {
    return acctError(err);
  }
}
