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
