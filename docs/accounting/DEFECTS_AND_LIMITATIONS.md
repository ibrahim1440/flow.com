# Defects and limitations

## Found and fixed during this work
| # | Defect | Root cause | Fix | Regression test |
|---|---|---|---|---|
| 1 | Reversal left the original entry POSTED (S0) | `reverseJournalEntry` never flipped the original | posting a REVERSAL flips the original to REVERSED; DB allows POSTED→REVERSED only with a posted reversal | reversal test |
| 2 | Reversal posted by one person, no approval (S0) | immediate POSTED insert | reversal is a submitted request, approved by someone else | reversal test |
| 3 | No four-eyes on journals (S0) | none | service + trigger | journal + guard tests |
| 4 | Concurrent approve/post could both succeed (S0) | read-then-write | conditional updates | concurrency test |
| 5 | Account parent could form a cycle (S0 PATCH) | no check | account service | covered by service; UI |
| 6 | English engine text / reasons in the Arabic UI | stored canonical English | display mapping for known phrases/reasons | visual capture |
| 7 | Mobile approval hid amounts | table scrolled inside card | stacked lines under `sm` | visual capture ACC-11 |
| 8 | Negative amounts shown as `600.00-` in RTL | raw decimal string | bracketed negatives | visual capture ACC-09 |
| 9 | Figma cards fixed at 10 px; ACC-04 table clipped | `resize()` fixed sizing; widths > card | hug + corrected widths | re-screenshotted |

| 10 | Reconciliation listed a transfer's receiving leg as not posted | only the paying leg carries the event | the receiving leg counts as posted through its peer | `stage2.test.ts` transfer case; HTTP ACC-TILL = 0.00 |
| 11 | Secondary text on the cash-flow view used a background colour token (`text-muted`, #F3F4F6) | wrong token | `text-muted-foreground` | found in review before commit |
| 12 | Cash-flow statement could report fictitious operating/investing/financing flows for non-cash transactions (asset on credit, loan-financed asset) and still show "reconciled" | classes applied to balance movements, not to cash-bearing entries | transaction-aware engine: cash allocated per entry; non-cash transactions disclosed separately; reconciled requires direct = indirect | `cashflow-transactions.test.ts` (6, failing output before the fix kept in `evidence/test-runs/`) |
| 13 | A posted bank line could be edited in Finance (amount, splits, matches, transfer link) without the ledger following | only confirm/void emitted events | frozen after posting (service + DB triggers); approved void/replace correction workflow | `bank-corrections.test.ts` (8), `bank-corrections.test.mjs` (3) |
| 14 | AP aging "as of" a past date used today's matches; overpaid suppliers were dropped | matches read without dates | matches counted from their date; overpaid balances listed | `bank-corrections.test.ts` supplier case |
| 15 | Sales invoice list counted paid invoices past due as "overdue", and showed an invoice as paid while its receipt had not posted (the aging disagreed) | count by due date only; all active allocations counted | overdue = unpaid past due; "open" counts receipts once their bank line has posted, with the awaiting part shown | found in Stage 3 visual review; list/aging agree in the captures |
| 16 | Two bank lines claiming one sales collection at the same moment: the loser got a generic "record already exists" message | race reached the unique index | the collection row is locked before the check | `receivables-workflow.test.mjs` (concurrent claim, run 3×) |

## Pre-existing (reproduced identically on `main` @ `fc64c05`)
All three now have a reproducible passing setup (`scripts/e2e/regression/local-certification.mjs`,
`REGRESSION_SIDE_BY_SIDE.md`); the h2a seed issue was fixed in `prisma/seed.ts`:
- `h2a-hardening`: "no roast lost its provenance" counts roasts without a bean created in the last
  20 minutes across the whole DB → 44 on a freshly seeded DB (the seed itself creates such rows).
- `harness-selftest`: two checks expect an unconfigured environment; a local `.env` satisfies it.
- `reset-safety`: 8 checks need the reset-authorisation variable on the test server.

## Limitations (known, not defects)
- Implemented (locally, synthetic data): the ledger core, commission posting, payables, bank-to-ledger
  with posted-line corrections, the cash-flow statement, and sales invoices/receivables (stage 3).
  **Not** implemented: inventory valuation and COGS (D-1), manufacturing costing, fixed-asset
  register and depreciation runs (depreciation is by manual journal), year-end close, ZATCA
  (see `REQUIREMENTS_MATRIX.md`). The accounting system as a whole is **not complete** and **not
  ZATCA-compliant**.
- Stage 3 limitations: `STAGE_3_DESIGN.md` §7 (aging of later-reversed invoices, single returns
  account, no COGS, credit limit warns only, D-2 changes apply forward only).
- POS and payment-gateway settlements are journalised manually.
- Bill and invoice attachments are not implemented.
- Local tests use PostgreSQL 16; production is 17 (the rehearsal ran on 17).
- `scripts/accounting/seed-local-fixture.ts` takes ~5 min in this sandbox (waiting, not CPU); cause not investigated.
- Period "locked by" shows no name in the app; GL shows one view at a time.
