import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { dayText, parseBusinessDay, riyadhDay } from "@/lib/accounting/dates";
import { refuse } from "@/lib/accounting/refusals";
import { deliveryInvoiceGaps } from "@/lib/accounting/delivery-invoice-gaps";

/** «مفوتر غير مسلّم / مسلّم غير مفوتر» as of a day (`to`, default today). Read-only. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    let asOf: Date;
    try { asOf = parseBusinessDay(qp(request, "to") ?? dayText(riyadhDay())); } catch { throw refuse("BAD_INPUT", "to is YYYY-MM-DD."); }
    return NextResponse.json(await deliveryInvoiceGaps(asOf));
  } catch (err) {
    return acctError(err);
  }
}
