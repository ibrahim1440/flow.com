import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireFaWrite } from "@/lib/accounting/fixed-assets/http";
import { cancelAddition } from "@/lib/accounting/fixed-assets/assets";

type Params = { params: Promise<{ id: string }> };

/** Cancel an addition (its entry reversed; the schedule restored) — { reason ≥ 3 }. Step-up. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireFaWrite({ duty: "journal_reverse" });
  if (error) return error;
  try {
    const reason = String((await jsonBody(request)).reason ?? "");
    return NextResponse.json(await cancelAddition((await params).id, reason, auditFromRequest(request, user.id, reason)));
  } catch (err) {
    return acctError(err);
  }
}
