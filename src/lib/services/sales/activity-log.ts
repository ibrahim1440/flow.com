// Logging a CRM activity — the ONE implementation behind POST /api/sales/activities (lead / deal),
// POST /api/customers/[id]/activities (a customer) and «تسجيل النتيجة» of a workspace follow-up.
//
// Extracted unchanged from the two routes (feat/my-workspace) so the workspace records a follow-up's
// result with exactly the CRM's rules, inside the transaction that completes the task:
//   * the caller holds sales › lead_write (and the customers module when writing on a customer);
//   * the lead / deal must be one the caller may see (owner scope) — else 404, never a confirmation;
//   * the caller owns the record (never taken from the request);
//   * a TASK needs a due date; the outcome is one of ACTIVITY_OUTCOMES;
//   * on a LEAD, a qualifying outcome runs the qualification and NOT_INTERESTED marks the lead, in the
//     same transaction (the lead is locked first — see `lockLeadForAutomation`).
import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import {
  ACTIVITY_OUTCOMES, qualifies, qualifyLeadFromActivity, markLeadNotInterested, lockLeadForAutomation,
} from "./qualification";
import { seesAllSales, NOT_FOUND_MESSAGE } from "./scope";

type Tx = PrismaNS.TransactionClient;

export const ACTIVITY_TYPES = ["CALL", "VISIT", "MEETING", "NOTE", "TASK", "SAMPLE_FOLLOW_UP"];

export type ActivityInput = {
  type?: unknown; subject?: unknown; body?: unknown; outcome?: unknown; dueAt?: unknown; completed?: unknown;
  leadId?: unknown; opportunityId?: unknown;
};

const bad = (message: string, status = 400) => ({ _appCode: status, message });

/** Validate the fields (the routes' 400s, same wording). */
export function parseActivity(b: ActivityInput, opts: { maxSubject?: number; leadOrDeal?: boolean } = {}) {
  const type = typeof b.type === "string" && ACTIVITY_TYPES.includes(b.type) ? b.type : null;
  if (!type) throw bad("type must be one of: " + ACTIVITY_TYPES.join(", "));
  const outcome = typeof b.outcome === "string" && (ACTIVITY_OUTCOMES as string[]).includes(b.outcome) ? (b.outcome as string) : null;
  if (b.outcome !== undefined && b.outcome !== null && !outcome) throw bad("outcome must be one of: " + ACTIVITY_OUTCOMES.join(", "));
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  if (subject.length < 2) throw bad("An activity needs a subject.");
  if (opts.maxSubject && subject.length > opts.maxSubject) throw bad(`The subject is longer than ${opts.maxSubject} characters.`);
  if (opts.leadOrDeal && !(typeof b.leadId === "string" && b.leadId) && !(typeof b.opportunityId === "string" && b.opportunityId)) {
    throw bad("An activity attaches to a lead or a deal. Say which.");
  }
  let dueAt: Date | null = null;
  if (typeof b.dueAt === "string" && b.dueAt) {
    dueAt = new Date(b.dueAt);
    if (Number.isNaN(dueAt.getTime())) throw bad("dueAt is not a date.");
  } else if (b.dueAt instanceof Date) dueAt = b.dueAt;
  if (type === "TASK" && !dueAt) throw bad("A task needs a due date.");
  return {
    type, outcome, subject, dueAt,
    body: typeof b.body === "string" ? b.body.trim() || null : null,
    completed: b.completed === true,
    leadId: typeof b.leadId === "string" && b.leadId ? b.leadId : null,
    opportunityId: typeof b.opportunityId === "string" && b.opportunityId ? b.opportunityId : null,
  };
}

export type ParsedActivity = ReturnType<typeof parseActivity>;
export type ActivityActor = { id: string; permissions: Permissions };

/** Whether this person may log activities at all (and on a customer, when `onCustomer`). */
export function mayLogActivity(permissions: Permissions, onCustomer: boolean): boolean {
  return hasSubPrivilege(permissions, "sales", "lead_write") && (!onCustomer || hasModuleAccess(permissions, "customers"));
}

/** On a lead and / or a deal the actor may see. Returns the activity and the qualification result. */
export async function logLeadOrDealActivity(tx: Tx, actor: ActivityActor, a: ParsedActivity) {
  if (!a.leadId && !a.opportunityId) throw bad("An activity attaches to a lead or a deal. Say which.");
  const scopeAll = seesAllSales(actor.permissions);
  let customerId: string | null = null;
  if (a.leadId) {
    const lead = await tx.lead.findFirst({ where: { id: a.leadId, ...(scopeAll ? {} : { ownerId: actor.id }) }, select: { id: true, conversion: { select: { customerId: true } } } });
    if (!lead) throw bad("Lead not found.", 404);
    customerId = lead.conversion?.customerId ?? null;
  }
  if (a.opportunityId) {
    const deal = await tx.opportunity.findFirst({ where: { id: a.opportunityId, ...(scopeAll ? {} : { ownerId: actor.id }) }, select: { id: true, customerId: true } });
    if (!deal) throw bad("Deal not found.", 404);
    customerId = customerId ?? deal.customerId;
  }
  // Before the activity: see `lockLeadForAutomation` (a share lock then an exclusive one deadlocks).
  if (a.leadId && (qualifies(a.outcome) || a.outcome === "NOT_INTERESTED")) {
    const present = await lockLeadForAutomation(tx, a.leadId);
    if (!present) throw { _appCode: 404, message: NOT_FOUND_MESSAGE };
  }
  const activity = await tx.activity.create({
    data: {
      type: a.type as never, subject: a.subject, outcome: a.outcome as never, body: a.body,
      leadId: a.leadId, opportunityId: a.opportunityId, customerId, dueAt: a.dueAt,
      completedAt: a.completed ? new Date() : null,
      ownerId: actor.id,
    },
    select: { id: true, type: true, subject: true, outcome: true, dueAt: true, completedAt: true, createdAt: true },
  });
  let qualification = null;
  if (a.leadId && qualifies(a.outcome)) {
    qualification = await qualifyLeadFromActivity(tx, { leadId: a.leadId, activityId: activity.id, outcome: a.outcome, actorId: actor.id });
  } else if (a.leadId && a.outcome === "NOT_INTERESTED") {
    await markLeadNotInterested(tx, { leadId: a.leadId, reason: a.body, actorId: actor.id });
  }
  return { activity, qualification };
}

/** On a customer (optionally one of its deals the actor may see). No qualification: that acts on leads. */
export async function logCustomerActivity(tx: Tx, actor: ActivityActor, customerId: string, a: ParsedActivity) {
  const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
  if (!customer) throw { _appCode: 404, message: NOT_FOUND_MESSAGE };
  if (a.opportunityId) {
    const deal = await tx.opportunity.findFirst({ where: { id: a.opportunityId, customerId, ...(seesAllSales(actor.permissions) ? {} : { ownerId: actor.id }) }, select: { id: true } });
    if (!deal) throw bad("Deal not found.", 404);
  }
  const activity = await tx.activity.create({
    data: {
      type: a.type as never, subject: a.subject, outcome: a.outcome as never, body: a.body,
      customerId, opportunityId: a.opportunityId, dueAt: a.dueAt,
      completedAt: a.completed ? new Date() : null,
      ownerId: actor.id,
    },
    select: { id: true, type: true, subject: true, outcome: true, dueAt: true, completedAt: true, createdAt: true, customerId: true, opportunityId: true },
  });
  return { activity };
}
