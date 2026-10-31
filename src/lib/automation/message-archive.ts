import "server-only";

/**
 * The 180-day retention of message bodies (owner decision, 31 Oct 2026; batch 25).
 *
 * Bodies older than 180 days are MOVED — never deleted — from the live logs (WhatsAppMessage.body,
 * EmailMessage.bodyText) into MessageArchive in our own database, for legal claims. The live row keeps its metadata
 * (who, when, status, the document reference) and gets bodyArchivedAt; its body becomes "". Attachments were never
 * stored: an e-mail's archive row names the document (docKind / docRefId / its number) and the sha256 of the PDF sent.
 *
 * Batches of ≤ BATCH rows, each in ONE transaction: the archive insert and the live update commit together or not at
 * all. The walk is a keyset cursor on (createdAt, id) over the partial index of rows that still have a body, so rows
 * already archived are never scanned again, and it stops starting batches after a time budget well under Vercel's limit
 * (the next day carries on). Rows are claimed FOR UPDATE SKIP LOCKED; the archive's (channel, messageId) is unique and
 * inserted ON CONFLICT DO NOTHING, so a repeated or interrupted run moves nothing twice. A message still waiting or in
 * flight is never touched (and a CHECK keeps an archived row from ever being queued again).
 *
 * Then (batch 25b) the archive itself is kept five years: older archived messages are destroyed by purgeExpiredArchive().
 */
import { prisma } from "@/lib/db";

export const RETENTION_DAYS = 180;
const BATCH = 200;
/** Stop starting new batches after this long (the route's maxDuration is 60 s on Vercel). */
const TIME_BUDGET_MS = 40_000;

/**
 * Switched off unless the deployment sets MESSAGE_ARCHIVE_ENABLED=true (fix round 1): the first run rewrites live
 * WhatsApp rows (their bodies move), a one-way step the owner turns on after checking a dry run.
 */
export function messageArchiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MESSAGE_ARCHIVE_ENABLED === "true";
}

export type ArchiveReport = { whatsapp: number; email: number; batches: number; timedOut: boolean; purged?: number };

/** Owner decision (31 Oct 2026, batch 25b): archived messages are kept FIVE YEARS, then destroyed. */
export const ARCHIVE_RETENTION_YEARS = 5;
const PURGE_BATCH = 500;

/**
 * The 5-year retention (batch 25b): archived messages created more than five years ago are destroyed, in batches, through
 * the database's ONLY controlled path — message_archive_purge_expired() (migration 20261208090000_email_followups): the
 * cutoff is fixed inside it, customers on a legal hold are skipped, and it writes one audit row per batch (count and date
 * range, never the content). Returns how many were destroyed.
 */
export async function purgeExpiredArchive(deadline: number): Promise<{ purged: number; timedOut: boolean }> {
  let purged = 0;
  for (;;) {
    if (Date.now() > deadline) return { purged, timedOut: true };
    const [r] = await prisma.$queryRaw<{ purged: number }[]>`SELECT purged FROM message_archive_purge_expired(${PURGE_BATCH}::integer)`;
    purged += r?.purged ?? 0;
    if (!r || r.purged < PURGE_BATCH) return { purged, timedOut: false };
  }
}

/** customer:<id> inside a WhatsApp dedupe key (rules «run:i:customer:<id>», statuses «…:customer:<id>[:…]»). */
const CUSTOMER_IN_KEY = String.raw`customer:([A-Za-z0-9_-]+)`;
type Cursor = { at: Date; id: string } | null;
const START = { at: new Date(0), id: "" };

/**
 * One batch of one channel, walking the partial index (createdAt, id) WHERE bodyArchivedAt IS NULL from `cursor` on:
 * rows already archived are not in that index, and a row passed in this run (one still waiting or in flight) is never
 * looked at again in this run. Returns how many moved and where the walk stopped (null = the end).
 */
