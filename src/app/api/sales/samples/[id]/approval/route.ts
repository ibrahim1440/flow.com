import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { approvesSamples } from "@/lib/services/sales/sample-rules";
import { decideSampleApproval } from "@/lib/services/sales/sample-request";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/samples/[id]/approval — the sales manager's decision on a customer's SECOND sample of a product
 * («للعميل من كل محصول عيّنة واحدة», docs/sales/SAMPLES_INVENTORY.md §2).
 *
 *   { "decision": "APPROVE", "note"?: "…" }  — recorded on the request (who, when, note); it joins the dispatch queue.
 *   { "decision": "DECLINE", "note": "…" }   — the reason is required; the request is CANCELLED with the decline
 *                                               recorded, so it never counts and is never issued. "REJECT" is the
 *                                               same decision (the «مساحة عملي» approvals inbox sends it).
 *
 * Gate: a sales manager (`sales › lead_assign`, which the administrator holds by role template) — approvesSamples(), checked before the body is
 * read. Not scoped by deal owner: the manager decides for every rep. Idempotent: the same decision again answers the
 * recorded one (200, `replayed: true`); the other decision after one was taken is 409 SAMPLE_APPROVAL_DECIDED.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  if (!approvesSamples(user.permissions)) {
    return NextResponse.json(
      { error: "اعتماد العيّنة الثانية لمدير المبيعات أو المدير فقط.", errorEn: "Only a sales manager or the administrator approves a second sample.", code: "SAMPLE_APPROVER_ONLY" },
      { status: 403 },
    );
  }
  const { id } = await params;

  let b: Record<string, unknown> = {};
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { b = {}; }
  const decision = b.decision === "APPROVE" ? "APPROVE" : b.decision === "DECLINE" || b.decision === "REJECT" ? "DECLINE" : null;
  if (!decision) {
    return NextResponse.json(
      { error: "القرار اعتماد (APPROVE) أو رفض (DECLINE).", errorEn: "decision is APPROVE or DECLINE.", code: "SAMPLE_DECISION" },
      { status: 400 },
    );
  }
  const note = typeof b.note === "string" ? b.note : null;

  try {
    const r = await decideSampleApproval(id, decision, note, { id: user.id, permissions: user.permissions });
    return NextResponse.json({ sample: r.sample, replayed: r.replayed }, { status: 200 });
  } catch (err) {
    return handleDomainError(err);
  }
}
