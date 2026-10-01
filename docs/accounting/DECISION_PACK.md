# Accountant decision pack

For: BeanFlow's accountant and owner. Purpose: the decisions that gate **production activation** of
the accounting module. Implementation and isolated testing continue meanwhile; each decision is a
configuration or approval step, not new code. All figures are synthetic, in SAR. VAT is shown at the
KSA standard rate of 15%.

**Cutover date: deliberately undecided.** It is fixed only when the readiness criteria in §6 are met
and the opening balances have been reconciled.

| # | Decision | Recommended option | Blocks in production |
|---|---|---|---|
| 1 | Chart of accounts | Adopt the template with the additions in §1, mapped to Qoyod codes | every posting |
| 2 | Commission recognition and plan versions | Recognise on finance-verified collection (current plans are collection-based); approve plan versions individually | commission journals |
| 3 | Costing and loss policy | Weighted average per item and location; normal-loss band per roast profile taken from BeanFlow's own roasting history; excess loss expensed | stock valuation, COGS, manufacturing |
| 4 | Revenue and COGS timing | At transfer of control: POS/café at sale, B2B at delivery, services when performed | sales invoices, COGS |
| 5 | Advance payments and VAT | Customer advance (liability) plus VAT at receipt, with a prepayment tax invoice; final invoice deducts the advance | customer receipts before delivery |
| 6 | Opening balances | Trial balance at cutover from Qoyod plus open-item subledgers; tie-out to zero before go-live | go-live |
| 7 | Cash-flow classification | Adopt the template defaults in §7 and review each account | the cash-flow statement as a published report |

---

## 1. Chart of accounts

**State.** `src/lib/accounting/coa-template.ts` holds a Saudi SME template with 60 accounts in 6
classes. Control accounts refuse manual journals. It is a proposal, not the company's approved chart.

**Please decide.**
- Accept the structure, or supply the current Qoyod chart to map against.
- Confirm that the fiscal year is the calendar year.
- Confirm the dimensions: branch, cost centre, and party (customer, supplier, employee).

**Recommended additions**, which later stages need:
- goods-in-transit
- landed-cost clearing
- purchase price variance
- accumulated depreciation per asset class (instead of the single 1290)
- gain or loss on asset disposal
- rounding differences
- a normal-loss absorption memo account, if the accountant wants normal loss visible (it is otherwise absorbed into cost)

**Example.** Account 2140 *Commissions payable* is a control account. A manual journal to it is
refused, with the message "post through the commission subledger". This keeps the subledger and the
ledger reconciled by construction.

## 2. Commission policies and plan versions

**State.**
- Policy `commissions.recognition` (bilingual default text in `POLICIES.md`) is a DRAFT.
- Plan versions are PROVISIONAL.
- Production posting is blocked server-side.
- Test postings run only in the isolated database and are labelled provisional (decision D-3).

| Option | When expense and liability are recognised | Fit |
|---|---|---|
| **A (recommended)** | On a finance-verified collection that creates a commission ledger movement | Matches the existing plans' basis (NET_COLLECTION). No clawback estimates needed |
| B | On invoice or delivery, with clawback on non-collection | Needs an estimate of uncollectible commission. Only suits invoice-basis plans |
| C | On payout | Cash basis. Understates liabilities at period end. Not recommended |

**Example (option A, plan v2 at a synthetic 1.5%).**

| Event | Journal |
|---|---|
| Collection of 10,000 verified | Dr 6150 Sales commissions 150.00 / Cr 2140 Commissions payable 150.00 (party: rep) |
| Partial refund of 2,000 | Dr 2140 30.00 / Cr 6150 30.00 (reversal, linked to the source movement) |
| Payout of 120 | Dr 2140 120.00 / Cr 2190 Payments clearing 120.00 |
| Bank payment matched | Dr 2190 120.00 / Cr 1120 Bank 120.00. Cash leaves once |

Each journal records the plan version and the source event. A second posting of the same event is
refused by the database.

