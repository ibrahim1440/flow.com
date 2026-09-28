# Stage 2 — Bank-to-ledger and payables (design)

Status: **implemented on the feature branch and tested locally** (2026-09-27): migration `20260928120000_accounting_payables_bank`, services, API, screens ACC-20..26, and the cash-flow statement (ACC-27, migration `20260928130000_accounting_cash_flow_class`). Not yet run on Neon or Vercel. Production activation is gated
(see §6). Builds on the existing Finance models rather than adding parallel ones: `CashAccount`,
`BankTransaction` (+ splits, matches), `FinObligation`, `Supplier`, `PurchaseRecord`.

## 1. Principles carried over

- **One ledger.** Every ledger movement comes from exactly one source event: `originEventId` is
  unique, so each event produces at most one journal.
- **No cash duplication.** A payment or receipt reaches the ledger **only** through its bank
  transaction. Documents such as bills and payment requests never post cash.
- **Server-side gates.** Posting is gated by policies and by the database triggers of stage 1.
- **Cutover.** Events dated before the ledger cutover are SKIPPED; the opening balances carry them.

## 2. Bank-to-ledger

**Trigger.** A `BankTransaction` becomes eligible when it is `CONFIRMED` **and** `REVIEWED`. An
outbox trigger inserts `bank.transaction.confirmed` (idempotency key = transaction id). A later
`VOID` of a transaction that already posted inserts `bank.transaction.voided`, which posts the
mirror (AUTO reversal).

**Journal.** The cash side is the `CashAccount.glAccountId` of the transaction's cash account. If it
is not mapped, the event is BLOCKED with a reason shown on the automation screen. The counter side
is chosen in this order:

| Case | Counter side |
|---|---|
| Active match to an obligation that belongs to a **posted supplier bill** | 2110 Trade payables, party = supplier |
| Payment before any bill, classified `SUPPLIER_PAYMENT`, matched to a PO obligation | 1180 Supplier advances (new), party = supplier |
| Splits | each split's category → `FinCategory.glAccountId` (new, additive); an unmapped category BLOCKS |
| `feeAmount` present | the fee goes to 6900 Bank fees; the cash side uses the net amount |
| `INTERNAL_TRANSFER` with `transferPeerId` | posted once, from the outflow side: Dr receiving cash GL / Cr paying cash GL. The inflow side is SKIPPED as a duplicate |
| Commission payout | through 2190 Payments clearing, matching the stage-1 payout journal (split category mapped to 2190) |
| Customer receipts (ORDER / SALES_COLLECTION matches) | **BLOCKED until stage 3 (receivables)**, reason "receivables not yet in the ledger". Never guessed as revenue or advance (D-2) |
| Unclassified, or an unmatched and unsplit amount | not eligible (stays in bank review) |

**Reconciliation report** (bank ↔ ledger) per cash account and date:
- statement balance (last completed `BankReconciliation`)
- ledger balance of the mapped GL account
- confirmed-but-unposted transactions, blocked events, and manual journals to the cash GL

The difference must be explained line by line.

## 3. Payables (AP subledger)

**Supplier master (additive).** `vatNumber`, `crNumber`, `address`, `paymentTermsDays`, `active`.
The input-VAT claim on a bill requires the supplier VAT number (warning in draft, refusal at approval).

**`SupplierBill` + `SupplierBillLine`**, with status DRAFT → SUBMITTED → APPROVED → POSTED, plus
REJECTED and REVERSED:
- **Header:** supplier, supplier invoice number (unique per supplier), bill date, due date (from
  terms), branch, currency SAR, attachments via `FinAttachment`, optional link to a `PurchaseRecord`
  or PO obligation.
- **Lines:**
  - target = expense/asset account, **or** a stock purchase (goods received) that posts to 2120
    GRNI until stage 4 values receipts
  - quantity, unit price, net, tax category (15% / zero / exempt / out of scope), VAT
  - Decimal(18,2); lines rounded half-up per line; header totals = Σ lines
- **Four-eyes approval**, exactly as for manual journals (approver ≠ preparer/submitter).
- **Posting** creates event `ap.bill.posted` → journal:
  - Dr each line's account (net)
  - Dr 1160 Input VAT (Σ VAT)
  - Cr 2110 Trade payables (gross), party = supplier
