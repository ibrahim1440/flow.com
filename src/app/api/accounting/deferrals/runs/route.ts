import { NextResponse } from "@/lib/api-response";
import { requireModule, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { listRuns, runDeferralRecognition } from "@/lib/accounting/deferrals";
import { refuse } from "@/lib/accounting/refusals";

/** The recognition runs, newest month first. */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json({ items: await listRuns() });
  } catch (err) {
    return acctError(err);
  }
}

/** «تشغيل الاعتراف الشهري» (accounting › journal_post, the central gate: verified individual + step-up): { month: "YYYY-MM" } — one balanced entry; idempotent per schedule and month. */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "journal_post");
  if (error) return error;
  try {
    const body = await jsonBody(request);
    if (typeof body.month !== "string") throw refuse("BAD_INPUT", "month is YYYY-MM.", "الشهر بصيغة YYYY-MM.");
    const a = auditFromRequest(request, user.id);
    const r = await runDeferralRecognition({ month: body.month, actorId: user.id, audit: { ip: a.ip, userAgent: a.userAgent } });
    return NextResponse.json(r, { status: r.status === "RECORDED" ? 201 : 200 });
  } catch (err) {
    return acctError(err);
  }
}
