import type { Prisma } from "@/generated/prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Batch serials — one place, two sequences (handoff §9, gaps G07 / G21 / G22).
 *
 * ── The day is the roastery's day, not UTC's (G21) ──────────────────────────
 * The serial used to take its date from toISOString(), so a roast recorded between 00:00 and
 * 03:00 in Riyadh carried the previous day's date on its label. The day is now read in
 * Asia/Riyadh. Existing serials are never renumbered: only new batches use this.
 *
 * ── Roasts and blends no longer share one sequence (G07) ─────────────────────
 * A roast is `YYYYMMDD` + a two-digit daily serial (2026101903). A blend used to be the date
 * plus the last two digits of every source (202610190103), which the roast generator's
 * MAX(SUBSTRING(...)) then read as serial 103 — the next roast of the day became …104. Blends
 * now take their own daily serial with a «B» separator (20261019B01), which the roast pattern
 * (`^YYYYMMDD[0-9]+$`) cannot match, and the roast MAX ignores blend rows altogether, so the
 * blend numbers already stored in the old shape stop disturbing the roast sequence without
 * being rewritten.
 *
 * Both take the same advisory lock (7763, day) the roast generator always took, so a roast and a
 * blend recorded at the same moment queue for the day's numbers instead of racing; the lock is
 * released at commit.
 */
export const BATCH_TIME_ZONE = "Asia/Riyadh";

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: BATCH_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYYMMDD of `at` in Riyadh. Pure. */
export function riyadhDayKey(at: Date = new Date()): string {
  const parts = Object.fromEntries(DAY_FORMAT.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

/** The roast serial that follows `max` on `day`. Pure. */
export function roastSerial(day: string, max: number | null): string {
  return `${day}${String((max ?? 0) + 1).padStart(2, "0")}`;
}

/** The blend serial that follows `max` on `day`. Pure. */
export function blendSerial(day: string, max: number | null): string {
  return `${day}B${String((max ?? 0) + 1).padStart(2, "0")}`;
}

async function lockDay(tx: Tx, day: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7763, ${Number(day) % 2147483647}::int)`;
}

/**
 * The next roast serial of the Riyadh day of `at`. Call inside the transaction that inserts the
 * batch. `excludeBatchId` leaves one batch out of the MAX (a batch being re-dated).
 */
export async function nextRoastBatchNumber(tx: Tx, at: Date = new Date(), excludeBatchId: string | null = null): Promise<string> {
  const day = riyadhDayKey(at);
  await lockDay(tx, day);
  const [{ max }] = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("batchNumber" FROM 9) AS INTEGER)) AS max
      FROM "RoastingBatch"
     WHERE "batchNumber" ~ ${`^${day}[0-9]+$`}
       AND "isBlend" = false
       AND (${excludeBatchId}::text IS NULL OR "id" <> ${excludeBatchId}::text)`;
  return roastSerial(day, max);
}

/** The next blend serial of the Riyadh day of `at` (its own sequence: 20261019B01, B02, …). */
export async function nextBlendBatchNumber(tx: Tx, at: Date = new Date(), excludeBatchId: string | null = null): Promise<string> {
  const day = riyadhDayKey(at);
  await lockDay(tx, day);
  const [{ max }] = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("batchNumber" FROM 10) AS INTEGER)) AS max
      FROM "RoastingBatch"
     WHERE "batchNumber" ~ ${`^${day}B[0-9]+$`}
       AND (${excludeBatchId}::text IS NULL OR "id" <> ${excludeBatchId}::text)`;
  return blendSerial(day, max);
}
