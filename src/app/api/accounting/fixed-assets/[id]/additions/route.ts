import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireFaWrite } from "@/lib/accounting/fixed-assets/http";
import { addAddition } from "@/lib/accounting/fixed-assets/assets";

type Params = { params: Promise<{ id: string }> };

/** «إضافة رأسمالية» — { additionDate, amount, kind MANUAL | PURCHASE_INVOICE, counterAccountId | supplierInvoiceLineId, description, newUsefulLifeMonths?, newResidualValue? }. Step-up. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireFaWrite({ duty: "journal_post" });
  if (error) return error;
  try {
    return NextResponse.json(await addAddition((await params).id, await jsonBody(request), auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
