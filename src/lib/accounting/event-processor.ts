// Turns PENDING / BLOCKED accounting events into posted journal entries, exactly once.
//
// Exactly-once rests on the database, not on this code: JournalEntry.originEventId is
// unique, the event row is locked FOR UPDATE SKIP LOCKED while it is translated, and a
// TRANSLATED event is immutable (trigger). A crash between steps leaves the event PENDING
// with no entry — the whole translation is one transaction — and the next run redoes it.
import { prisma } from "@/lib/db";
import type { AccountingEventStatus, Prisma } from "@/generated/prisma/client";
import { accountingDateOf } from "./dates";
import { AccountingError, PostingBlocked, databaseGuardMessage } from "./errors";
import { POLICY_BY_EVENT } from "./catalog";
import { createEngineEntry } from "./posting";
import { resolvePostingMode } from "./policy";
import { translateCommission } from "./translators/commissions";
import { translateSupplierBill } from "./translators/payables";
import { translateBank } from "./translators/bank";
import { translateReceivables } from "./translators/receivables";
import type { Translation } from "./translators/types";

type Tx = Prisma.TransactionClient;
type EventRow = { id: string; eventType: string; occurredAt: Date; createdAt: Date; payload: Prisma.JsonValue; partyKey: string | null; status: AccountingEventStatus };

const TRANSLATORS: Record<string, (tx: Tx, ev: EventRow) => Promise<Translation>> = {
  "commission.accrual": translateCommission,
  "commission.reversal": translateCommission,
  "commission.adjustment": translateCommission,
  "commission.payout": translateCommission,
  "ap.bill.posted": translateSupplierBill,
  "ap.bill.reversed": translateSupplierBill,
  "bank.transaction.confirmed": translateBank,
  "bank.transaction.voided": translateBank,
  "ar.invoice.posted": translateReceivables,
  "ar.invoice.reversed": translateReceivables,
  "ar.credit_note.posted": translateReceivables,
  "ar.credit_note.reversed": translateReceivables,
  "ar.advance.applied": translateReceivables,
  "ar.advance.reversed": translateReceivables,
};

export type ProcessOutcome = { eventId: string; status: AccountingEventStatus | "BUSY"; journalEntryId?: string; message?: string; provisional?: boolean };

export async function processEvent(eventId: string): Promise<ProcessOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<EventRow[]>`
        SELECT "id", "eventType", "occurredAt", "createdAt", "payload", "partyKey", "status"
          FROM "AccountingEvent" WHERE "id" = ${eventId} FOR UPDATE SKIP LOCKED`;
      const ev = rows[0];
      if (!ev) return { eventId, status: "BUSY" as const };
      if (ev.status === "TRANSLATED" || ev.status === "SKIPPED") return { eventId, status: ev.status };

      const settings = await tx.accountingSettings.findUnique({ where: { id: "singleton" } });
      if (!settings?.setupComplete) throw new PostingBlocked("Accounting setup is not complete.");
      if (!settings.ledgerCutoverDate) {
        throw new PostingBlocked("No ledger cutover date is set, so it is not known whether this event belongs to the opening balance.");
      }
      if (accountingDateOf(ev.occurredAt) < settings.ledgerCutoverDate) {
        const message = `Dated before the ledger cutover (${settings.ledgerCutoverDate.toISOString().slice(0, 10)}); carried by the opening balance.`;
        await tx.accountingEvent.update({ where: { id: ev.id }, data: { status: "SKIPPED", errorMessage: message, attempts: { increment: 1 }, lastAttemptAt: new Date() } });
        return { eventId, status: "SKIPPED" as const, message };
      }

      if (ev.partyKey) {
        const earlier = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(*) AS n FROM "AccountingEvent"
           WHERE "partyKey" = ${ev.partyKey} AND "status" NOT IN ('TRANSLATED', 'SKIPPED')
             AND ("occurredAt", "createdAt", "id") < (${ev.occurredAt}, ${ev.createdAt}, ${ev.id})`;
        if (Number(earlier[0]?.n ?? 0) > 0) {
          throw new PostingBlocked("An earlier event for the same party has not posted yet; events for one party post in order.");
        }
      }

      const translate = TRANSLATORS[ev.eventType];
      if (!translate) throw new PostingBlocked(`No posting rule exists for event type "${ev.eventType}".`);
      const t = await translate(tx, ev);
      if (t.skip !== undefined) {
        await tx.accountingEvent.update({ where: { id: ev.id }, data: { status: "SKIPPED", errorMessage: t.skip, attempts: { increment: 1 }, lastAttemptAt: new Date() } });
        return { eventId, status: "SKIPPED" as const, message: t.skip };
      }
      const policyKey = POLICY_BY_EVENT.get(ev.eventType);
      if (!policyKey) throw new PostingBlocked(`No policy governs "${ev.eventType}".`);
      const mode = await resolvePostingMode(tx, policyKey, t.alsoUnapproved);
      const entry = await createEngineEntry(tx, {
        entryDate: t.entryDate, description: t.description, sourceModule: t.sourceModule,
        sourceDocumentId: t.sourceDocumentId, originEventId: ev.id, lines: t.lines, mode,
      });
      const message = mode.provisional ? `Posted provisionally (isolated test database): ${mode.reasons.join("; ")}.` : null;
      await tx.accountingEvent.update({
        where: { id: ev.id },
        data: { status: "TRANSLATED", journalEntryId: entry.id, errorMessage: message, attempts: { increment: 1 }, lastAttemptAt: new Date() },
      });
      return { eventId, status: "TRANSLATED" as const, journalEntryId: entry.id, provisional: mode.provisional, message: message ?? undefined };
    }, { timeout: 20000 });
  } catch (err) {
    // The translation rolled back. Record why on the event in its own transaction; the
    // status guard means a concurrent successful translation is never overwritten.
    const blocked = err instanceof PostingBlocked;
    const message = err instanceof AccountingError ? err.message : databaseGuardMessage(err) ?? "Unexpected error while posting.";
    if (!(err instanceof AccountingError) && !databaseGuardMessage(err)) console.error("[accounting] event", eventId, err);
    const status: AccountingEventStatus = blocked ? "BLOCKED" : "FAILED";
    await prisma.accountingEvent.updateMany({
      where: { id: eventId, status: { in: ["PENDING", "BLOCKED", "FAILED"] } },
      data: { status, errorMessage: message.slice(0, 1000), attempts: { increment: 1 }, lastAttemptAt: new Date() },
    });
    return { eventId, status, message };
  }
}

/** Process waiting events oldest first. BLOCKED and FAILED ones are retried each run. */
export async function processPendingEvents(limit = 200): Promise<{ processed: ProcessOutcome[] }> {
  const waiting = await prisma.accountingEvent.findMany({
    where: { status: { in: ["PENDING", "BLOCKED", "FAILED"] } },
    orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
    take: Math.min(Math.max(limit, 1), 1000),
  });
  const processed: ProcessOutcome[] = [];
  for (const { id } of waiting) processed.push(await processEvent(id));
  return { processed };
}
