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
//   4. (Pipeline v2) The deal's `nextFollowUpAt` is computed the same way (`syncDealNextFollowUp`), and the system's
//      own follow-ups are KEYED (`Activity.sourceKey`, one OPEN row per key): a sample's feedback reminder
//      (`sample:<id>`) is created once however many paths reach SENT, and closes itself when the feedback is
//      recorded or the sample is cancelled; the deal's «جدولة متابعة» (`deal-follow-up:<id>`) is moved, never doubled.
//
// Each is a conditional write, so a retried or concurrent request changes nothing twice.
import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { SAMPLE_FEEDBACK_DAYS } from "./next-step";
import { riyadhDay } from "@/lib/order-stage";

type Tx = PrismaNS.TransactionClient;

// A WhatsApp conversation or an email is a contact too (20261206090000_sales_myday).
export const CONTACT_TYPES = ["CALL", "VISIT", "MEETING", "WHATSAPP", "EMAIL"] as const;
/** The planned-contact types a recorded result fulfils (rule 2). */
const FULFILLABLE = ["CALL", "VISIT", "MEETING", "TASK"];
/** WorkTask statuses that still promise something (lib/workspace/rules.ts OPEN_STATUSES, minus review). */
const OPEN_TASK = ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD"];

/** Rule 1. Only NEW → CONTACTED: a qualified, converted or closed lead is never moved back. */
export async function markLeadContacted(tx: Tx, leadId: string): Promise<boolean> {
  const r = await tx.lead.updateMany({ where: { id: leadId, status: "NEW" }, data: { status: "CONTACTED" } });
  return r.count > 0;
}

/**
 * Rule 2. Returns how many planned contacts were fulfilled. `exceptId` is the activity just recorded.
 * P1 ERR-03 (owner QA): a NOTE is not a contact — it fulfils nothing; and only what was due by the end of TODAY (Riyadh)
 * is fulfilled — a call recorded today never closes next week's planned visit (that promise is still to keep).
 */
