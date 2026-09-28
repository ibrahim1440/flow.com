// Subledger reads from the posted ledger. Every receivables/payables control-account line records
// the open item it opens or settles (migration open_items); a reversal or void copies it. So the
// balance of an open item on any date is the sum of its posted lines dated on or before that date —
// the same lines the trial balance adds up. Nothing here reads a document's current status or an
// audit timestamp: a document reversed later still counts for dates before its reversal, because
// the reversal journal is dated when it happened.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ZERO } from "./money";

export type OpenItemRow = { partyId: string | null; type: string | null; id: string | null; balance: Prisma.Decimal };

/** Balance (debit − credit) of every open item on an account, up to and including `asOf`. */
export async function openItemBalances(accountId: string, asOf: Date, opts: { partyId?: string; itemIds?: string[] } = {}): Promise<OpenItemRow[]> {
  if (opts.itemIds && !opts.itemIds.length) return [];
  const rows = await prisma.$queryRaw<{ partyId: string | null; type: string | null; id: string | null; bal: string }[]>`
    SELECT l."partyId", l."openItemType" AS type, l."openItemId" AS id, SUM(l."debit" - l."credit")::text AS bal
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" <= ${asOf} AND l."accountId" = ${accountId}
       ${opts.partyId ? Prisma.sql`AND l."partyId" = ${opts.partyId}` : Prisma.empty}
       ${opts.itemIds ? Prisma.sql`AND l."openItemId" IN (${Prisma.join(opts.itemIds)})` : Prisma.empty}
     GROUP BY 1, 2, 3`;
  return rows.map((r) => ({ partyId: r.partyId, type: r.type, id: r.id, balance: new Prisma.Decimal(r.bal) }));
}

/** Total balance (debit − credit) of accounts up to a date, optionally for one party. */
export async function accountsBalance(accountIds: string[], asOf: Date, partyId?: string) {
  if (!accountIds.length) return ZERO;
  const r = await prisma.$queryRaw<{ s: string }[]>`
    SELECT COALESCE(SUM(l."debit" - l."credit"), 0)::text AS s
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" <= ${asOf} AND l."accountId" IN (${Prisma.join(accountIds)})
       ${partyId ? Prisma.sql`AND l."partyId" = ${partyId}` : Prisma.empty}`;
  return new Prisma.Decimal(r[0].s);
}

export type PartyMove = { entryId: string; entryNo: number; date: Date; description: string | null; sourceModule: string | null; sourceDocumentId: string | null; eventType: string | null; net: Prisma.Decimal };

/** A party's posted movements on the given accounts in a date range, one row per journal entry (debit − credit). */
export async function partyMoves(accountIds: string[], partyId: string, from: Date, to: Date): Promise<{ opening: Prisma.Decimal; moves: PartyMove[] }> {
  const dayBefore = new Date(from.getTime() - 86_400_000);
  const opening = await accountsBalance(accountIds, dayBefore, partyId);
  if (!accountIds.length) return { opening, moves: [] };
  const rows = await prisma.$queryRaw<{ entryId: string; entryNo: number; date: Date; description: string | null; sourceModule: string | null; sourceDocumentId: string | null; eventType: string | null; net: string }[]>`
    SELECT e."id" AS "entryId", e."entryNo", e."entryDate" AS date, e."description", e."sourceModule", e."sourceDocumentId",
           ev."eventType", SUM(l."debit" - l."credit")::text AS net
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
      LEFT JOIN "AccountingEvent" ev ON ev."id" = e."originEventId"
     WHERE e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" BETWEEN ${from} AND ${to}
       AND l."accountId" IN (${Prisma.join(accountIds)}) AND l."partyId" = ${partyId}
     GROUP BY e."id", e."entryNo", e."entryDate", e."description", e."sourceModule", e."sourceDocumentId", ev."eventType"
     ORDER BY e."entryDate", e."entryNo"`;
  return { opening, moves: rows.map((r) => ({ ...r, net: new Prisma.Decimal(r.net) })) };
}

/** Accounting events that did not (yet) produce a journal, for the explanation of a difference. */
export async function unpostedEvents(eventTypes: string[]) {
  return prisma.accountingEvent.count({ where: { eventType: { in: eventTypes }, status: { in: ["PENDING", "BLOCKED", "FAILED"] } } });
}
