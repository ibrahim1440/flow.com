import { NextResponse } from "@/lib/api-response";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { cancelSchedule } from "@/lib/accounting/recurring/schedules";

type Params = { params: Promise<{ id: string }> };

/** «إلغاء المعاملة»: no further runs; the transaction and its history stay — accounting › recurring. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("recurring");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await cancelSchedule(id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
