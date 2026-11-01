import { NextResponse } from "@/lib/api-response";
import { forbidden, privilegedGate, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { canReadAccountingCustomers, canWriteAccountingCustomers, createAccountingCustomer, listAccountingCustomers } from "@/lib/services/customers/accounting-customers";

/**
 * «العملاء» in «واجهة المحاسب»: GET every customer with its receivables (?q= name / VAT / phone); POST a new customer
 * (names, VAT, CR, city, address, phone, e-mail). The accounting module with accounting › ar (writes: edit access).
 * Never deals, activities, notes or the rep — those stay Sales'.
 */
export async function GET(request: Request) {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  if (!canReadAccountingCustomers(user.permissions)) return forbidden();
  try {
    const rows = await listAccountingCustomers(new URL(request.url).searchParams.get("q"));
    return NextResponse.json({ rows, can: { write: canWriteAccountingCustomers(user.permissions) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  if (!canWriteAccountingCustomers(user.permissions)) return forbidden();
  const refused = await privilegedGate(user, "accounting", "ar");
  if (refused) return refused;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(await createAccountingCustomer(body, user.id), { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