**Please decide.**
- Approve (or rewrite) the policy text. The approver must differ from the preparer.
- Approve each plan version for accounting.
- List any existing contractual commission obligations at cutover. They enter as opening balances,
  per rep.

## 3. Costing and loss policy (D-1: "needs accountant review")

**Recommendation.**
- Weighted average cost per item and location, recalculated on each receipt.
- Roasting yield bands per roast profile, set by the accountant from BeanFlow's roasting records. No
  percentage is proposed here.
- Loss inside the band is absorbed into the roasted-coffee cost. Loss beyond the band is expensed to
  5300 *Abnormal roasting loss*.
- Calibration, QC and training waste are issued at average cost to 5400, 5500 and 5600.
- Physical-count differences post to 5700.

**Example (synthetic band, for illustration only: at most 18% loss).**

| Step | Quantity | Value | Unit cost |
|---|---|---|---|
| Green stock 100 kg @ 30.00 + receipt 50 kg @ 36.00 | 150 kg | 4,800.00 | **32.00** (weighted) |
| Issue to roast | 60 kg | 1,920.00 | 32.00 |
| Expected minimum yield at band edge: 60 × 82% | 49.2 kg | — | 39.02 |
| Actual yield | 47.0 kg | 1,834.15 → finished goods | 39.02 |
| Abnormal loss 2.2 kg | — | 85.85 → 5300 | 39.02 |

Had the yield been 50 kg (inside the band), all 1,920.00 would be carried at 38.40/kg and nothing
expensed.

**Please decide.**
- the costing method
- the bands per profile, or the rule to derive them
- whether backdated receipts re-value issues already made (recommended: yes, within an open period only)

**Implementation status (stage 4, local only — `STAGE_4_DESIGN.md`).** D-1 is built as settings
that are refused until you set them, not as a decision taken for you:
- `inventoryCostMethod` (weighted average or FIFO) and `inventoryPriceDifference` (capitalise on the
  stock still held, or expense to 5700) are empty by default. Neither can change after the first
  inventory document posts.
- Loss bands are entered per process and approved by someone other than their author; an approved
  band never changes (retire it and approve a new one).
- With either setting empty, the `inventory.costing` policy unapproved, or a draft band, **posting
  is refused with the reason**. Only an isolated test database may post provisionally; such
  journals are marked provisional.
- Back-dating: until you decide, the implementation takes the conservative path and **refuses** a
  document dated before a posted movement of the same item and location. Revaluing earlier issues
  is not implemented.
- Cost of sales timing is a setting (`salesCostTiming`), undecided by default: while undecided,
  posted invoices wait (AWAITING_POLICY) instead of being costed on an assumed date (§4).

## 4. Revenue and COGS timing

**Recommendation** (IFRS 15 transfer of control, as adopted by SOCPA). Revenue and COGS are
recognised together:

| Channel | Revenue and COGS date | Invoice timing |
|---|---|---|
| POS / café / bakery counter | at sale | simplified invoice at sale |
| B2B roasted coffee / resale | at delivery (proof of delivery in BeanFlow) | tax invoice at delivery, or by the 15th of the following month for summary invoices |
| Services (training, maintenance) | when performed | on completion, or per milestone |

Issuing an invoice or collecting cash does not by itself recognise revenue (decision D-2).

**Example.**
- A B2B order is invoiced on 28 September and delivered on 2 October.
- Revenue 10,000 and COGS 6,200 fall in **October**.
- The September invoice posts Dr 1130 / Cr *contract liability* (an account to add in §1) plus Cr 2170
  for the VAT. On delivery, the contract liability is released to 4100.
- The simpler, recommended workflow is to configure invoicing to follow delivery.

**What the system needs from you (stage 4b).** The sales-cost timing setting. Implemented today:
`WITH_REVENUE` (cost of sales dated with the invoice, taken from the goods already dispatched for an
order line, held meanwhile at cost in "goods delivered, not invoiced", 1176). Choose it only if
invoicing follows delivery as recommended above; the contract-liability route for invoices issued
before delivery is not implemented. Until you choose, invoices post their revenue and their cost of
sales waits, visibly.

## 4a. Operational stock events (stage 4b)

