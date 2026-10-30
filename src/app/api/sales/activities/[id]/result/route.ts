import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { ACTIVITY_OUTCOMES } from "@/lib/services/sales/qualification";
import { parseActivity, logLeadOrDealActivity, logCustomerActivity, mayLogActivity } from "@/lib/services/sales/activity-log";
import { suggestNextStep } from "@/lib/services/sales/follow-through";
import { NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";

type Params = { params: Promise<{ id: string }> };

const CHANNELS = ["CALL", "VISIT", "MEETING"];

/**
 * POST /api/sales/activities/[id]/result — «تسجيل النتيجة» on a planned follow-up, from wherever it is
 * shown (the workspace's Today, the activities list). Body: { outcome, note?, next?: { dueAt, channel?, subject? } }.
 *
 * The same write as a workspace follow-up's result, under the CRM's own rules: the result is logged
 * as a completed activity on the same lead / deal / customer (activity-log.ts — scope, qualification,
 * NOT_INTERESTED, NEW → CONTACTED, the lead's next follow-up), the planned one is completed, and the
 * next step, when given, becomes the next planned activity. One transaction, behind a row lock on the
 * planned activity: a second click or a concurrent request is answered as a replay and writes nothing.
 *
 * Own records only, like PATCH: a manager who may see a rep's follow-ups still does not record what
 * the rep did. Anybody else's id is a 404.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;
  const { id } = await params;

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const b = (body ?? {}) as Record<string, unknown>;
  const outcome = typeof b.outcome === "string" && (ACTIVITY_OUTCOMES as string[]).includes(b.outcome) ? b.outcome : null;
  if (!outcome) return NextResponse.json({ error: "اختر نتيجة المتابعة.", errorEn: "An outcome is required.", code: "OUTCOME_REQUIRED" }, { status: 400 });
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 2000) || null : null;
  const nb = b.next && typeof b.next === "object" ? (b.next as Record<string, unknown>) : null;
  let next: { dueAt: Date; channel: string; subject: string | null } | null = null;
  if (nb) {
    const d = typeof nb.dueAt === "string" ? new Date(nb.dueAt) : null;
    if (!d || Number.isNaN(d.getTime())) return NextResponse.json({ error: "موعد الخطوة التالية غير صالح.", errorEn: "The next step's date is not valid." }, { status: 400 });
    next = {
      dueAt: d,
      channel: typeof nb.channel === "string" && CHANNELS.includes(nb.channel) ? nb.channel : "CALL",
      subject: typeof nb.subject === "string" ? nb.subject.trim().slice(0, 200) || null : null,
    };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // The lock first: two clicks resolve against each other, not against a read each took earlier.
      await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${id} FOR UPDATE`;
      const planned = await tx.activity.findUnique({
        where: { id },
        select: { id: true, ownerId: true, type: true, subject: true, completedAt: true, leadId: true, opportunityId: true, customerId: true },
      });
      if (!planned || planned.ownerId !== user.id) throw { _appCode: 404, message: NOT_FOUND_MESSAGE };
      if (planned.completedAt) return { replayed: true, activityId: null, nextActivityId: null, qualification: null };
      if (!mayLogActivity(user.permissions, !planned.leadId && !planned.opportunityId)) throw { _appCode: 403, message: "Recording a result needs the right to log activities." };

      // The result keeps the planned channel (a visit's result is a visit); a reminder (TASK) is a call.
      const type = planned.type === "TASK" || planned.type === "NOTE" ? "CALL" : planned.type;
      const parsed = parseActivity({
        type, subject: planned.subject, body: note, outcome, completed: true,
        leadId: planned.leadId, opportunityId: planned.opportunityId,
      });
      const writer = { id: user.id, permissions: user.permissions };
      const logged = planned.leadId || planned.opportunityId
        ? await logLeadOrDealActivity(tx, writer, parsed)
        : await logCustomerActivity(tx, writer, planned.customerId!, parsed);
      // The planned one is the promise this result keeps (a sample reminder included).
      await tx.activity.updateMany({ where: { id, completedAt: null }, data: { completedAt: new Date() } });

      let nextActivityId: string | null = null;
      if (next) {
        const np = parseActivity({
          type: next.channel, subject: next.subject ?? planned.subject, dueAt: next.dueAt,
          leadId: planned.leadId, opportunityId: planned.opportunityId,
        });
        const n = planned.leadId || planned.opportunityId
          ? await logLeadOrDealActivity(tx, writer, np)
          : await logCustomerActivity(tx, writer, planned.customerId!, np);
        nextActivityId = n.activity.id;
      }
      return {
        replayed: false,
        activityId: logged.activity.id,
        nextActivityId,
        qualification: "qualification" in logged ? logged.qualification : null,
      };
    }, TX_OPTS);
    return NextResponse.json({ ...result, suggestion: suggestNextStep(outcome) });
  } catch (err) {
    return handleDomainError(err);
  }
}
