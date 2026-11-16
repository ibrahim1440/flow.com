/**
 * R1-c gate (orchestrator, 14 Nov 2026): a cold server, 20 different users creating orders at the same moment —
 * 201 × 10 and 500 × 10 after ≈ 10.5 s (connection timeout).
 *
 * Why: every writer of a new order number (POST /api/orders, «بيع مباشر» in all its entry points, a quotation's
 * conversion) opens its transaction — which takes a pooled connection — and only then queues on the order-number lock
 * (pg_advisory_xact_lock(7764, 0)). Ten waiters held the whole pool (max 10) while they waited; the other ten never got a
 * connection and failed at the transaction's maxWait (10 s). The same shape as the R1-b gate M1 (a waiter holding a
 * connection), on another lock.
 *
 * The fix, in two layers:
 *   1. Here: an in-process FIFO slot around those transactions. At most ORDER_SLOT_CONCURRENCY of them are open per
 *      server instance; the rest wait IN MEMORY, holding no connection, and start in arrival order. Two slots, so one
 *      writer can do its pre-lock reads while the other holds the lock — the lock window itself is a handful of statements
 *      (R1-c). A waiter that has not started within ORDER_SLOT_WAIT_MS gets 425 ORDER_NUMBER_BUSY + Retry-After: nothing
 *      was written, the screen sends the same request again (lib/request-key.ts fetchKeyedWrite).
 *   2. In createOrderWithNumber: the lock is taken with pg_try_advisory_xact_lock and a short bounded backoff instead of
 *      an unbounded wait, so writers on OTHER instances (whose slots this one cannot see) never hold a connection for
 *      ever either — after ORDER_LOCK_WAIT_MS the transaction rolls back with the same 425.
 *
 * Owner decision 19 = أ is kept: whoever holds the lock keeps it to the end of its transaction. Only the WAITING changed.
 */

export const ORDER_SLOT_CONCURRENCY = 2;
export const ORDER_SLOT_WAIT_MS = 20_000;
export const ORDER_LOCK_WAIT_MS = 8_000;
/** R1-d2 gate L5: at most this many waiting per instance — the next one is told 425 at once instead of queueing. */
export const ORDER_SLOT_MAX_WAITING = 50;

/** The refusal both layers throw — mapped by handleDomainError to 425 with Retry-After. */
export function orderNumberBusy() {
  return {
    _appCode: 425,
    code: "ORDER_NUMBER_BUSY",
    retryAfter: 1,
    // Every screen that writes an order number resends a 425 by itself (lib/request-key.ts fetchKeyedWrite, for up to a
    // minute) — this text is seen only when that did not get through, so it says what is true then.
    message: "طلبات كثيرة في نفس اللحظة وما انحفظ شيء — جرّب بعد شوي.",
    errorAr: "طلبات كثيرة في نفس اللحظة وما انحفظ شيء — جرّب بعد شوي.",
    errorEn: "Many orders are being created at this moment. Nothing was saved; retry shortly with the same key.",
  };
}

type Waiter = { start: () => void; timer: ReturnType<typeof setTimeout> | null };

/** A FIFO counting semaphore. Exported for the unit test; the application uses `withOrderNumberSlot`. */
export function createSlot(concurrency: number, waitMs: number, maxWaiting = ORDER_SLOT_MAX_WAITING) {
  let active = 0;
  const queue: Waiter[] = [];
  const release = () => {
    const next = queue.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.start(); // the slot passes straight to the next waiter: `active` is unchanged
    } else {
      active--;
    }
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < concurrency) {
        active++;
      } else if (queue.length >= maxWaiting) {
        // L5: the queue is full — 425 + Retry-After now (nothing written), never an unbounded line in memory.
        throw orderNumberBusy();
      } else {
        await new Promise<void>((resolve, reject) => {
          const w: Waiter = { start: resolve, timer: null };
          w.timer = setTimeout(() => {
            const i = queue.indexOf(w);
            if (i >= 0) queue.splice(i, 1);
            reject(orderNumberBusy());
          }, waitMs);
          queue.push(w);
        });
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
    stats: () => ({ active, waiting: queue.length }),
  };
}

// One per server instance (module scope). Survives hot reloads in development through globalThis.
const g = globalThis as unknown as { __orderNumberSlot?: ReturnType<typeof createSlot> };
const slot = (g.__orderNumberSlot ??= createSlot(ORDER_SLOT_CONCURRENCY, ORDER_SLOT_WAIT_MS));

/**
 * Run a transaction that will take the order-number lock. Wrap the WHOLE `prisma.$transaction(...)` call (or the call that
 * opens it), never code already inside a transaction — the point is to wait before a connection is taken.
 */
export function withOrderNumberSlot<T>(fn: () => Promise<T>): Promise<T> {
  return slot.run(fn);
}

/** Backoff steps (ms) between attempts at the lock: short first, then capped. */
export function lockBackoffMs(attempt: number): number {
  return Math.min(400, 25 * 2 ** Math.min(attempt, 4));
}
