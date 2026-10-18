// Phase 1 — MANUAL JOURNALS DISABLED (owner decision D1, Option B; migration 20261017215000).
//
// HrSettings."manualJournalsEnabled" is off by default and FAIL-CLOSED: a missing row, a read error or
// anything but exactly true is disabled. While it is off, nobody — administrators on role defaults or
// with every privilege included — creates, changes, submits, approves, posts or reverses a journal
// through the generic ledger (`/api/accounting/journals…`, journal-service): 409
// MANUAL_JOURNALS_DISABLED, Arabic + English. Reading journals and reports stays available.
//
// AUTOMATIC postings of approved operational workflows are not manual journals and keep posting. The
// inventory of every code path that writes "JournalEntry" (docs/hr/PAYROLL-LOCK.md, "Manual journals"):
//   AUTOMATIC (allowlisted, sourceModule 'hr'): src/lib/hr/services/accounting-bridge.ts — postJournal
//     (payroll accrual / payment / return, final settlement, GOSI, advances, provisions) and
//     reverseJournal; each behind its own HR workflow, two-person controls and the payroll lock.
//   MANUAL / generic (blocked): src/lib/accounting/journal-service.ts — createManualJournalEntry,
//     submitJournalEntry, approveJournalEntry, postJournalEntry, reverseJournalEntry
//     (POST /api/accounting/journals, PATCH …/:id/{submit,approve,post,reverse}).
//   No other module writes the ledger: sales, purchasing, inventory and finance (bank statements, cash
//   budgets) post no journal; accounting events are an outbox only (emitAccountingEvent); fiscal-period
//   lock / close, chart of accounts, tax categories and the Qoyod export write no journal entry.
// The database refuses the same writes whoever writes them (hr_manual_journal_guard): an entry or line
// not of an allowlisted automatic workflow is never created, changed, posted or deleted while off.
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";

import { MANUAL_JOURNALS_DISABLED, MANUAL_JOURNALS_DISABLED_AR, MANUAL_JOURNALS_DISABLED_EN } from "./manual-journals-messages";
export { MANUAL_JOURNALS_DISABLED, MANUAL_JOURNALS_DISABLED_AR, MANUAL_JOURNALS_DISABLED_EN };

type SettingsReader = { hrSettings: { findUnique: (a: { where: { id: string }; select: { manualJournalsEnabled: true } }) => Promise<{ manualJournalsEnabled: boolean } | null> } };

/** Read every time (no cache). FAIL-CLOSED: anything but exactly `true` is disabled. */
export async function manualJournalsEnabled(db: SettingsReader = prisma as unknown as SettingsReader): Promise<boolean> {
  try {
    const s = await db.hrSettings.findUnique({ where: { id: "singleton" }, select: { manualJournalsEnabled: true } });
    return s?.manualJournalsEnabled === true;
  } catch {
    return false;
  }
}

/** Refuse a manual-journal action while manual journals are disabled (409 MANUAL_JOURNALS_DISABLED). */
export async function assertManualJournalsEnabled(db?: unknown): Promise<void> {
  if (!(await manualJournalsEnabled(db as SettingsReader | undefined))) {
    throw new AccountingError(MANUAL_JOURNALS_DISABLED_EN, 409, MANUAL_JOURNALS_DISABLED, MANUAL_JOURNALS_DISABLED_AR);
  }
}
