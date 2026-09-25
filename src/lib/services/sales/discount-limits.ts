/**
 * The two discount limits, as plain numbers.
 *
 * They live apart from `quotes.ts` so a client screen can state them without pulling the
 * pricing engine — and `Decimal` with it — into the browser bundle. `quotes.ts` wraps these
 * in `Decimal` for the arithmetic and the enforcement; nothing else may restate them.
 */

/** Above this, issuing a quotation needs the discount-approval privilege. */
export const DISCOUNT_APPROVAL_THRESHOLD = 10;

/** Above this, a discount is refused outright — correct the price instead. */
export const DISCOUNT_MAX = 60;