export async function fulfilPlannedContacts(
  tx: Tx,
  input: { ownerId: string; type?: string | null; leadId?: string | null; opportunityId?: string | null; customerId?: string | null; exceptId?: string | null; now?: Date },
): Promise<number> {
  if (input.type === "NOTE") return 0;
  const on = [
    ...(input.leadId ? [{ leadId: input.leadId }] : []),
    ...(input.opportunityId ? [{ opportunityId: input.opportunityId }] : []),
    // A contact recorded on the customer itself keeps the customer-level promises (not a deal's).
    ...(input.customerId && !input.opportunityId ? [{ customerId: input.customerId, opportunityId: null, leadId: null }] : []),
  ];
  if (!on.length) return 0;
  const r = await tx.activity.updateMany({
    where: {
      ownerId: input.ownerId, completedAt: null, dueAt: { not: null, lt: riyadhDay(input.now ?? new Date()).end }, type: { in: FULFILLABLE as never[] },
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

// ── Pipeline v2: keyed system follow-ups and the deal's computed date (rule 4) ──────────────────────────────────

const DAY = 86_400_000;
export const sampleFollowUpKey = (sampleId: string) => `sample:${sampleId}`;
export const dealFollowUpKey = (dealId: string) => `deal-follow-up:${dealId}`;

/**
 * Rule 4. The deal's next follow-up, from what is still open: the earliest open dated activity or open FOLLOW_UP
 * workspace task on the deal, or null. Mirrors `syncLeadNextFollowUp`; the column is never typed by hand any more.
 */
export async function syncDealNextFollowUp(tx: Tx, opportunityId: string): Promise<Date | null> {
  const [act, task] = await Promise.all([
    tx.activity.findFirst({ where: { opportunityId, completedAt: null, dueAt: { not: null } }, orderBy: { dueAt: "asc" }, select: { dueAt: true } }),
    tx.workTask.findFirst({ where: { opportunityId, kind: "FOLLOW_UP", status: { in: OPEN_TASK as never[] } }, orderBy: { dueAt: "asc" }, select: { dueAt: true } }),
  ]);
  const dates = [act?.dueAt, task?.dueAt].filter((d): d is Date => !!d);
  const next = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
  await tx.opportunity.updateMany({ where: { id: opportunityId }, data: { nextFollowUpAt: next } });
  return next;
}

// Follow-up dates TYPED before v2 are converted once, at deploy, by migration step 1d (each becomes the deal's keyed
// follow-up task); nothing types a deal's date after v2, so the recompute above never needs to guess at one. A runtime
// "adopt the typed date" (gate round 1) resurrected dates a rep had moved or deleted (gate round 2, R2-M1) and was
// removed; no "never null" guard replaces it — a moved or deleted promise must clear.

/** Both follow-up dates a change on a record can move (a workspace task or an activity names a lead and/or a deal). */
export async function syncFollowUps(tx: Tx, on: { leadId?: string | null; opportunityId?: string | null }): Promise<void> {
  if (on.leadId) await syncLeadNextFollowUp(tx, on.leadId);
  if (on.opportunityId) await syncDealNextFollowUp(tx, on.opportunityId);
}

/**
 * The sample's feedback reminder (D1): ONE open SAMPLE_FOLLOW_UP per sample, due `SAMPLE_FEEDBACK_DAYS` after it was
 * sent (the same clock my-day uses). Idempotent — the partial unique index on the open `sourceKey` makes a second
 * call (dispatch issuing a sample a rep already marked, a retried request) a no-op. Returns whether a row was written.
 */
export async function ensureSampleFollowUp(
  tx: Tx,
  s: { sampleId: string; opportunityId: string; description: string | null; ownerId: string; sentAt: Date },
): Promise<boolean> {
  const key = sampleFollowUpKey(s.sampleId);
  const due = new Date(s.sentAt.getTime() + SAMPLE_FEEDBACK_DAYS * DAY);
  // P1 ERR-05: the rep reads it in Arabic on «يومي» and the deal.
  const subject = `متابعة العيّنة: ${s.description || "عيّنة منتج"}`;
  const n = await tx.$executeRaw`
    INSERT INTO "Activity" ("id", "type", "subject", "opportunityId", "dueAt", "ownerId", "sourceKey", "createdAt", "updatedAt")
    VALUES ('sfu_' || md5(${key} || clock_timestamp()::text), 'SAMPLE_FOLLOW_UP'::"ActivityType", ${subject}, ${s.opportunityId}, ${due}, ${s.ownerId}, ${key}, now(), now())
    ON CONFLICT ("sourceKey") WHERE "sourceKey" IS NOT NULL AND "completedAt" IS NULL DO NOTHING`;
  await syncDealNextFollowUp(tx, s.opportunityId);
  return n > 0;
}

/**
 * The sample's reminder is done: its feedback was recorded or it was cancelled (or declined by the manager). Closes
 * the keyed row, and — for samples sent before pipeline v2, whose reminder has no key — the deal's open unkeyed
 * SAMPLE_FOLLOW_UP rows that no other live sample still needs. Returns how many rows were closed.
 */
export async function closeSampleFollowUp(tx: Tx, s: { sampleId: string; opportunityId: string }, now: Date = new Date()): Promise<number> {
  const keyed = await tx.activity.updateMany({
    where: { sourceKey: sampleFollowUpKey(s.sampleId), completedAt: null },
    data: { completedAt: now },
  });
  let legacy = 0;
  const stillSent = await tx.sampleShipment.count({ where: { opportunityId: s.opportunityId, id: { not: s.sampleId }, status: "SENT" } });
  if (stillSent === 0) {
    legacy = (await tx.activity.updateMany({
      where: { opportunityId: s.opportunityId, type: "SAMPLE_FOLLOW_UP", sourceKey: null, completedAt: null },
      data: { completedAt: now },
    })).count;
  }
  await syncDealNextFollowUp(tx, s.opportunityId);
  return keyed.count + legacy;
}

/**
 * The deal's «جدولة متابعة» (D2, D4): one TASK activity keyed `deal-follow-up:<dealId>`. Scheduling again MOVES the
 * open one (its due date and subject) instead of adding a second; `dueAt: null` completes it. Then the deal's date is
 * recomputed from what is open. Returns the open row's id, or null when cleared.
 */
export async function scheduleDealFollowUp(
  tx: Tx,
  input: { opportunityId: string; ownerId: string; dueAt: Date | null; subject?: string | null; now?: Date },
): Promise<string | null> {
  const key = dealFollowUpKey(input.opportunityId);
  const open = await tx.activity.findFirst({ where: { sourceKey: key, completedAt: null }, select: { id: true } });
  if (!input.dueAt) {
    if (open) await tx.activity.update({ where: { id: open.id }, data: { completedAt: input.now ?? new Date() } });
    await syncDealNextFollowUp(tx, input.opportunityId);
    return null;
  }
  const subject = (input.subject ?? "").trim() || "متابعة الصفقة";
  let id: string;
  if (open) {
    await tx.activity.update({ where: { id: open.id }, data: { dueAt: input.dueAt, subject } });
    id = open.id;
  } else {
    // Two people scheduling at once: the partial unique index lets one INSERT win; the other moves the winner's row.
    const deal = await tx.opportunity.findUnique({ where: { id: input.opportunityId }, select: { customerId: true } });
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "Activity" ("id", "type", "subject", "opportunityId", "customerId", "dueAt", "ownerId", "sourceKey", "createdAt", "updatedAt")
      VALUES ('dfu_' || md5(${key} || clock_timestamp()::text), 'TASK'::"ActivityType", ${subject}, ${input.opportunityId}, ${deal?.customerId ?? null},
              ${input.dueAt}, ${input.ownerId}, ${key}, now(), now())
      ON CONFLICT ("sourceKey") WHERE "sourceKey" IS NOT NULL AND "completedAt" IS NULL
      DO UPDATE SET "dueAt" = EXCLUDED."dueAt", "subject" = EXCLUDED."subject", "updatedAt" = now()
      RETURNING "id"`;
    id = rows[0].id;
  }
  await syncDealNextFollowUp(tx, input.opportunityId);
  return id;
}
