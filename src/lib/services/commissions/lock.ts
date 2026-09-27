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

/**
 * The second boundary, taken only by the payout path: the idempotency key itself.
 *
 * The key must mean one payment across the whole ledger, but the balance lock above is per
 * employee and period, so two requests replaying the same key against *different* employees
 * would take different balance locks and could both pass the reuse check. This one is on
 * the key, so they queue.
 *
 * **Always taken after `payoutLockKey`.** Nothing else in the system takes this lock, and
 * the payout path takes the two in a fixed order, so there is no pair of transactions that
 * can acquire them in opposite orders and deadlock.
 */
export function payoutKeyLock(idempotencyKey: string): string {
  return `commission-payout-key:${idempotencyKey}`;
}