Operational screens (purchases, roasting, blending, packing, dispatch, counts) now create inventory
documents automatically from the quantities they record. You decide:

1. **Approve the `inventory.operations` policy** — or not. Approved: documents within tolerance
   (items linked, cost known, loss within the approved band) are approved under the policy and
   posted automatically; everything else waits for an accountant. Not approved: every operational
   document is prepared and waits for an accountant's approval.
2. **Loss bands per process** (§3): roasting, packing, blending (and baking). The system needs one
   approved band per process to post automatically; loss above it is always held.
3. **Opening quantities** entered on operational records (a new green coffee or material created
   with stock) carry no cost. They are held until you define the opening-balance procedure (§6):
   which account the counter-entry uses and who approves the cost.

## 4b. Direct labour and production overhead (stage 4b)

For each process, a pool per kind (direct labour, production overhead) with its basis (kg in, kg
out, units out, batch, labour hours, machine hours), budget and **normal capacity** (IAS 2.13: fixed
overhead is absorbed on normal capacity; unabsorbed overhead is expensed in the period; in a period
of abnormally high production the rate is reduced so inventory is not measured above cost). The
rate is budget ÷ normal capacity. Absorption credits 6190 / 6790 and debits production, so the
actual costs stay in their expense accounts and are not counted twice. You provide: which costs
belong to each pool, the bases, budgets and normal capacities, and how often the rates are
reviewed. None is set; the pools in tests and the fixture end in `-SYN` and are synthetic.

## 5. Advance payments and VAT

**Recommendation.**
- A genuine prepayment received before performance is a **customer advance** (2410).
- VAT on it is due at receipt. The regulatory reference to be confirmed by the accountant is the KSA
  VAT Implementing Regulations on the date of supply for advance payments.
- A prepayment tax invoice is issued at receipt.
- The final invoice deducts the advance, so cash, VAT and revenue are each counted once.

**Example.** The order totals 23,000 including VAT. An advance of 11,500 including VAT is received
on 1 October, and delivery is on 20 October.

| Date | Journal |
|---|---|
| 1 Oct receipt | Dr 1120 Bank 11,500 / Cr 2410 Customer advances 10,000 / Cr 2170 Output VAT 1,500 |
| 20 Oct delivery, final invoice | Dr 2410 10,000 + Dr 1130 Receivables 11,500 / Cr 4100 Revenue 20,000 + Cr 2170 Output VAT 1,500 |
| Later receipt of balance | Dr 1120 11,500 / Cr 1130 11,500 |

Totals: revenue 20,000, VAT 3,000, cash 23,000, each once.

**Legacy collections without an invoice** are not classified as advances automatically. Each one is
checked against delivery records and the existing Qoyod entries, then flagged for review.

**Implemented as a setting (2026-09-28).** Accounting → Receivables → Customer receipts shows a
"VAT on advances (D-2)" selector: *at receipt*, *not at receipt*, or *not decided yet* (the
default). Changing it needs the settings permission and is audited. It applies to receipts assigned
from then on; posted receipts keep the VAT they posted with. Advance postings also need the
`receivables.advances` policy approved (four-eyes). Until both are in place, a receipt that leaves
an advance does not post. When an advance is applied to an invoice, the VAT it carried is released
in proportion (Dr 2410 + Dr 2170 / Cr 1130), so VAT is not counted twice.

**Please decide.**
- confirm the treatment
- the prepayment invoice workflow (issued by BeanFlow or by Qoyod until cutover)
- a review owner for the flagged legacy items

## 6. Opening balances and cutover readiness

**Required at the cutover date**, from Qoyod and supporting records:

1. A trial balance, signed off by the accountant.
2. AR open items per customer and invoice, including customer advances.
3. AP open items per supplier and bill, including GRNI.
4. Inventory quantity and cost per item and location. This must agree to a physical count.
5. The fixed-asset register: cost, accumulated depreciation, method, remaining life.
6. Bank balances with reconciliation statements.
7. The VAT position since the last return.
8. Commissions payable per rep (§2).
9. The zakat provision.

