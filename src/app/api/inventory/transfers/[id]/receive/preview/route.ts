import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { identityOf } from "@/lib/hr/identity";
import { isSimpleMode } from "@/lib/simple-mode";
import { prisma } from "@/lib/db";
import { previewShortfall } from "@/lib/services/transfer-shortfall-gate";

type Params = { params: Promise<{ id: string }> };

/**
 * POST { lines: [{ lineNo, qtyReceived }] } — the receive dialog's preview of the owner's shortfall threshold
 * (feat/shortfall-threshold, council F5): per line a VERDICT (over or not, which limits), the transfer-level limits
 * (Σ of the transfer, the receiver's 30 days), whether recording it needs inventory › adjust + step-up. Never the cost
 * holder's qty or value; the judged value only for a cost reader (accounting, or inventory › valuation). Read-only:
 * writes nothing (the identity check audits nothing here either). inventory › transfer_receive.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("inventory", "transfer_receive");
  if (error) return error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const p = await previewShortfall(user, (await params).id, body ?? {}, {
      // As assertVerifiedActor decides (SIMPLE MODE needs no verified identity), without auditing a refusal: a preview.
      verified: async (u) => isSimpleMode() || (await identityOf(prisma, u.id)).verified,
    });
    return p ? NextResponse.json(p) : NextResponse.json({ error: "التحويل ليس في الطريق.", errorEn: "The transfer is not in transit.", code: "TRANSFER_NOT_IN_TRANSIT" }, { status: 409 });
  } catch (err) {
    return handleDomainError(err);
  }
}
