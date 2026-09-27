import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/sales/samples/[id] — move a sample along, or record what the customer said.
 *
 * The transitions are stated as a table for the same reason the quote lifecycle is: what
 * matters is what is absent. A cancelled sample does not come back, and a sample cannot
 * collect feedback before it has been sent — a score against something still on the bench
 * is somebody's guess, and it would then be read as the customer's opinion.
 */
const ALLOWED: Record<string, string[]> = {
  PREPARING: ["SENT", "CANCELLED"],
  SENT: ["FEEDBACK_RECEIVED", "CANCELLED"],
  FEEDBACK_RECEIVED: [],
  CANCELLED: [],
};

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
      select: { id: true, status: true, opportunityId: true, description: true },
    });
    if (!sample) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const data: Record<string, unknown> = {};
    const now = new Date();

    if (typeof b.status === "string" && b.status !== sample.status) {
      const allowed = ALLOWED[sample.status] ?? [];
      if (!allowed.includes(b.status)) {
        throw {
          _appCode: 409,
          message:
            `A ${sample.status.toLowerCase().replace(/_/g, " ")} sample cannot become ` +
            `${b.status.toLowerCase().replace(/_/g, " ")}.`,
        };
      }
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
    if (typeof b.description === "string" && sample.status === "PREPARING") {
      const v = b.description.trim();
      if (v.length >= 2) data.description = v;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    const updated = await prisma.sampleShipment.update({
      where: { id },
      data,
      select: {
        id: true, status: true, sentAt: true, feedbackAt: true, feedbackScore: true,
        feedbackNotes: true, description: true,
      },
    });

    // Same reasoning as on creation: a sample sent with nothing scheduled after it is a
    // sample nobody chases.
    if (data.status === "SENT" && b.createFollowUp !== false) {
      await prisma.activity.create({
        data: {
          type: "SAMPLE_FOLLOW_UP",
          subject: `Follow up on sample: ${sample.description ?? "product sample"}`,
          opportunityId: sample.opportunityId,
          dueAt: new Date(Date.now() + 7 * 86400_000),
          ownerId: user.id,
        },
      });
    }

    return NextResponse.json({ sample: updated });
  } catch (err) {
    return handleDomainError(err);
  }
}