**Method.**
- One OPENING journal (four-eyes) against 3900 *Opening balance equity*.
- Subledger open items loaded against their control accounts.
- Go-live only when every control account equals its subledger total and 3900 nets to zero after
  the trial-balance load.

**Readiness criteria before a date is set:**
- decisions 1–5 approved
- chart mapped to Qoyod
- a UAT period run in parallel with Qoyod and reconciled (same month, same totals)
- the credential incident closed (`CREDENTIAL_INCIDENT.md`)
- the regression failures classified and dispositioned (`TEST_RESULTS.md`)

---

## 7. Cash-flow classification

The cash-flow statement uses the indirect method from the ledger. Each balance-sheet account has
a class: **cash**, **operating**, **investing**, **financing** or **excluded**. The chart
template assigns the defaults below. They are **provisional** until you approve them. Any account
can be changed in the chart of accounts (class selector). An account without a class uses the
default and is marked with * on the statement.

| Accounts | Default class | Why |
|---|---|---|
| 1110, 1120 (cash control) | Cash | These are the cash balances the statement explains |
| 1130–1180 (receivables, VAT, prepayments, inventory, advances) | Operating | Working capital |
| 1210–1230 (fixed assets), 1290 Accumulated depreciation | Investing | Purchase or sale of long-term assets. Depreciation itself is a non-cash expense added back in operating (not a flow on 1290) |
| 2195 Payables for fixed assets | Investing | Paying for an asset bought on credit is an investing outflow when paid, not when bought |
| 2220 Long-term loans | Financing | Loan drawdowns and repayments |
| other 21xx, 22xx liabilities | Operating | Working capital and provisions |
| 3100 Capital and other equity | Financing | Owner funding |
| 3200 Retained earnings, 3900 Opening balance equity | Excluded | Moves only through closing or opening entries. A non-zero movement here is flagged for review |

**How flows are found (changed 2026-09-28).** The statement no longer infers flows from account
balance movements alone, which could report fictitious flows for non-cash transactions (an asset
bought on credit, an asset financed directly by a loan) while still appearing reconciled. It now
works entry by entry:
- Only entries that touch a cash account produce cash flows. The cash in an entry is split across
  the entry's other lines on the opposite side, in proportion to their amounts, and each part takes
  the class of its account.
- In an entry that also has investing (else financing) lines, profit-and-loss lines follow that
  activity (for example, a disposal's gain or loss sits with its proceeds).
- A bank payment matched to a supplier bill takes the class of the bill's lines (a bill for a fixed
  asset → investing for the net, operating for its VAT).
- Entries with no cash line are **non-cash transactions**. Those that acquire investing or
  financing items against liabilities or equity are listed separately as a disclosure (for example,
  "machine 64,000 bought by instalments", "van 118,000 financed by a bank loan").
- Operating cash is computed twice (directly and by the indirect method). The statement shows
  "reconciled" only when both agree, the sections add up to the change in cash and nothing falls in
  an excluded account.

Regression tests with independently worked amounts: `tests/accounting/integration/cashflow-transactions.test.ts`
(6 cases; the failing output before the fix is kept in `evidence/test-runs/cashflow-regression-before-fix.txt`).

Questions for you:
1. Should any loans or owner current accounts be added as **financing** accounts?
2. Should zakat and dividends paid be shown as operating or financing?
3. Is **excluded** right for 3200 and 3900?

Synthetic example (from the automated test): opening cash 100,000; capital 50,000; machine 30,000;
cash sales 20,000; accrued rent 5,000; depreciation 1,000; prepaid rent 2,400. This gives
operating 17,600, investing −30,000, financing 50,000, and a cash change of 37,600.

## 8. Fixed assets and depreciation (stage 5)

Mechanism implemented; every choice below is a setting or an approvable version, refused or held
until decided. Values in the fixture and tests are **synthetic** (`-SYN` codes).

