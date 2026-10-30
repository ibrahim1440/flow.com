import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { lockLeadForAutomation, qualifies, qualifyLeadFromActivity } from "@/lib/services/sales/qualification";
import { parseQualificationInput } from "@/lib/services/sales/needs";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/leads/[id]/qualify — `{ activityId, qualification: { businessType, needSummary, expectedMonthlyKg?, nextStep } }`.
 *
 * The second half of the inline qualification (migration 20261204100000_pipeline_qualification).
 * Logging a qualifying activity on a lead whose minimum is unknown answers
 * `qualification: { converted: false, missing: [...] }`; the form then asks for the missing
 * fields and sends them HERE, naming the activity it already logged. The answers are saved on the
 * lead and the qualification is run again for that same activity — so completing the form does
 * not log a second call, and the deal that results is linked to the interaction that caused it.
 *
 * Same gate and scope as logging the activity (sales › lead_write; your own lead unless you see
 * all sales; 404 otherwise). Idempotent: once converted, a repeat answers the existing deal
 * (`alreadyInPipeline`), exactly like a replayed activity.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const activityId = typeof b.activityId === "string" && b.activityId ? b.activityId : null;
  if (!activityId) return NextResponse.json({ error: "activityId is required: the qualifying activity this completes.", errorAr: "حدّد النشاط الذي يُستكمل تأهيله." }, { status: 400 });
  const parsed = parseQualificationInput(b.qualification);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, errorAr: parsed.errorAr, code: "INVALID_QUALIFICATION" }, { status: 400 });

  try {
    const lead = await prisma.lead.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }) },
      select: { id: true },
    });
    if (!lead) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const qualification = await prisma.$transaction(async (tx) => {
      // The lead lock first, as when the activity was logged (see `lockLeadForAutomation`).
      if (!(await lockLeadForAutomation(tx, id))) throw { _appCode: 404, message: NOT_FOUND_MESSAGE };
      const activity = await tx.activity.findFirst({ where: { id: activityId, leadId: id }, select: { id: true, outcome: true } });
      if (!activity) throw { _appCode: 404, message: "Activity not found on this lead.", errorAr: "النشاط غير موجود على هذا العميل المحتمل." };
      if (!qualifies(activity.outcome)) {
        throw {
          _appCode: 409,
          code: "NOT_A_QUALIFYING_ACTIVITY",
          message: "That activity's outcome does not qualify a lead (interest, an appointment, or one held).",
          errorAr: "نتيجة هذا النشاط لا تؤهّل العميل المحتمل (اهتمام مؤكد أو موعد أو لقاء تمّ).",
        };
      }
      return qualifyLeadFromActivity(tx, {
        leadId: id, activityId: activity.id, outcome: activity.outcome, actorId: user.id, qualification: parsed.data,
      });
    }, TX_OPTS);

    return NextResponse.json({ qualification });
  } catch (err) {
    return handleDomainError(err);
  }
}
