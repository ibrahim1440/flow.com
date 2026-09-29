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
| 17 | Cash-flow attribution of a past month changed when a payment was later voided or replaced: the investing/operating split was read from the bank line's **current** active bill matches, which a void deactivates | attribution from live match rows | each AP/AR control line records its open item at posting (immutable; mirrors copy it); attribution reads the bill from the posted line | `cashflow-history.test.ts` (3: asset bill paid in January and voided in February; partial payments; void and replace) — red before the fix, `evidence/test-runs/cashflow-history-before-fix.txt` |
| 18 | AR/AP aging and customer/supplier statements for a past date used documents' **current** status (and audit timestamps), so a later reversal, void or reallocation rewrote earlier periods and the subledger no longer agreed with the GL at that cutoff | reports read document tables | aging and statements read the posted ledger lines by entry date and open item; credit-note reallocation now posts a net-zero reclass (`ar.credit.allocated` / `released`) | `subledger-history.test.ts` (2: receivables and payables, GL agreement at each cutoff before and after later reversals) — red before the fix, `evidence/test-runs/subledger-history-before-fix.txt` |
| 19 | GRNI explanation and gross margin for a past date used the supplier bill's current status and the invoice's reversal timestamp (same class as 18, found in the stage 4 audit) | status filter | bills and invoices count by the entry dates of their posted and reversal journals | `inventory.test.ts` "historical GRNI" — red on `fde4632`, `evidence/test-runs/grni-history-before-fix.txt`; February margin unchanged after a later reversal |
| 20 | An invoice line for a product with no inventory item was skipped silently; the invoice showed no cost of sales and the margin looked complete | lines without a mapping were ignored | explicit GOODS / NON_STOCK classification; unmapped goods lines BLOCK costing with the reason; the margin marks the invoice incomplete | `stage4-gaps.test.ts` (failing first) |
| 21 | Not enough stock at posting: the cost of sales was lost with no record | costing was attempted once, inline at posting; a failure left no durable record to retry | durable `InvCosting` (DB trigger), retries with back-off, exception queue, late booking with the original date kept | `stage4-gaps.test.ts`, `stage4b-workflows.test.ts` B |
| 22 | Reversing an invoice restored stock automatically, as if the goods had come back | `returnForReversedInvoice` | reversal moves the cost to "delivered, not invoiced"; goods come back only through a received, approved customer return | `stage4-gaps.test.ts` (failing first), `stage4b-workflows.test.ts` A |
| 23 | Gross margin omitted credit notes and could not be tied to the ledger | per-invoice COGS only | all receivables revenue, costing status per row, reconciliation to revenue, 4900 and 5100 with every difference explained | `stage4-gaps.test.ts` |
| 24 | A landed cost or price difference on green coffee already roasted went to COGS | consumed share expensed | traced through production, transfers, sales and waste | `stage4-gaps.test.ts`, chain test |
| 25 | A cost layer changed twice in one transaction failed the deferred layer check (found while re-deriving the chain test) | the check compared the row version of each change, not the current row | the check reads the current row | chain test (`evidence/test-runs/stage4b-layer-check-before-fix.txt`) |
| 27 | The HTTP request parsers dropped the stage 4b invoice, credit-note and supplier credit-note fields, so those features were unreachable over HTTP (found by the UI work) | parsers whitelisted the stage 3 fields only | parsers pass the new fields; bill list carries `kind` | `ops-integration.test.mjs` (credit notes over HTTP; a credit note without a type is refused) |
| 28 | A QC-rejected batch's roasted coffee stayed in the accounts | QC rejection writes no stock movement | QC rejection (terminal) writes the remaining roasted coffee off as QC waste, once per batch | `ops-integration.test.ts` test 3, `ops-integration.test.mjs` |
| 26 | Operational stock changes (purchase, roast, pack, dispatch, counts) never reached the accounts except through manual drafts | no integration | operational events in the same transaction, automatic documents under an approved policy, UNINTEGRATED detection, exception queue, reconciliation | `ops-integration.test.ts` (3), `ops-integration.test.mjs` (HTTP) |

## Pre-existing (reproduced identically on `main` @ `fc64c05`)
All three now have a reproducible passing setup (`scripts/e2e/regression/local-certification.mjs`,
`REGRESSION_SIDE_BY_SIDE.md`); the h2a seed issue was fixed in `prisma/seed.ts`:
- `h2a-hardening`: "no roast lost its provenance" counts roasts without a bean created in the last
  20 minutes across the whole DB → 44 on a freshly seeded DB (the seed itself creates such rows).
- `harness-selftest`: two checks expect an unconfigured environment; a local `.env` satisfies it.
- `reset-safety`: 8 checks need the reset-authorisation variable on the test server.

## Limitations (known, not defects)
- Implemented (locally, synthetic data): the ledger core, commission posting, payables, bank-to-ledger
  with posted-line corrections, the cash-flow statement, sales invoices/receivables (stage 3), and
  inventory valuation, manufacturing costing with approved conversion pools, durable COGS and the
  operational integration (stages 4 and 4b, D-1 configurable and refused until decided). **Not**
  implemented: fixed-asset register
  and depreciation runs (depreciation is by manual journal), year-end close, ZATCA (see
  `REQUIREMENTS_MATRIX.md`). The accounting system as a whole is **not complete** and **not
  ZATCA-compliant**. Stages 2 and 3 are **not accepted**; they await the owner's review.
- Stage 3 limitations: `STAGE_3_DESIGN.md` §7 (single returns account, credit notes move no stock,
  credit limit warns only, D-2 changes apply forward only). The historical-aging limitation is
  resolved (defect 18).
- Stage 4 limitations: `STAGE_4_DESIGN.md` §7, as revised by stage 4b (`STAGE_4B_DESIGN.md` §10):
  labour/overhead absorption, tracing of later cost changes, supplier credit notes, invoice units and
  fulfilment location are now implemented; still open are one accounting location for operational
  stock, kilogram lots from the old packing path, re-dating after a roast's date is edited, no in-transit transfers, and migrations not rehearsed on a production copy.
- Open items on ledger lines start with the `20260930090000_accounting_open_items` migration. The
  branch has no journals from before it, but a database that posted receivables/payables journals
  under an earlier build of this branch would need them re-derived; production has none.
- POS and payment-gateway settlements are journalised manually.
- Bill and invoice attachments are not implemented.
- Local tests use PostgreSQL 16; production is 17 (the rehearsal ran on 17).
- `scripts/accounting/seed-local-fixture.ts` takes ~5 min in this sandbox (waiting, not CPU); cause not investigated.
- Period "locked by" shows no name in the app; GL shows one view at a time.