- **The same transaction creates or updates the `FinObligation`** (`sourceType = "SUPPLIER_BILL"`,
  `sourceId = bill.id`, amount = gross), superseding the linked PO obligation. Cash planning keeps
  exactly one liability.
- **Payment** is the bank transaction matched to that obligation (§2): Dr 2110 / Cr Bank. There is no
  separate payment document, so cash is never counted twice. Partial payments are just several
  matches.
- **Reversal** of a posted bill posts a mirror journal and cancels its obligation. It is refused while
  active payment matches exist; unmatch first.
- **Supplier debit notes:** stage 2b (same model, negative sign, linked to the original bill).

**Reports:**
- **AP aging** by supplier (current / 1–30 / 31–60 / 61–90 / 90+) from posted bills minus active
  matches, reconciled to the 2110 balance.
- **Supplier statement:** bills, payments, running balance.
- **GRNI listing** (2120 open items).

## 4. Screens (Figma first — page "18 — Accounting · Payables & Bank")

| Frame | Screen |
|---|---|
| ACC-20 | Supplier bills list: status tabs, aging chips, search |
| ACC-21 | Bill editor: supplier with VAT number check, lines with tax category, live totals, attachment |
| ACC-22 | Bill detail pending approval: journal preview, obligation link, audit |
| ACC-23 | AP aging + supplier statement |
| ACC-24 | Bank-to-ledger: per-cash-account posting status, blocked reasons, mapping of cash accounts and categories |
| ACC-25 | Bank ↔ ledger reconciliation report |
| ACC-26 | Mobile bill approval (390 px) |

## 5. Tests (same four levels as stage 1)

- **Unit:** line rounding, VAT per category, aging buckets, counter-side selection table (§2).
- **Database:** posted bill immutable; duplicate supplier invoice number refused; one journal per
  event; void → reversal; internal transfer posted once; unmapped cash account → BLOCKED;
  pre-cutover → SKIPPED; bill + obligation created atomically.
- **HTTP as the runtime role:** four-eyes on bills; permissions `ap_bill_create`, `ap_bill_approve`,
  `ap_bill_post`, `bank_posting_manage`; aging ties to 2110; bank reconciliation ties.
- **Browser / visual / a11y:** ACC-20..26 against Figma; axe with no serious violations in content.

## 6. Production gates (implementation proceeds; activation waits)

| Gate | Blocks |
|---|---|
| Chart approved (decision pack §1), including 1180 Supplier advances and category → GL mapping | bank posting, bills |
| Cash-account → GL mapping reviewed by the accountant | bank posting |
| Cutover date and opening balances (decision pack §6), including open AP per supplier | everything in production |
| Stock-purchase lines to GRNI are cleared only in stage 4 (valuation, D-1) | stock bills in production (non-stock bills may activate earlier) |

## 7. Implementation notes and known limitations

- **Bank line changed after posting — resolved 2026-09-28.** A posted line (or a transfer whose
  peer has posted) is frozen: amount, date, account, classification, splits, supplier/collection
  matches and the transfer link cannot change. This is enforced in the Finance services (clear 409
  with a pointer to Accounting) and by database triggers that also refuse the runtime role. A
  change goes through **Accounting → Bank → Corrections**: a correction request (void, or void and
  replace) with a reason, approved by someone else. Approval voids the line (a mirror journal dated on the
  approval day, whose period must be open; the original's period may be locked), creates the
  replacement as a new line linked to the original, and posts it on its own date. A transfer can
  only be voided (both legs), not replaced; the request, the decision and both journals stay in the audit trail. Tests:
  `bank-corrections.test.ts` (8, including concurrent approvals, retries, closed periods, transfers
  and supplier allocations) and `bank-corrections.test.mjs` (3, runtime role).
- **Stock lines on bills** debit GRNI 2120. This is a **provisional test assumption** until D-1
  (inventory valuation) is decided; GRNI is not cleared until stage 4.
- **Fixture approvals.** The local fixture approves the `payables.recognition` and `bank.posting`
  policies so the screens and HTTP tests can run. These approvals exist in the disposable
  databases only; production has none.
- **Attachments** on bills are not implemented.
