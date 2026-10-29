import { NextResponse } from "@/lib/api-response";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { reviseBudget } from "@/lib/accounting/budgets";

type Params = { params: Promise<{ id: string }> };

/** «تعديل (نسخة جديدة)» (accounting › budgets): a DRAFT revision of an APPROVED budget, with a reason. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("budgets");
  if (error) return error;
  const { id } = await params;
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await reviseBudget(id, body.reason, auditFromRequest(request, user.id, typeof body.reason === "string" ? body.reason : null)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
