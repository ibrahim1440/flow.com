// Whether a budget row's actual can be trusted yet. Pure: no database, no I/O.
//
// A zero actual means one of two different things: nothing happened (a verified zero), or
// something may have happened that the books do not show yet (missing data). The row is only
// called "not yet verified" when a concrete indicator says data could still arrive for it:
//   - an unreviewed line in the row's direction that is unclassified or classified to it,
//   - a pending line in the row's direction that is unclassified or classified to it,
//   - an account in scope not reconciled through the report date (statement lines after the
//     last reconciliation may not have been imported).
import type { Minor } from "./money";

export type OpenLine = {
  /** Signed halalas: receipts positive, payments negative. */
  amount: Minor;
  status: "CONFIRMED" | "PENDING";
  reviewStatus: "NEEDS_REVIEW" | "REVIEWED";
  /** Budget categories the line is split to; empty while it is unclassified. */
  finCategoryIds: string[];
};

export type RowCompleteness = {
  verified: boolean;
  unreviewed: number;
  pending: number;
  /** Codes of accounts in scope whose last completed reconciliation is before the report date. */
  unreconciled: string[];
};

export function rowCompleteness(row: { kind: "RECEIPT" | "PAYMENT"; finCategoryId: string }, lines: OpenLine[], unreconciled: string[]): RowCompleteness {
  const relevant = lines.filter((l) => (row.kind === "RECEIPT" ? l.amount > 0 : l.amount < 0) && (l.finCategoryIds.length === 0 || l.finCategoryIds.includes(row.finCategoryId)));
  const unreviewed = relevant.filter((l) => l.reviewStatus === "NEEDS_REVIEW").length;
  const pending = relevant.filter((l) => l.status === "PENDING").length;
  return { verified: unreviewed === 0 && pending === 0 && unreconciled.length === 0, unreviewed, pending, unreconciled };
}

/** Accounts whose last completed reconciliation does not reach the report date. */
export function unreconciledAccounts(accounts: { id: string; code: string }[], lastReconciled: Map<string, string>, reportDate: string): string[] {
  return accounts.filter((a) => { const d = lastReconciled.get(a.id); return !d || d < reportDate; }).map((a) => a.code).sort();
}
