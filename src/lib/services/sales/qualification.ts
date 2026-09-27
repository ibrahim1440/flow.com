import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { convertLead } from "./leads";
import { requireStageFor } from "./stages";

type Tx = PrismaNS.TransactionClient;

/**
 * Lead → Pipeline, decided by what actually happened.
 *
 * ── The distinction this whole file exists to make ──
 * A prospect list is not a pipeline. Importing four hundred names from an exhibition badge
 * scanner and calling them deals makes a forecast out of a mailing list. So a lead becomes
 * a deal only when the CUSTOMER has done something: confirmed interest, agreed to an
 * appointment, or kept one.
 *
 * "No answer" and "left a message" are the salesperson doing something. A NOTE is somebody
 * writing to themselves. A TASK is a reminder — scheduling a call for Tuesday is not the
 * customer agreeing to a call on Tuesday, and treating the two alike is precisely how a
 * pipeline fills with deals nobody is working.
 *
 * ── Why the trigger is an outcome and not a subject line ──
 * The outcome is a stored enum the server reads. Inferring qualification from free text
 * would make the pipeline depend on how somebody phrased a note, in a system where notes
 * are written in Arabic, English and both at once.
 */

export type ActivityOutcomeValue =
  | "NO_ANSWER"
  | "LEFT_MESSAGE"
  | "INTERESTED"
  | "MEETING_SCHEDULED"
  | "VISIT_SCHEDULED"
  | "MEETING_COMPLETED"
  | "VISIT_COMPLETED"
  | "FOLLOW_UP_REQUIRED"
  | "NOT_INTERESTED"
  | "NOTE_ONLY";

export const ACTIVITY_OUTCOMES: ActivityOutcomeValue[] = [
  "NO_ANSWER",
  "LEFT_MESSAGE",
  "INTERESTED",
  "MEETING_SCHEDULED",
  "VISIT_SCHEDULED",
  "MEETING_COMPLETED",
  "VISIT_COMPLETED",
  "FOLLOW_UP_REQUIRED",
  "NOT_INTERESTED",
  "NOTE_ONLY",
];

/**
 * The five that mean the customer engaged.
 *
 * Interest confirmed, an appointment agreed, or an appointment held. Nothing else — and in
 * particular not FOLLOW_UP_REQUIRED, which is the salesperson's own intention, and not
 * NOT_INTERESTED, which is the opposite of a sale.
 */
export const QUALIFYING_OUTCOMES: ReadonlySet<string> = new Set<ActivityOutcomeValue>([
  "INTERESTED",
  "MEETING_SCHEDULED",
  "VISIT_SCHEDULED",
  "MEETING_COMPLETED",
  "VISIT_COMPLETED",
]);

/** True when this outcome is a customer appointment rather than an internal reminder. */
export const APPOINTMENT_OUTCOMES: ReadonlySet<string> = new Set<ActivityOutcomeValue>([
  "MEETING_SCHEDULED",
  "VISIT_SCHEDULED",
]);

export function qualifies(outcome: string | null | undefined): boolean {
  return outcome != null && QUALIFYING_OUTCOMES.has(outcome);
}

/** Why the deal appeared, written onto its history in the language of what happened. */
const REASON: Record<string, string> = {
  INTERESTED: "Automatic: the customer confirmed interest",
  MEETING_SCHEDULED: "Automatic: a customer meeting was scheduled",
  VISIT_SCHEDULED: "Automatic: a customer visit was scheduled",
  MEETING_COMPLETED: "Automatic: a customer meeting was held",
  VISIT_COMPLETED: "Automatic: a customer visit was held",
};

export type QualificationResult = {
  opportunityId: string;
  customerId: string;
  /** True when this call found the deal rather than making it. */
  replayed: boolean;
  /** True when a deal already existed and was simply linked to, not advanced. */
  alreadyInPipeline: boolean;
};

/**
 * Take the lead's row lock BEFORE writing anything that references the lead.
 *
 * ── Why this exists, and why the caller has to remember it ──
 * Inserting an `Activity` that carries a `leadId` makes PostgreSQL take a `FOR KEY SHARE`
 * lock on the referenced `Lead` row, to stop the parent disappearing under the child.
 * `convertLead` then wants `FOR UPDATE` on that same row. Within one transaction that is a
 * harmless upgrade; between two it is a deadlock, and PostgreSQL resolves it by killing one
 * of them with 40P01 — which reaches the salesperson as a 500 on a call they logged
 * correctly. Two reps logging a meeting on the same lead at the same second is not an
 * exotic case; it is what happens when a form is double-submitted.
 *
 * Taking the exclusive lock first removes the upgrade: the second caller blocks here,
 * before it has taken any lock of its own, and proceeds once the first has committed — by
 * which time it can see the conversion and correctly treats itself as a replay.
 *
 * Returns false when the lead does not exist, so the caller can answer 404 rather than
 * carrying on and failing on a foreign key.
 */
