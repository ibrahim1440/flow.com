import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { convertLead } from "./leads";
import { requireStageFor } from "./stages";
import { mergeNeeds, qualificationMissing, type NeedsFields, type QualificationField } from "./needs";

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
 *
 * ── Engagement is necessary, not sufficient (20261204100000_pipeline_qualification) ──
 * The approved pipeline starts at «فرصة مؤهلة», and "the customer said they were interested"
 * is not yet a qualified opportunity: nobody can quote, sample or forecast a deal whose business
 * type, need and next step are unknown. So, with SystemConfig.salesRequireQualificationMinimum
 * on (the default), a qualifying outcome converts only when the lead's business type, need and
 * agreed next step are known — from the lead itself or from the activity's `qualification`
 * payload. When they are not, the activity is still logged, the lead becomes CONTACTED, and the
 * result names what is missing so the form can ask for it there and then. The monthly volume is
 * recorded when given and never required. Turning the setting off restores the old rule exactly.
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

export type QualificationResult =
  | {
      /** The lead is in the pipeline (converted now, or already). */
      converted: true;
      opportunityId: string;
      customerId: string;
      /** True when this call found the deal rather than making it. */
      replayed: boolean;
      /** True when a deal already existed and was simply linked to, not advanced. */
      alreadyInPipeline: boolean;
    }
  | {
      /**
       * The customer engaged, but the qualification minimum is not known yet: the activity is
       * logged, the lead is CONTACTED, and `missing` names what the form should ask for inline
       * (in the order to ask it). Sending the activity again with `qualification` completes it.
       */
      converted: false;
      missing: QualificationField[];
      opportunityId: null;
      leadStatus: string;
    };

/**
 * Whether a qualifying outcome needs the minimum before it converts
 * (SystemConfig.salesRequireQualificationMinimum; default on, a missing settings row reads as on).
 */
export async function requiresQualificationMinimum(tx: Tx): Promise<boolean> {
  const row = await tx.systemConfig.findUnique({
    where: { id: "singleton" },
    select: { salesRequireQualificationMinimum: true },
  });
  return row?.salesRequireQualificationMinimum ?? true;
}

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
 *
 * `qualification` is what the activity form supplied (`parseQualificationInput`): only answered
 * fields, never blanks. Whatever it carries is saved on the lead first, converted or not, so an
 * answer given on a call that did not complete the minimum is not asked for twice.
 */
export async function qualifyLeadFromActivity(
  tx: Tx,
  input: {
    leadId: string;
    activityId: string;
    outcome: string | null | undefined;
    actorId: string;
    qualification?: Partial<NeedsFields> | null;
  },
): Promise<QualificationResult | null> {
  if (!qualifies(input.outcome)) return null;

  const existing = await tx.leadConversion.findUnique({
    where: { leadId: input.leadId },
    select: { customerId: true, opportunityId: true },
  });

  // Answers given on this activity are kept on the lead, whatever happens next. On a lead that
  // already converted they stop there: the deal's needs are edited on the deal, where a later
  // answer must not silently overwrite what the deal page shows.
  const supplied = input.qualification && Object.keys(input.qualification).length > 0 ? input.qualification : null;
  if (supplied) {
    await tx.lead.update({ where: { id: input.leadId }, data: supplied });
  }

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
    return { converted: true, ...existing, replayed: true, alreadyInPipeline: true };
  }

  // The minimum: what the lead holds (now including this activity's answers). `convertLead`
  // copies the same four columns onto the deal it creates, so the deal starts with them.
  if (await requiresQualificationMinimum(tx)) {
    const lead = await tx.lead.findUniqueOrThrow({
      where: { id: input.leadId },
      select: { status: true, businessType: true, needSummary: true, expectedMonthlyKg: true, agreedNextStep: true },
    });
    const missing = qualificationMissing(mergeNeeds(lead as Partial<NeedsFields>, null));
    if (missing.length > 0) {
      // Engaged but not qualified: the lead is "contacted" — the existing status that means a
      // conversation is under way. Only a NEW lead moves; a QUALIFIED one (set by hand) or an
      // UNQUALIFIED one (a decision somebody made) is not overruled by a dropdown.
      let leadStatus = lead.status as string;
      if (lead.status === "NEW") {
        await tx.lead.update({ where: { id: input.leadId }, data: { status: "CONTACTED" } });
        leadStatus = "CONTACTED";
      }
      return { converted: false, missing, opportunityId: null, leadStatus };
    }
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
    converted: true,
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
