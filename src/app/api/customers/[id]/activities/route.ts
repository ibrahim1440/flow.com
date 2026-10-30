import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasModuleAccess } from "@/lib/auth-shared";
import { parseActivity, logCustomerActivity } from "@/lib/services/sales/activity-log";
import { customerInScope } from "@/lib/services/sales/customer-access";

type Params = { params: Promise<{ id: string }> };

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
  // A scoped sales rep writes only on the customers in their own book (services/sales/scope.ts).
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const b = (body ?? {}) as Record<string, unknown>;

  try {
    // Same rules as POST /api/sales/activities — lib/services/sales/activity-log.ts.
    const a = parseActivity(b, { maxSubject: 500 });
    // `next` (optional): the follow-up the result calls for, written in the same transaction as the
    // result — «تسجيل اتصال» on a customer due to reorder records the call and its next step at once.
    const nb = b.next && typeof b.next === "object" ? (b.next as Record<string, unknown>) : null;
    const next = nb ? parseActivity({ type: typeof nb.channel === "string" ? nb.channel : "CALL", subject: typeof nb.subject === "string" && nb.subject.trim() ? nb.subject : a.subject, dueAt: nb.dueAt }, { maxSubject: 500 }) : null;
    if (next && !next.dueAt) throw { _appCode: 400, message: "The next step needs a date." };
    const result = await prisma.$transaction(async (tx) => {
      const writer = { id: user.id, permissions: user.permissions };
      const logged = await logCustomerActivity(tx, writer, id, a);
      const planned = next ? await logCustomerActivity(tx, writer, id, next) : null;
      return { ...logged, nextActivityId: planned?.activity.id ?? null };
    }, TX_OPTS);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
