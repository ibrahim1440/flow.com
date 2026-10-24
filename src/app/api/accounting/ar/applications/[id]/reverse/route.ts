import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { jsonBody } from "@/lib/accounting/http";
import { unapply } from "@/lib/services/invoicing/ar";
import { invError } from "@/lib/services/invoicing/refusals";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/accounting/ar/applications/:id/reverse { reason } — undo an application (its posting is reversed / offset). accounting › ar. */
export async function POST(request: Request, { params }: Ctx) {
  const { user, error } = await requireSub("accounting", "ar");
  if (error) return error;
  try {
    const { id } = await params;
    const b = await jsonBody(request);
    return NextResponse.json(await unapply(id, String(b.reason ?? ""), auditFromRequest(request, user.id, String(b.reason ?? ""))));
  } catch (err) {
    return invError(err);
  }
}
