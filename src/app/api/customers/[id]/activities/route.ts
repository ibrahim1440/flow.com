import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasModuleAccess } from "@/lib/auth-shared";
import { ACTIVITY_OUTCOMES } from "@/lib/services/sales/qualification";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";

type Params = { params: Promise<{ id: string }> };

const TYPES = ["CALL", "VISIT", "MEETING", "NOTE", "TASK", "SAMPLE_FOLLOW_UP"];

/**
 * POST /api/customers/[id]/activities — log a call, visit, note or task on a CUSTOMER
 * (the account page's composer and «تسجيل نشاط»).
 *
 * The same record as POST /api/sales/activities, with the same rules: it records that contact
 * happened and sends nothing; the caller owns it (never taken from the request); a task needs
 * a due date; the outcome is one of ACTIVITY_OUTCOMES. The same privilege — sales › lead_write —
 * plus the customers module, because the customer is the record it is written on.
 *
 * What is different: it may attach to the customer alone. An existing customer has no lead to
 * attach to, and a conversation with a customer that is not about one deal (a complaint, a
 * delivery, a visit) has nowhere else to go. `Activity.customerId` already exists for this and
 * is what the lead conversion writes. No qualification runs: that automation acts on LEADS only.
 *
 * `opportunityId` is optional and must be one of THIS customer's deals that the caller may see
 * (owner scope) — otherwise 404, so the endpoint cannot be used to confirm another rep's deal.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;
  if (!hasModuleAccess(user.permissions, "customers")) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  const { id } = await params;

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const b = (body ?? {}) as Record<string, unknown>;

  const type = typeof b.type === "string" && TYPES.includes(b.type) ? b.type : null;
  if (!type) return NextResponse.json({ error: "type must be one of: " + TYPES.join(", ") }, { status: 400 });
  const outcome = typeof b.outcome === "string" && (ACTIVITY_OUTCOMES as string[]).includes(b.outcome) ? b.outcome : null;
  if (b.outcome !== undefined && b.outcome !== null && !outcome) {
    return NextResponse.json({ error: "outcome must be one of: " + ACTIVITY_OUTCOMES.join(", ") }, { status: 400 });
  }
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  if (subject.length < 2) return NextResponse.json({ error: "An activity needs a subject." }, { status: 400 });
  if (subject.length > 500) return NextResponse.json({ error: "The subject is longer than 500 characters." }, { status: 400 });
  let dueAt: Date | null = null;
  if (typeof b.dueAt === "string" && b.dueAt) {
    dueAt = new Date(b.dueAt);
    if (Number.isNaN(dueAt.getTime())) return NextResponse.json({ error: "dueAt is not a date." }, { status: 400 });
  }
  if (type === "TASK" && !dueAt) return NextResponse.json({ error: "A task needs a due date." }, { status: 400 });
  const opportunityId = typeof b.opportunityId === "string" && b.opportunityId ? b.opportunityId : null;

  try {
    const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!customer) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    if (opportunityId) {
      const deal = await prisma.opportunity.findFirst({
        where: { id: opportunityId, customerId: id, ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }) },
        select: { id: true },
      });
      if (!deal) return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    }
    const activity = await prisma.activity.create({
      data: {
        type: type as never,
        subject,
        outcome: outcome as never,
        body: typeof b.body === "string" ? b.body.trim() || null : null,
        customerId: id,
        opportunityId,
        dueAt,
        completedAt: b.completed === true ? new Date() : null,
        ownerId: user.id,
      },
      select: { id: true, type: true, subject: true, outcome: true, dueAt: true, completedAt: true, createdAt: true, customerId: true, opportunityId: true },
    });
    return NextResponse.json({ activity }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
