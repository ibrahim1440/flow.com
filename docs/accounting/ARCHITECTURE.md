# Architecture decisions

**ADR-01 — Extend the existing Accounting S0 models; one general ledger.** `JournalEntry` /
`JournalEntryLine` stay the only ledger. Finance cash records, commission ledgers and future
subledgers post *into* it; nothing else is a ledger. Masters are reused: branches and cost centres
are Finance's `FinBranch` / `FinCostCenter`; the audit trail is Finance's append-only `FinAuditLog`
(entity types `accounting.*`).

**ADR-02 — Rules live in the database as well as the service.** Postgres triggers (migration
`20260928090000_accounting_ledger_core`) enforce: posted entries and their lines immutable; only
drafts deletable; balance, ≥2 lines and postable leaf accounts checked at commit (deferred
constraint trigger); posting only into an OPEN period and within its dates; approver ≠ preparer for
manual/adjustment/opening/reversal entries; forward-only period status (CLOSED final); no period
overlap (exclusion constraint); an account with postings keeps its type and cannot become a
parent; accounting events cannot be deleted or rewritten, and are final once posted; policy and
commission-plan accounting approval are four-eyes and one-way. The services check the same rules
first so users get a clear message; the triggers make the rules hold for any writer.

**ADR-03 — Outbox by trigger for commissions.** An `AFTER INSERT` trigger on
`CommissionLedgerEntry` writes one `AccountingEvent` in the same transaction, whichever code path
wrote the movement. No commission code was changed, so no calculation rule could change.

**ADR-04 — Exactly-once posting.** `JournalEntry.originEventId` is unique; the processor locks the
event `FOR UPDATE SKIP LOCKED`; translation, entry and event status are one transaction; a crash
leaves the event PENDING with no entry. Events for one party post in order (a blocked earlier event
holds later ones), so a payable cannot go negative because of ordering.

**ADR-05 — Posting gate on approved policy.** An automatic posting needs the APPROVED version of
its policy and anything the translator names (e.g. the commission plan version approved for
accounting). Otherwise the event is BLOCKED with the reason. In an *isolated test database* it may
post **provisionally** instead — only when the operator sets `ACCOUNTING_PROVISIONAL_POSTING=
isolated-test` *and* the database carries the `hiqbah-finance-disposable` marker; a trigger refuses
provisional entries anywhere else (proved on the production copy).

**ADR-06 — Roles, not account codes.** Translators ask for roles (`COMMISSION_EXPENSE`, …);
`AccountMapping` says which account plays each. An unmapped role blocks, never guesses.

**ADR-07 — Cutover.** Events dated before `AccountingSettings.ledgerCutoverDate` are SKIPPED (the
opening balance carries them). With no cutover set, automatic events stay PENDING. The date cannot
change after the first automatic posting.

**ADR-08 — Corrections.** Manual entries are corrected by a reversal that is itself submitted and
approved by someone else. Automatic entries cannot be reversed by hand; they are corrected in the
source module, which posts its own entry (e.g. a commission reversal or adjustment).

**ADR-09 — Money and dates.** Decimal(18,2) in the database; `Prisma.Decimal` in services; integer
halalas only at the display boundary; half-up rounding applied once, where an amount is created.
Accounting dates are Riyadh calendar days stored at UTC midnight.

**ADR-10 — UI.** Screens reuse the Finance UI kit and typography (same cards, tables, badges, states)
so Accounting reads as part of the same product; the Figma page "17 — Accounting · General Ledger"
was built from the Finance shell (see `FIGMA_PARITY.md`).
