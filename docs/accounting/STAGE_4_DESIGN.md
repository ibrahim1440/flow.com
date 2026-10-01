# Stage 4 — inventory valuation and manufacturing costing

Status: **implemented and tested locally on synthetic data** (branch `feature/accounting-ledger-core`
of `ibrahim1440/flow.com`, not pushed; see `TEST_RESULTS.md` for the commit the results are bound
to). Not run on Neon or Vercel. Decision **D-1 is not taken**: it is configurable, and posting is
refused until it is taken. The only exception is provisional posting in an isolated test database.
Nothing here is an approved company policy.

## 1. Scope

Cost accounting for green coffee, roasted coffee, packaging, milk, bakery ingredients, finished
goods and goods for resale:
- purchasing: goods receipt, supplier-bill matching, landed cost, return to supplier;
- units of measure, with conversion to a base unit;
- transfers between locations;
- production: consumption and output, with normal and abnormal loss;
- issues for internal use, calibration, QC, training and spoilage;
- stock counts;
- cost of sales on sales invoices, and customer returns.

Each document produces its journal, and valuation and gross-margin reports agree with the general
ledger.

## 2. Model (migration `20260930120000_accounting_inventory`, `…130000_…_sales_location`)

The cost subledger is owned by accounting and kept in `Decimal`. It sits beside the operational
records (`GreenBean`, `MaterialItem`, `RoastingBatch`, `PurchaseRecord`, `ProductSKU`, all in
`Float`). It links to them but never writes to them.

| Table | Holds |
|---|---|
| `InvItem` | code, kind (8 kinds), base unit, yield weight per unit, optional unique link to one operational record |
| `InvUnit` | other units and their factor to the base unit |
| `InvLocation` | locations; one is the sales location (partial unique index) |
| `InvLossBand` | maximum normal-loss % per process (DRAFT → APPROVED by someone else → RETIRED; never edited once approved) |
| `InvDocument` / `InvDocLine` | the documents below: DRAFT → SUBMITTED → APPROVED (four-eyes) → POSTED; snapshots of cost method, price-difference treatment and band % taken at posting |
| `InvMove` | posted cost moves (IN, OUT, REVALUE, EXPENSED): the only source of valuation and journals; immutable |
| `InvLayer` | cost layers (quantity and value left) consumed by FIFO or weighted average |

Database guards, which are triggers and so also bind the runtime role:
- posted documents, their lines and their moves cannot change;
- moves can be written only while their document posts, and not after `movesSealed`;
- a layer must equal its moves at commit (deferred constraint trigger `InvLayer_equals_moves`);
- four-eyes applies on documents and on loss bands;
- an approved loss band cannot change.

## 3. Documents and journals

Accounts are resolved by role (`coa-template.ts`):

| Role | Account |
|---|---|
| INVENTORY_RAW | 1171 |
| INVENTORY_PACKAGING | 1172 |
| INVENTORY_WIP (roasted coffee) | 1173 |
| INVENTORY_FINISHED | 1174 |
| INVENTORY_RESALE | 1175 |
| GRNI | 2120 |
| COGS | 5100 |
| ABNORMAL_LOSS | 5300 |
| WASTE_CALIBRATION | 5400 |
| WASTE_QC | 5500 |
| WASTE_TRAINING | 5600 |
| INVENTORY_VARIANCE | 5700 |

Each posted document emits one outbox event, `inv.document.posted` (key
`inventory:<id>:inv.document.posted`), and exactly one journal. The journal is built only from the
document's sealed moves (`translators/inventory.ts`) under policy `inventory.costing`.

| Document | Journal |
|---|---|
| RECEIPT | Dr inventory (by item kind) / Cr GRNI, at receipt cost |
| BILL_MATCH | Price difference between the bill line and the receipt. CAPITALISE: the share still on hand goes to inventory and the consumed share to COGS. EXPENSE: all of it goes to INVENTORY_VARIANCE. Cr/Dr GRNI |
| LANDED_COST | The amount is spread over the receipts by value or quantity. The share on hand goes to inventory, the consumed share to COGS / Cr GRNI (from a bill line, or awaiting the bill) |
| SUPPLIER_RETURN | Dr GRNI / Cr inventory; waits in GRNI for the supplier's credit note |
| ISSUE | Dr COGS (internal use), 5400 calibration, 5500 QC, 5600 training or 5700 spoilage / Cr inventory |
| TRANSFER | No journal when both locations use the same account (event SKIPPED); moves keep the cost |
| PRODUCTION | Dr output inventory · Dr ABNORMAL_LOSS / Cr input inventory (§4) |
| SALE_ISSUE | Dr COGS / Cr inventory. Created and posted by the system when a sales invoice posts: one per invoice (unique source), and a retry finds the existing one |
| CUSTOMER_RETURN | Dr inventory / Cr COGS at the cost the goods left at. The system creates one when an invoice is reversed, for the quantity not already returned |
| COUNT | Difference between counted and book quantity, at current cost → Dr/Cr INVENTORY_VARIANCE |

Posting (`postInvDoc`):
1. It takes advisory locks per item-location in a fixed order.
2. It refuses a document dated before any posted move of the same item and location. No
   back-dating means no silent revaluation of costs already issued.
