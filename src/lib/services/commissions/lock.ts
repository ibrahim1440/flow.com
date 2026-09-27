/**
 * The one consistency boundary the money operations share.
 *
 * A payout, a reversal and an approval all read a balance and then write against it, and
 * Prisma runs transactions at Read Committed — so without a common lock two of them can
 * each read the same available balance and each decide it is enough. The subject is always
 * an employee and a period, so that is the key, and every operation that can move the
 * balance takes it. Advisory rather than row-level because the thing being protected is a
 * DERIVED figure spanning several tables, not one row.
 */
export function payoutLockKey(employeeId: string, periodStart: Date): string {
  return `commission-balance:${employeeId}:${periodStart.toISOString().slice(0, 10)}`;
}