async function batchOf(channel: "whatsapp" | "email", cutoff: Date, now: Date, cursor: Cursor): Promise<{ moved: number; next: Cursor }> {
  const c = cursor ?? START;
  return prisma.$transaction(async (tx) => {
    const picked = channel === "whatsapp"
      ? await tx.$queryRaw<{ id: string; createdAt: Date; status: string }[]>`
          SELECT id, "createdAt", status::text AS status FROM "WhatsAppMessage"
           WHERE "bodyArchivedAt" IS NULL AND "createdAt" < ${cutoff} AND ("createdAt", id) > (${c.at}, ${c.id})
           ORDER BY "createdAt", id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`
      : await tx.$queryRaw<{ id: string; createdAt: Date; status: string }[]>`
          SELECT id, "createdAt", status::text AS status FROM "EmailMessage"
           WHERE "bodyArchivedAt" IS NULL AND "createdAt" < ${cutoff} AND ("createdAt", id) > (${c.at}, ${c.id})
           ORDER BY "createdAt", id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;
    if (picked.length === 0) return { moved: 0, next: null };
    const last = picked[picked.length - 1];
    const ids = picked.filter((r) => r.status !== "QUEUED" && r.status !== "SENDING").map((r) => r.id);
    let moved = 0;
    if (ids.length) {
      if (channel === "whatsapp") {
        await tx.$executeRaw`
          INSERT INTO "MessageArchive" ("id", "channel", "messageId", "customerId", "recipientName", "address", "subject", "body", "ruleName",
                                        "subjectType", "subjectId", "status", "messageCreatedAt", "sentAt", "archivedAt")
          SELECT 'ma_' || m.id, 'whatsapp', m.id, substring(m."dedupeKey" from ${CUSTOMER_IN_KEY}), m."recipientName", m.phone, NULL, m.body, m."ruleName",
                 m."subjectType", m."subjectId", m.status::text, m."createdAt", m."sentAt", ${now}
            FROM "WhatsAppMessage" m WHERE m.id = ANY(${ids})
          ON CONFLICT ("channel", "messageId") DO NOTHING`;
        // Fix round 2 (seat 6 N7): the live body is cleared only when the archive holds THAT body — an insert skipped on a
        // conflict with a different archived copy leaves the message untouched (never a body with no copy).
        moved = await tx.$executeRaw`UPDATE "WhatsAppMessage" m SET body = '', "bodyArchivedAt" = ${now}, "updatedAt" = ${now}
          WHERE m.id = ANY(${ids}) AND EXISTS (SELECT 1 FROM "MessageArchive" a WHERE a.channel = 'whatsapp' AND a."messageId" = m.id AND a.body = m.body)`;
      } else {
        await tx.$executeRaw`
          INSERT INTO "MessageArchive" ("id", "channel", "messageId", "customerId", "recipientName", "address", "subject", "body", "ruleName",
                                        "subjectType", "subjectId", "docKind", "docRefId", "docSha256", "status", "messageCreatedAt", "sentAt", "archivedAt")
          SELECT 'ma_' || m.id, 'email', m.id, m."customerId", m."recipientName", m."toEmail", m.subject, m."bodyText", m."ruleName",
                 m."subjectType", m."subjectId", m."attachmentKind", m."attachmentRefId", m."attachmentSha256", m.status::text, m."createdAt", m."sentAt", ${now}
            FROM "EmailMessage" m WHERE m.id = ANY(${ids})
          ON CONFLICT ("channel", "messageId") DO NOTHING`;
        moved = await tx.$executeRaw`UPDATE "EmailMessage" m SET "bodyText" = '', "bodyArchivedAt" = ${now}, "updatedAt" = ${now}
          WHERE m.id = ANY(${ids}) AND EXISTS (SELECT 1 FROM "MessageArchive" a WHERE a.channel = 'email' AND a."messageId" = m.id AND a.body = m."bodyText")`;
      }
    }
    return { moved, next: picked.length < BATCH ? null : { at: last.createdAt, id: last.id } };
  });
}

export async function archiveOldMessages(opts: { now?: Date; olderThanDays?: number; budgetMs?: number } = {}): Promise<ArchiveReport> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.olderThanDays ?? RETENTION_DAYS) * 86_400_000);
  const deadline = Date.now() + (opts.budgetMs ?? TIME_BUDGET_MS);
  const out: ArchiveReport = { whatsapp: 0, email: 0, batches: 0, timedOut: false };
  for (const channel of ["whatsapp", "email"] as const) {
    let cursor: Cursor = START;
    while (cursor) {
      if (Date.now() > deadline) { out.timedOut = true; return out; }
      const r = await batchOf(channel, cutoff, now, cursor);
      out[channel] += r.moved;
      out.batches++;
      cursor = r.next;
    }
  }
  const p = await purgeExpiredArchive(deadline);
  out.purged = p.purged;
  if (p.timedOut) out.timedOut = true;
  return out;
}
