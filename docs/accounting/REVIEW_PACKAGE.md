# Independent technical review — package

**Status: prepared, NOT reviewed.** No independent review has taken place. This document gives a
reviewer what they need; it is not a review and records no approval. The implementer's own tests
(`TEST_RESULTS.md`) are not a substitute for it.

## 1. What to review

- **Repository:** [ibrahim1440/flow.com](https://github.com/ibrahim1440/flow.com)
- **Branch:** `feature/accounting-ledger-core`
- **Base:** `main` @ `fc64c05`
- **Scope:** the accounting module, stages 1–6:
  - ledger, payables, banking, cash flow, receivables, inventory and manufacturing costing;
  - fixed assets and year-end close;
  - e-invoicing (local only) and the VAT return.
- **Size:**

  ```
  git diff --stat fc64c05 HEAD -- src prisma
  ```

- **Migrations:** twelve, all additive, listed in `REQUIREMENTS_MATRIX.md` → "Migration rehearsal".
  One of them replaces the journal-entry guard function, and one adds a trigger on the operational
  `InventoryMovement` table.

## 2. Highest-risk areas (suggested order)

| # | Area | Files | What to look for |
|---|---|---|---|
| 1 | Database guards (immutability, four-eyes, period locks, CLOSING entries) | `prisma/migrations/*accounting*/migration.sql` | whether a runtime role can bypass a trigger; `SECURITY DEFINER` use; guards that can be disabled; what happens when a trigger function is replaced |
| 2 | Posting engine and event pipeline | `src/lib/accounting/posting.ts`, `event-processor.ts`, `translators/*` | exactly-once posting under retries and concurrency; the policy gate; provisional postings only in isolated tests |
| 3 | Money and rounding | `src/lib/accounting/money.ts`, `fa-depreciation.ts`, `inventory-service.ts` | Decimal everywhere; cumulative-target depreciation; layer costing; late-dated documents (defect 39) |
| 4 | Authorisation | `src/lib/accounting/http.ts`, `duties`, every `src/app/api/accounting/**/route.ts` | each write route checks a duty; preparer ≠ approver enforced server-side |
| 5 | Operational integration | `src/lib/accounting/ops-integration.ts`, operational routes touched | events written in the same transaction as the operational change; the UNINTEGRATED trigger |
| 6 | E-invoice document | `src/lib/accounting/einvoice/*` | canonical hash input; QR TLV parsing (strict); local test signature clearly not a ZATCA stamp; production submission refused |
| 7 | SDK harness | `scripts/accounting/zatca-sdk/*` | gate logic (exit codes), archive checks, container isolation flags, output-profile confirmation; that no result can come from anything but this run's runner (run ID, input checksum, fresh directories — defect 48) |
| 8 | Scripts that write to databases | `scripts/accounting/*.sh`, `scripts/finance/local-db-guard.mjs`, `scripts/accounting/preview-target.mjs` | every write is guarded to local disposable databases or the named preview; no secrets printed |

## 3. How to reproduce the evidence

```
npm ci
bash scripts/accounting/local-release-gates.sh
```

This needs a local PostgreSQL 16 on port 54329 and `.env` (see `OPERATIONS_GUIDE.md`). It writes
`docs/accounting/evidence/test-runs/<sha>-*`.

Other checks:

```
bash scripts/accounting/local-migration-rehearsal.sh <out>
bash scripts/accounting/local-backup-restore-check.sh <out>
bash scripts/accounting/zatca-matrix.sh <out>
bash scripts/accounting/zatca-secondary-check.sh <matrix> <sdkDataDir> <toolsDir> <out>
node scripts/accounting/zatca-sdk/harness.mjs --matrix <matrix> --out <out> [--archive … --sha256 … --source-url …]
```

## 4. Known limitations the reviewer should not have to rediscover

The implementation is **not complete**; green tests do not mean otherwise. These are in
`DEFECTS_AND_LIMITATIONS.md` and `ZATCA_SDK_VALIDATION.md`:
- XAdES signing is not implemented (simplified documents carry a local test signature only; QR tag 9
  absent);
- local rules are not mapped to the official BR-KSA codes;
- official SDK validation has not run;
- QR tags 6–8 follow the official documents as cited and are unconfirmed;
- only a local rehearsal of the migrations has run; a production copy has not been used;
- VAT return items not modelled;
- zakat absent.

## 5. Recording the review

The reviewer records findings as GitHub review comments on a pull request from this branch, or in a
file they sign. The implementer does not mark this gate complete.
