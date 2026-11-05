import { NextResponse } from "@/lib/api-response";
import { forbidden, privilegedGate, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { canWriteAccountingCustomers, updateAccountingCustomer } from "@/lib/services/customers/accounting-customers";

type Params = { params: Promise<{ id: string }> };

/** PATCH — correct a customer's invoice particulars from «واجهة المحاسب» (accounting › ar at edit). Audited. */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  if (!canWriteAccountingCustomers(user.permissions)) return forbidden();
  const refused = await privilegedGate(user, "accounting", "ar");
  if (refused) return refused;
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(await updateAccountingCustomer(id, body, { id: user.id, name: user.name }));
  } catch (err) {
    return handleDomainError(err);
  }
}
