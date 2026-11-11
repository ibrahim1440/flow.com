// D22 «إرسال عيّنة» from the tax invoice page (services/sales/sample-send.ts).
//   GET  ?customerId=…  — the products the customer already had as a sample this year, and (sales › samples_vat_alert) the
//                         list value of the year's samples against the alert threshold;
//   POST                — the samples, the deal link and the zero invoice's request, in ONE transaction. Idempotent by
//                         body.requestKey: a second tap replays the first send (200, replayed).
import { NextResponse } from "@/lib/api-response";
import { requireAuth, forbidden } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { AccountingError } from "@/lib/accounting/errors";
import { invError } from "@/lib/services/invoicing/refusals";
import { createSampleSend, maySendSample, sampleSendFacts } from "@/lib/services/sales/sample-send";

export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!maySendSample(user.permissions)) return forbidden();
  const customerId = new URL(request.url).searchParams.get("customerId") ?? "";
  if (!customerId) return NextResponse.json({ error: "اختر العميل.", errorEn: "Choose the customer.", code: "CUSTOMER_REQUIRED" }, { status: 400 });
  try {
    return NextResponse.json(await sampleSendFacts(user, customerId));
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!maySendSample(user.permissions)) return forbidden();
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body.", code: "BAD_INPUT" }, { status: 400 }); }
  try {
    const r = await createSampleSend(
      { customerId: body.customerId, opportunityId: body.opportunityId, lines: body.lines, requestKey: body.requestKey, note: body.note, invoice: body.invoice },
      user,
      auditFromRequest(request, user.id),
    );
    return NextResponse.json(r, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    if (err instanceof AccountingError) return invError(err);
    return handleDomainError(err);
  }
}
