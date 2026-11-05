import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { sampleTransitionRefusal } from "@/lib/services/sales/sample-rules";
import { advanceToPurpose } from "@/lib/services/sales/lifecycle";
import { ensureSampleFollowUp, closeSampleFollowUp } from "@/lib/services/sales/follow-through";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/sales/samples/[id] — the rep's side of a sample: record what the customer said, cancel a request that
 * has not been issued, or (record-only samples) mark it sent.
 *
 * The transitions are a table (sample-rules.ts, `sampleTransitionRefusal`) for the same reason the quote lifecycle
 * is: what matters is what is absent. A cancelled sample does not come back; a sample cannot collect feedback before
 * it has been sent — a score against something still on the bench is somebody's guess, and it would then be read as
 * the customer's opinion; and a STOCK sample is never marked sent here nor cancelled after issue — sending it is
 * dispatch issuing it (POST /api/deliveries/samples/[id]), and once issued the coffee has left the building.
 *
 * The write is conditional on the status this request read, so a rep cancelling while dispatch issues the same
 * sample cannot overwrite the issue: one of the two finds the status changed and is refused (the database's
 * "SampleShipment_issued" check is the backstop).
 */
export async function PATCH(request: Request, { params }: Params) {
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

  try {
    const sample = await prisma.sampleShipment.findFirst({
      where: {
        id,
        ...(seesAllSales(user.permissions) ? {} : { opportunity: { ownerId: user.id } }),
      },
      select: { id: true, status: true, opportunityId: true, description: true, fromStock: true },
    });
    if (!sample) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const data: Record<string, unknown> = {};
    const now = new Date();

    if (typeof b.status === "string" && b.status !== sample.status) {
      const refusal = sampleTransitionRefusal(sample.fromStock, sample.status, b.status, "rep");
      if (refusal) throw refusal;
      data.status = b.status;
      if (b.status === "SENT") data.sentAt = now;
      if (b.status === "FEEDBACK_RECEIVED") data.feedbackAt = now;
    }

    if (b.feedbackScore !== undefined && b.feedbackScore !== null) {
      const n = Number(b.feedbackScore);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        throw { _appCode: 400, message: "A feedback score is a whole number from 1 to 5." };
      }
      const targetStatus = (data.status as string) ?? sample.status;
      if (targetStatus !== "FEEDBACK_RECEIVED") {
        throw {
          _appCode: 409,
          message: "Record the feedback and the score together: set the status to feedback received.",
        };
      }
      data.feedbackScore = n;
    }
    if (typeof b.feedbackNotes === "string") {
      data.feedbackNotes = b.feedbackNotes.trim() || null;
    }
    if (typeof b.description === "string" && (sample.status === "PREPARING" || sample.status === "REQUESTED")) {
      const v = b.description.trim();
      if (v.length >= 2) data.description = v;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const won = await tx.sampleShipment.updateMany({ where: { id, status: sample.status }, data });
      if (won.count !== 1) {
        throw {
          _appCode: 409, code: "SAMPLE_CHANGED",
          message: "تغيّرت حالة العيّنة منذ فتحتها (ربما صُرفت). حدّث الصفحة.",
          errorEn: "The sample changed since you opened it (it may have been issued). Reload the page.",
        };
      }

      // Same reasoning as on creation: a sample sent with nothing scheduled after it is a
      // sample nobody chases. Same transaction as the status, so the two cannot drift apart — and ONE keyed
      // reminder per sample (pipeline v2 D1), however many paths reach SENT.
      if (data.status === "SENT") {
        if (b.createFollowUp !== false) {
          await ensureSampleFollowUp(tx, { sampleId: id, opportunityId: sample.opportunityId, description: sample.description, ownerId: user.id, sentAt: now });
        }
        // Pipeline v2 T2b: a sample sent is the deal at Sample Evaluation (idempotent with T2; covers pre-v2 samples).
        await advanceToPurpose(tx, sample.opportunityId, "SAMPLE_EVALUATION", user.id, "a sample was sent");
      }
      // The customer's view is recorded, or the sample is cancelled: its reminder has done its job and closes itself.
      if (data.status === "FEEDBACK_RECEIVED" || data.status === "CANCELLED") {
        await closeSampleFollowUp(tx, { sampleId: id, opportunityId: sample.opportunityId }, now);
      }
      // Readiness review P1-6: the deal owner hears the sample went out / what the customer said.
      if (data.status === "SENT" || data.status === "FEEDBACK_RECEIVED") {
        const n = await import("@/lib/services/sales/sample-stage-notify");
        if (data.status === "SENT") await n.notifySampleSent(tx, id, user.id); else await n.notifySampleFeedback(tx, id, user.id);
      }

      return tx.sampleShipment.findUniqueOrThrow({
        where: { id },
        select: {
          id: true, status: true, sentAt: true, feedbackAt: true, feedbackScore: true,
          feedbackNotes: true, description: true, fromStock: true, issuedAt: true,
        },
      });
    }, TX_OPTS);

    return NextResponse.json({ sample: updated });
  } catch (err) {
    return handleDomainError(err);
  }
}
