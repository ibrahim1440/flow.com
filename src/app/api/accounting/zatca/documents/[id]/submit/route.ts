import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { submitDocument } from "@/lib/zatca/pipeline";
import { zatcaError } from "@/lib/zatca/refusals";

export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/accounting/zatca/documents/:id/submit — send a PENDING or ERROR e-invoice again, now (the same signed
 * bytes; a REJECTED / cleared / reported one is final: 409 FINAL). accounting › zatca_resubmit.
 */
export async function POST(_request: Request, { params }: Ctx) {
  const { id } = await params;
  const { user, error } = await requireSub("accounting", "zatca_resubmit");
  if (error) return error;
  try {
    return NextResponse.json({ result: await submitDocument(id, { actorId: user.id, force: true }) });
  } catch (err) {
    return zatcaError(err);
  }
}