3. It refuses negative stock.
4. The status change is single-winner. A double click or a racing post gives one posting and a 409.
5. Moves are written, then sealed.
6. The journal is processed.

`createInvDoc` is idempotent on `requestKey`.

## 4. Production and loss (D-1)

Yield is counted in kilograms: `baseQty × yieldPerUnit` for green coffee, roasted coffee, milk,
bakery ingredients and outputs. Packaging does not count toward yield: it is charged in full to the
outputs.

- Expected yield = yield in × (100 − band %) / 100.
- Loss within the band is normal and absorbed into the output cost.
- Output below the expected yield is abnormal. It is valued at the expected output unit cost,
  `yield-bearing input value × abnormal kg / expected kg`, and charged to 5300.
- With several outputs, cost is spread by yield weight.

Worked example (the DECISION_PACK §3 case, and `inventory.test.ts`): 60 kg green costing 1,920.00,
47 kg roasted out, band 18%.
- Expected yield is 49.2 kg; abnormal loss is 2.2 kg.
- 1,920 × 2.2 / 49.2 = 85.85 goes to 5300.
- The roasted coffee is valued at 1,834.15.

A production that loses weight needs an **approved** band. A draft band is refused, except
provisionally in an isolated test database.

Labour and overhead are **not** absorbed; production cost is materials only (§7).

## 5. D-1 is configurable and approval-gated

`AccountingSettings.inventoryCostMethod` (WEIGHTED_AVERAGE | FIFO | null) and
`inventoryPriceDifference` (CAPITALISE | EXPENSE | null) are set by `settings_manage` (ACC-46).
They cannot change after the first inventory document posts. Loss bands are proposed by
`inv_master_manage` and approved by someone else holding `inv_doc_approve`.

**If D-1 is undecided, the costing policy is not approved, or the band is a draft, posting is
refused with the reason.** The exception is an isolated test database
(`ACCOUNTING_PROVISIONAL_POSTING=isolated-test` plus the disposable-database marker). There the
document posts with the weighted-average and capitalise fallbacks, `provisional = true`, and a
provisional journal, as for the earlier stages.

The loss bands used in tests and in the fixture (roasting 18%, packing 1%, baking 5%, a draft dark
roast 20%) and the milk yield are **synthetic test assumptions**, named `*-SYN`. They are not a
proposal and not company policy.

## 6. Reports (ACC-40, 44, 45)

All reports read posted moves and the posted ledger by date. None reads today's status in place of
an accounting date.

| Report | What it shows |
|---|---|
| Valuation as of a date, per item and location | Tied to 1171–1175 per account, with an explanation of documents whose journal is waiting |
| Stock card | Opening balance, one row per document line and direction, closing balance |
| GRNI as of a date | Open receipts − bills without receipt + landed costs awaiting a bill − returns awaiting credit = account 2120 |
| Gross margin per invoice | Revenue from the dates of the invoice's posted and reversal journals; COGS from moves |
| Operational agreement | Accounting quantity vs operational quantity, for information only |

For GRNI, a bill counts on a date when its posted journal is dated on or before it and its
reversal journal, if any, after it. The regression test is red on `fde4632` and green after
(`evidence/test-runs/grni-history-before-fix.txt`).

## 7. Known limitations

- **Production cost is materials only.** There is no labour or overhead absorption and no standard
  costing or variances.
- **Price differences and landed cost on stock no longer on hand go to COGS (5100)** even when that
  stock went into WIP or finished goods still on hand. This is a simplification. Tracing through
  production would be exact.
- **No back-dating.** A document dated before a posted move of the same item and location is
  refused rather than revaluing later issues. A late receipt is entered at a current date.
- **Supplier credit notes are not implemented.** A return to supplier stays in GRNI, listed as
  awaiting the credit.
- **Transfers are immediate.** There is no in-transit stock. Inventory accounts are per item kind,
  not per location, so a transfer never has a ledger effect; per-location accounts are not
  supported.
- **Cost of sales covers only some invoice lines.** It is taken only for invoice lines that name a
  `ProductSKU` linked to an inventory item, and only from the one sales location. Credit notes do
  not move stock: a customer return document is entered for returned goods. An invoice reversal
  returns the rest automatically.
- **Weighted average is implemented as proportional consumption across the open layers.** Each
  issue takes the same share of every layer. Rounding to 0.0001 qty and 0.01 SAR is bounded per
  layer; a property test of 3,000 random sequences shows value is conserved.
- **Operational records are not updated.** The agreement report shows differences; reconciling
  them is an operational task.
- **Sales-invoice COGS posts after the invoice.** It uses a separate transaction and journal. If it
  fails (for example, not enough stock), the invoice stays posted, the cost-of-sales document stays
  APPROVED, and the outcome carries the reason. Calling `saleIssueForInvoice` again posts that same
  document; there is no automatic retry and no screen for it yet.
- **Neither of the two new migrations has been rehearsed on a production copy**
  (`MIGRATION_AND_CUTOVER.md`).
- **UI differences from Figma page 20:** `FIGMA_PARITY.md`.
