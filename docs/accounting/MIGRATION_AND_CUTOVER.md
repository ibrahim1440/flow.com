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
`20260929120000_accounting_receivables`, `20260930090000_accounting_open_items`,
`20260930120000_accounting_inventory`, `20260930130000_accounting_inventory_sales_location`.
The receivables migration adds columns to the existing `Customer` table (nullable or defaulted).
The open-items migration adds nullable columns and a check to the new `JournalEntryLine` table and
a flag to `ArAllocation`. The inventory migrations create new tables and add nullable settings
columns. None of them changes an existing operational table's data; the inventory tables only
reference operational records by id (`GreenBean`, `CoffeeProduct`, `MaterialItem`, `ProductSKU`,
`RoastingBatch`, `PurchaseRecord`). All of them must still be rehearsed on a fresh copy of production
before any release package is proposed.

`20261001090000_accounting_stage4b` (stage 4b, also local only) differs in one important way: it
adds a **deferred constraint trigger on the existing operational table `InventoryMovement`**
(`InventoryMovement_integration_check`). It never blocks or changes an operational write; it inserts
an `UNINTEGRATED` row into the new `InvOpsEvent` table when a transaction writes a stock movement
without recording an integration event. Every operational route in this branch records one, so on
production the trigger fires only for writers outside this code (scripts, manual SQL). It also adds
enum values (`InvDocType` SUPPLIER_CREDIT, SALE_REVERSAL, ADJUSTMENT; `BillLineKind` STOCK_RETURN,
STOCK_PRICE_ADJUSTMENT), nullable columns on `SalesInvoice`, `SalesInvoiceLine`, `SupplierBill`,
`SupplierBillLine` and the stage 4 tables, and new tables (`InvCosting`, `InvOpsEvent`,
`InvCostPool`, `CustomerReturn`, `CustomerReturnLine`, `ApCreditAllocation`). Rehearsal must
include: applying it to a production copy with live-sized `InventoryMovement`, then exercising a
purchase, a roast, a pack and a dispatch through the routes to confirm the operational timings are
unchanged and no UNINTEGRATED rows appear. Historical operational stock is **not** back-filled into
the accounts: opening balances are a cutover decision (DECISION_PACK §6).

**Stage 5 and 6 migrations (local only, not rehearsed on a production copy):**
`20261002090000_accounting_fixed_assets_year_end` creates the fixed-asset and year-end tables and
**replaces the journal-entry guard function** `acc_guard_journal_entry` so that a `CLOSING` entry may
post into a `LOCKED` period (and only a CLOSING entry). `20261003090000_accounting_einvoicing_local`
adds nullable columns to the existing `SalesInvoice` (`debitNoteOfId`) and `Customer`
(`nationalAddress`) tables and creates the e-invoicing tables and guards.
`20261003091000_accounting_tax_exemption_codes` adds two nullable columns to `TaxCategory`. None
changes existing rows. The guard replacement must be part of the production-copy rehearsal: the
function body on the copy must equal the file's, and ordinary postings into a locked period must
still be refused.

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

## Rehearsal of all twelve migrations (2026-10-01)

### Local rehearsal on main's schema and seed — done

`scripts/accounting/local-migration-rehearsal.sh`; evidence in `evidence/rehearsal/local-rehearsal-031daaf.txt`.

1. `main` (`fc64c05`) built a fresh disposable database: 29 migrations plus `main`'s own seed (synthetic).
2. All 92 pre-existing tables were fingerprinted (249 rows).
3. The branch's twelve migrations were applied with `prisma migrate deploy`: 1.8 s, 41 migrations in total.
4. **All 92 tables were byte-identical over their original columns afterwards.**

This shows the migrations apply cleanly on production's schema shape. It does **not** cover:
- production's data volume;
- PostgreSQL 17 / Neon;
- timing under load.

### Production-copy rehearsal — plan, awaiting authorisation

**Status: not run.** It needs a fresh copy of the live branch `br-weathered-bread-aqais7hp`
(`ep-dawn-dust`). Project `dark-lab-61530722` already has 10 branches. The 2026-09-27
ledger-core rehearsal branch (`br-billowing-fire-aq5eyiku`) no longer exists. Creating a new branch,
or reusing an existing one, needs the owner's decision: the plan's branch limits and cost, and which
existing branch may be used or removed.

1. **Create the copy.** Create branch `rehearsal-accounting-12-<date>` from `br-weathered-bread-aqais7hp`
   (Neon copy-on-write). Production is not written.
2. **Check the copy is not production.** Confirm through the Neon API that the branch id and endpoint
   differ from `ep-dawn-dust` and are not in the `preview-target.mjs` deny list.
3. **Record the before state.** Read `_prisma_migrations` and expect 29 rows, the latest
   `20260927100000_protect_movement_provenance`. Take row counts and md5 fingerprints of every table,
   using the same queries as the local script.
4. **Apply the migrations.** Run the twelve migrations in order, inside one transaction per migration,
   timing each. Use `prisma migrate deploy` from a machine with TCP access to Neon, or the Neon
   connector with each `migration.sql` verbatim.
5. **Verify the result:**
   - 41 rows in `_prisma_migrations`;
   - every pre-existing table's fingerprint unchanged over its original columns;
   - the trigger count matches the local result (66 non-internal triggers on the fixture schema);
   - `erp_app` privileges are unchanged.
6. **Build against the copy.** Run the new build against the copy as `erp_app`: `/dashboard/accounting`
   shows "set-up not complete" and nothing posts.
7. **Clean up.** Delete the rehearsal branch, or keep it labelled until the release decision.

Input needed: the owner authorises step 1 (branch creation, or a named branch to reuse).

## Backup and restore (2026-10-01)

### Local verification — done

`scripts/accounting/local-backup-restore-check.sh`; evidence in
`evidence/backup-restore/local-backup-restore-031daaf.txt`.

1. `pg_dump` of the fixture database, restored into a fresh disposable database.
2. Compared and found identical:
   - row counts of every table;
   - ledger totals: 251 lines, debits = credits = 4,567,544.30, per-account md5;
   - 66 triggers and 253 functions;
   - the e-invoice chain.
3. The restored copy still refuses changes to posted journal lines and issued e-invoices.

This check is part of the release gates.

### Neon (production) — procedure, not executed

**Restore point before any production step:**
- create a branch from the live branch at the current point in time; this is how the existing
  `backup-pre-*` branches were made;
- record its id;
- verify it with read-only row counts.

**Restore:**
- restore from that branch, or use point-in-time restore within the project's history retention
  (21,600 s = 6 hours on `dark-lab-61530722`, per the Neon project settings read on 2026-10-01);
- after any restore, re-run the credential checks in `CREDENTIAL_INCIDENT.md` §6, because restored
  branches carry the same roles.

**Not yet exercised on Neon.** It needs the owner's authorisation for branch creation, as above.