export async function lockLeadForAutomation(tx: Tx, leadId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Lead" WHERE "id" = ${leadId} FOR UPDATE
  `;
  return rows.length > 0;
}

/**
 * Qualify a lead because of something that happened on it.
 *
 * Transactional and idempotent, and it has to be both: this runs inside the same
 * transaction as the activity that triggered it, and the activity write is a form people
 * double-submit. `convertLead` takes the lead row FOR UPDATE and `LeadConversion` is unique
 * on `leadId`, so a second concurrent call queues and then reads what the first wrote.
 *
 * The caller must already hold the lead's row lock — see `lockLeadForAutomation` for what
 * goes wrong when the activity is written first.
 *
 * Returns `null` when the outcome does not qualify — the caller has written a perfectly
 * good activity and nothing further should happen.
 */
export async function qualifyLeadFromActivity(
  tx: Tx,
  input: {
    leadId: string;
    activityId: string;
    outcome: string | null | undefined;
    actorId: string;
  },
): Promise<QualificationResult | null> {
  if (!qualifies(input.outcome)) return null;

  const existing = await tx.leadConversion.findUnique({
    where: { leadId: input.leadId },
    select: { customerId: true, opportunityId: true },
  });

  if (existing) {
    // The lead is already in the pipeline. Attach the activity to the deal so the
    // conversation is readable from both, and stop.
    //
    // Deliberately no stage change: a deal that has reached Negotiation does not go back to
    // Qualification because somebody logged another meeting, and a Won or Lost deal is not
    // silently reopened. Moving it is a human decision with its own control and its own
    // audit entry.
    await tx.activity.update({
      where: { id: input.activityId },
      data: { opportunityId: existing.opportunityId, customerId: existing.customerId },
    });
    return { ...existing, replayed: true, alreadyInPipeline: true };
  }

  // Where a newly-qualified lead lands, resolved from configuration rather than guessed.
  const stage = await requireStageFor(tx, "QUALIFICATION");

  const conversion = await convertLead(tx, {
    leadId: input.leadId,
    stageId: stage.id,
    actorId: input.actorId,
  });

  // The activity that caused it is linked to the deal it caused, so the history reads as
  // cause and effect rather than as two unrelated rows with similar timestamps.
  await tx.activity.update({
    where: { id: input.activityId },
    data: { opportunityId: conversion.opportunityId, customerId: conversion.customerId },
  });

  // `convertLead` already writes "Created by lead conversion". This second entry says WHY,
  // which is the part a reader wants six weeks later. Written only on the call that
  // actually created the deal, so a replay adds no history.
  if (!conversion.replayed) {
    await tx.opportunityStageEvent.create({
      data: {
        opportunityId: conversion.opportunityId,
        toStageId: stage.id,
        toOutcome: "OPEN",
        reason: REASON[input.outcome as string] ?? "Automatic: qualified from a sales interaction",
        actorId: input.actorId,
      },
    });
  }

  return {
    opportunityId: conversion.opportunityId,
    customerId: conversion.customerId,
    replayed: conversion.replayed,
    alreadyInPipeline: false,
  };
}

/**
 * "Not interested" on a lead that never became a deal.
 *
 * Only ever touches the lead. An active opportunity is NOT closed from a generic activity
 * result: losing a deal is an explicit act that requires a reason and is recorded as such,
 * and inferring it from a dropdown would let a mis-click close somebody's forecast.
 */
export async function markLeadNotInterested(
  tx: Tx,
  input: { leadId: string; reason: string | null; actorId: string },
): Promise<{ changed: boolean; hasOpportunity: boolean }> {
  const conversion = await tx.leadConversion.findUnique({
    where: { leadId: input.leadId },
    select: { opportunityId: true },
  });
  if (conversion) return { changed: false, hasOpportunity: true };

  const lead = await tx.lead.findUnique({
    where: { id: input.leadId },
    select: { status: true, notes: true },
  });
  if (!lead || lead.status === "UNQUALIFIED") return { changed: false, hasOpportunity: false };

  const stamp = input.reason?.trim()
    ? `\n[${new Date().toISOString().slice(0, 10)}] غير مهتم: ${input.reason.trim()}`
    : "";

  await tx.lead.update({
    where: { id: input.leadId },
    data: {
      status: "UNQUALIFIED",
      notes: stamp ? `${lead.notes ?? ""}${stamp}`.trim() : lead.notes,
    },
  });
  return { changed: true, hasOpportunity: false };
}
