# Migration, rehearsal, cutover and recovery

## The migration
`prisma/migrations/20260928090000_accounting_ledger_core` — **additive only**: 3 new enums, 2 enum
values, new columns with defaults on 6 existing tables, 2 new tables, indexes, 3 foreign keys,
11 functions, 9 triggers, `btree_gist` extension, 1 exclusion constraint, 1 partial unique index.
No column dropped, renamed or retyped. The build currently in production keeps working on the new
schema (new columns have defaults; new triggers only affect tables that production does not write,
except the commission outbox, which only *adds* an `AccountingEvent` row per commission movement).

## Rehearsal on a copy of production (2026-09-27, 15:02–15:25 UTC)
Target: Neon `dark-lab-61530722` / branch `rehearsal-accounting-ledger-core-20260927`
(`br-billowing-fire-aq5eyiku`, endpoint `ep-noisy-night-aq3qczk4`), a copy of the live branch
`br-weathered-bread-aqais7hp` (`ep-dawn-dust`). Production itself was not written.

| Check | Result |
|---|---|
| Before: applied migrations | 29, latest `20260927100000_protect_movement_provenance` (= `main`) |
| Before: accounting rows | Account 0, FiscalPeriod 0, JournalEntry 0, AccountingEvent 0, CommissionLedgerEntry 0, CommissionPlanVersion 0 — nothing to backfill, no overlap to violate the new constraint |
| `btree_gist` available | yes |
| Apply | 2 enum values, then 43 statements + the `_prisma_migrations` record (sha256 `7bbbe191…34a3`) in **one transaction** via the Neon connector (the sandbox has no TCP/HTTPS egress to Neon, so `prisma migrate deploy` could not run from here) |
| Function bodies on the branch vs the file | 11/11 identical (md5 per function) |
| Triggers attached | 9/9 |
| After: migrations | 30; Orders 11, RoastingBatch 21, Employee 18 unchanged |
| `erp_app` on new tables | INSERT/UPDATE yes; TRUNCATE/TRIGGER no (default privileges work) |
| Provisional posting on a production copy | refused by the trigger; transaction rolled back (0 periods, 0 entries after) |

Not rehearsed there: the new application build serving the copy as `erp_app` (needs a Preview on
that branch — blocked, see `RELEASE_PROPOSAL.md`).

**Later migrations not yet rehearsed on a production copy** (applied and tested only on the local
disposable PostgreSQL 16 databases): `20260928120000_accounting_payables_bank`,
`20260928130000_accounting_cash_flow_class`, `20260929090000_accounting_bank_corrections`,
`20260929120000_accounting_receivables`. The receivables migration adds columns to the existing
`Customer` table (nullable or defaulted) and triggers on new tables only; it must still be rehearsed
on a fresh copy of production before any release package is proposed.

## Cutover (proposal — dates and figures are the business's decision, see POLICIES D-4)
1. Accountant approves the chart (template adapted), creates the fiscal year, maps roles.
2. Choose cutover date C. Import the Qoyod trial balance at C−1 as one OPENING entry (four-eyes)
   with AR/AP/stock detail kept outside the ledger until those subledgers exist.
3. Set `ledgerCutoverDate = C`; commission movements before C are SKIPPED (carried by the opening
   balance); approve policy and plan versions; mark set-up complete; run posting.
4. Reconcile: trial balance = Qoyod at C−1; commissions payable = commission ledger outstanding for
   movements on/after C.

## Recovery
- **Before any posting:** roll back the code (redeploy the previous build). The schema is additive;
  the old build ignores it. The outbox trigger keeps adding `AccountingEvent` rows — harmless.
- **After postings:** reverting code does **not** reverse financial data. Correct with reversals /
  source-module corrections; never delete (the triggers refuse it anyway).
- **Roll forward** is the default for defects: fix, redeploy, re-run the processor (idempotent).
- **Backup:** take a Neon branch of the live branch immediately before the production migration
  (as was done for the finance release); it is the restore point.
