// «المتابعة» — what happens around a recorded contact, in ONE place, inside the caller's transaction.
//
// A rep's promise to call somebody lived in up to three places that never spoke: an open CRM
// activity with a due date (the lead page's «جدولة متابعة», the samples' feedback reminder), a
// workspace FOLLOW_UP task, and the lead's `nextFollowUpAt` column the lead list sorts and counts
// on. Recording the result in one of them left the others open — the same promise twice on «اليوم»,
// and a lead list that called a lead overdue after the call had been made. The rules here are the
// single answer, called by every path that records a result:
//
//   1. A completed call, visit or meeting moves a NEW lead to CONTACTED (nothing else did, ever).
//   2. A result recorded on a lead / deal fulfils the planned contacts the person had open on that
//      same record (CALL / VISIT / MEETING / TASK with a due date) — the promise was kept. A sample's
//      feedback reminder (SAMPLE_FOLLOW_UP) is a different promise and stays open until its result.
//   3. The lead's `nextFollowUpAt` is recomputed from what is actually still open: the earliest due
//      open activity or open FOLLOW_UP workspace task on the lead; null when nothing is promised.
//
// Each is a conditional write, so a retried or concurrent request changes nothing twice.
import type { Prisma as PrismaNS } from "@/generated/prisma/client";

type Tx = PrismaNS.TransactionClient;

export const CONTACT_TYPES = ["CALL", "VISIT", "MEETING"] as const;
/** The planned-contact types a recorded result fulfils (rule 2). */
const FULFILLABLE = ["CALL", "VISIT", "MEETING", "TASK"];
/** WorkTask statuses that still promise something (lib/workspace/rules.ts OPEN_STATUSES, minus review). */
const OPEN_TASK = ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD"];

/** Rule 1. Only NEW → CONTACTED: a qualified, converted or closed lead is never moved back. */
export async function markLeadContacted(tx: Tx, leadId: string): Promise<boolean> {
  const r = await tx.lead.updateMany({ where: { id: leadId, status: "NEW" }, data: { status: "CONTACTED" } });
  return r.count > 0;
}

/** Rule 2. Returns how many planned contacts were fulfilled. `exceptId` is the activity just recorded. */
export async function fulfilPlannedContacts(
  tx: Tx,
  input: { ownerId: string; leadId?: string | null; opportunityId?: string | null; customerId?: string | null; exceptId?: string | null; now?: Date },
): Promise<number> {
  const on = [
    ...(input.leadId ? [{ leadId: input.leadId }] : []),
    ...(input.opportunityId ? [{ opportunityId: input.opportunityId }] : []),
    // A contact recorded on the customer itself keeps the customer-level promises (not a deal's).
    ...(input.customerId && !input.opportunityId ? [{ customerId: input.customerId, opportunityId: null, leadId: null }] : []),
  ];
  if (!on.length) return 0;
  const r = await tx.activity.updateMany({
    where: {
      ownerId: input.ownerId, completedAt: null, dueAt: { not: null }, type: { in: FULFILLABLE as never[] },
      OR: on, ...(input.exceptId ? { id: { not: input.exceptId } } : {}),
    },
    data: { completedAt: input.now ?? new Date() },
  });
  return r.count;
}

/** Rule 3. The lead's next follow-up, from what is still open. Returns the date written. */
export async function syncLeadNextFollowUp(tx: Tx, leadId: string): Promise<Date | null> {
  const [act, task] = await Promise.all([
    tx.activity.findFirst({ where: { leadId, completedAt: null, dueAt: { not: null } }, orderBy: { dueAt: "asc" }, select: { dueAt: true } }),
    tx.workTask.findFirst({ where: { leadId, kind: "FOLLOW_UP", status: { in: OPEN_TASK as never[] } }, orderBy: { dueAt: "asc" }, select: { dueAt: true } }),
  ]);
  const dates = [act?.dueAt, task?.dueAt].filter((d): d is Date => !!d);
  const next = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
  await tx.lead.update({ where: { id: leadId }, data: { nextFollowUpAt: next } });
  return next;
}

export type NextStepSuggestion = { channel: "CALL" | "VISIT" | "MEETING"; inDays: number; titleAr: string; titleEn: string };

/**
 * What the system proposes after an outcome (the dialog pre-ticks «الخطوة التالية» with it; the rep
 * may change or clear it). Null where nothing should follow: not interested, a note, a closed loop.
 * Pure, so the screen and the tests ask the same question.
 */
export function suggestNextStep(outcome: string | null | undefined): NextStepSuggestion | null {
  switch (outcome) {
    case "NO_ANSWER": return { channel: "CALL", inDays: 1, titleAr: "إعادة الاتصال", titleEn: "Call again" };
    case "LEFT_MESSAGE": return { channel: "CALL", inDays: 2, titleAr: "متابعة الرسالة", titleEn: "Follow up the message" };
    case "FOLLOW_UP_REQUIRED": return { channel: "CALL", inDays: 3, titleAr: "متابعة", titleEn: "Follow up" };
    case "INTERESTED": return { channel: "VISIT", inDays: 3, titleAr: "زيارة لتحليل الاحتياج", titleEn: "Visit to analyse the need" };
    case "MEETING_SCHEDULED": return { channel: "MEETING", inDays: 2, titleAr: "الاجتماع المتفق عليه", titleEn: "The agreed meeting" };
    case "VISIT_SCHEDULED": return { channel: "VISIT", inDays: 2, titleAr: "الزيارة المتفق عليها", titleEn: "The agreed visit" };
    case "MEETING_COMPLETED":
    case "VISIT_COMPLETED": return { channel: "CALL", inDays: 3, titleAr: "متابعة بعد اللقاء", titleEn: "Follow up after the meeting" };
    default: return null;
  }
}