| Decision | Where | Until decided |
|---|---|---|
| Recognition, depreciation and disposal statement | policy `fixed_assets.depreciation` | capitalisation, depreciation and disposal journals are BLOCKED |
| Asset classes and their accounts (cost, accumulated depreciation, expense) | asset classes | no class, no asset |
| Per class: method (straight line / declining balance and factor), useful life, residual %, start convention (in-service month / month after), disposal-month convention, capitalisation threshold | class policy versions, approved by someone else | an asset of a class without an approved version cannot be registered |
| Opening fixed assets at cutover: registered with opening accumulated depreciation and months used, either "already in the ledger" (opening trial balance) or against a counter account | per asset | — |
| Where disposal proceeds are recorded (a clearing account; bank accounts are refused because bank lines post themselves) | per disposal | a sale cannot be submitted without it |
| Rule used for late capitalisation: missed months are caught up in the first run (one line) | built-in, visible on the run | ask if a different treatment is wanted |

## 9. Year-end close (stage 5)

| Decision | Where | Until decided |
|---|---|---|
| Close statement: revenue and expense closed per account, branch and cost centre to retained earnings, dated the last day of the year | policy `closing.year_end` | the closing journal is BLOCKED |
| Retained-earnings account | posting role `RETAINED_EARNINGS` (template: 3200) | — |
| When a year may close: all periods locked, nothing pending, depreciation complete, previous year closed, next year created, year ended | built-in blockers | — |
| Opening balances of the next year | carried forward by the perpetual ledger (no opening entry) | ask if an explicit opening entry is required |

## 10. E-invoicing and VAT (stage 6, local only)

| Decision | Where | Until decided |
|---|---|---|
| Seller legal data, VAT and CR numbers, national address, EGS unit naming | seller profile, approved by someone else | nothing is generated |
| Which customers get standard (B2B) invoices: proposed rule "customer has a VAT number" | built-in rule | confirm or replace |
| Exemption / zero-rating reason code and text per tax category | tax categories | lines of that category fail local validation |
| Customers' national addresses (standard invoices) | customer | their invoices wait, not issued |
| Onboarding: test CSR, compliance CSID, sandbox access; production CSID and key custody | outside this system (owner, IT) | submission stays LOCAL_ONLY |
| VAT return box mapping and the items not modelled (exports, imports, reverse charge, corrections, carried-forward credit) | report | the report says what it does not model |

## Provisional test assumptions (implementation and synthetic tests only)

These are **not** decisions. They let the code be built and tested, and they block production
activation until replaced by your decisions:

- The local fixture approves the commission, `payables.recognition` and `bank.posting` policies in
  the disposable databases.
- Stock lines on supplier bills post to GRNI 2120 (pending D-1).
- The cash-flow classes in §7 are template defaults.
- `receivables.recognition` is approved in the fixture; `receivables.advances` is prepared but
  **not** approved, and the D-2 setting (VAT on advances) is left **undecided**, so a receipt that
  leaves an advance is held in the fixture (the real state until you decide).
- Where a test needs the advance to post, it runs in the isolated test database with provisional
  posting, using "VAT at receipt" (the recommendation in §5) as the fallback. Such journals are
  marked provisional and cannot occur outside that test mode.
- Credit notes debit a single "sales returns and allowances" account (4900) for their net.
- Stage 4: the loss bands used by tests and the local fixture (ROAST-SYN 18%, PACK-SYN 1%, BAKE-SYN
  5%, and a draft DARK-SYN 20%) and the milk yield of 1 kg per litre are **synthetic**. In the
  fixture D-1 stays undecided and `inventory.costing` is prepared but not approved, so its
  documents post provisionally in the disposable database only. The integration tests set weighted
  average / capitalise (and FIFO in one test) inside their own disposable database.
- Stage 4b: tests set the sales-cost timing to `WITH_REVENUE` (one test leaves it undecided) and
  approve `inventory.operations` inside their own disposable database; the fixture leaves both
  undecided, approves one synthetic roasting overhead pool (ROAST-OH-SYN, 0.50 per kg out) and leaves
  a synthetic labour pool (ROAST-LAB-SYN) in draft. The HTTP operational test approves
  `inventory.operations` in the local fixture database as a test step.
