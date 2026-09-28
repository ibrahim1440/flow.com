# Stage 3 — Sales invoices and receivables (design and status)

Status (2026-09-28): **implemented and tested locally** on synthetic data. Not run on Neon or
Vercel (cloud access blocked, see `NETWORK_ACCESS.md`). Production activation waits for the
decision pack (D-2 and the `receivables.*` policies) and a release package. **Not ZATCA-integrated**:
invoices carry the data a tax invoice needs, but nothing is signed, reported or cleared (stage 6,
sandbox only).

## 1. Documents

| Document | Lifecycle | Journal on posting |
|---|---|---|
| Sales invoice | DRAFT → SUBMITTED → APPROVED (four-eyes) → POSTED → REVERSED | Dr 1130 receivables (party) / Cr revenue per line (default 4100) / Cr 2170 output VAT |
| Credit note | same; must name a posted invoice of the same customer; total credits never exceed the invoice | Dr 4900 sales returns (net) / Dr 2170 / Cr 1130 (party); settles its invoice first |
| Customer receipt | a bank line classified *customer receipt/refund*, assigned to a customer | Dr bank / Cr 1130 for the allocated part, Cr 2410 + Cr 2170 (per D-2) for the advance part, all party-tagged |
| Advance application | applies a customer's advance to an open invoice | Dr 2410 (net) + Dr 2170 (VAT carried) / Cr 1130 (party) |

Line arithmetic: quantity × price, discount %, then VAT, rounded half-up to halalas at each step
(`sales-rules.ts`; 5,000-case property test `sales-math.test.ts` agrees with the UI helper).
An order is invoiced at most once while its invoice is live (partial unique index); posting sets the
order's VAT-invoice status to "Sent".

## 2. Receipts and the existing collections and commissions

- Cash posts **once**, from the bank line, and only after the line is assigned to a customer
  (Accounting → Receivables → Customer receipts). Unassigned customer lines are BLOCKED with that
  reason.
- A bank line linked in Finance to a **finance-approved sales collection** proposes the customer
  and cannot be assigned to another one. A collection can back only one receipt (checked, row-locked
  and enforced by a unique index).
- The sales collection itself never posts, and commissions keep posting from the commission ledger
  as before. Test: one bank journal, commission journal count unchanged, no event for the collection
  (`receivables.test.ts`, `receivables-workflow.test.mjs`).
- POS and payment-gateway settlements stay with manual journals (not automated in this stage).

## 3. Controls

- Database triggers on every Stage 3 table: posted documents and their lines are immutable;
  approval by someone other than the preparer/submitter; totals equal lines; allocations are
  append-only (switched off, never edited or deleted), same customer, never beyond what is owed;
  advance applications are reversed, not changed; a receipt whose bank line has posted cannot change
  (correct it through Bank corrections, which releases its allocations).
- Outbox events with idempotency keys `receivables:<id>:<event>` and per-customer ordering.
- Duties: `ar_invoice_create`, `ar_invoice_approve`, `ar_invoice_post`, `ar_receipt_assign`
  (plus `settings_manage` for the D-2 setting).
- Policy gates: `receivables.recognition` for invoices/credit notes; `receivables.advances` **and**
  the D-2 setting for anything that creates or applies an advance. Undecided → the posting waits
  (provisional posting only in an isolated test database).

## 4. Reports

- AR aging as of a date, per customer, with unapplied credits; subledger total tied to 1130, and
  advances tied to 2410 plus party-tagged 2170. A receipt counts only once its bank line has posted
  (same rule in the invoice list and detail "Open").
- Customer statement for a period, tied to the customer's party lines on 1130, 2410 and 2170; CSV.

## 5. Screens (Figma page 19, ACC-30..36)

List (ACC-30), editor (ACC-31), detail and approval (ACC-32), customer receipts and assignment
(ACC-33), aging and statement (ACC-34), credit note (ACC-35), mobile approval (ACC-36). Parity and
differences: `FIGMA_PARITY.md`.

## 6. Tests

| Level | File | Count |
|---|---|---|
| Unit | `tests/accounting/unit/sales-math.test.ts` (+ rules) | in the 23 unit tests |
| DB integration | `tests/accounting/integration/receivables.test.ts` | 10 |
| HTTP, runtime role | `tests/accounting/http/receivables-workflow.test.mjs` | 3 |
| Browser | `capture.mjs` ACC-30..36, `a11y.mjs` (axe, WCAG 2.1 A/AA rules) | 8 views, 0 serious/critical |

## 7. Known limitations

- Aging "as of" a past date counts invoices that are POSTED **now**; an invoice reversed later is not
  reconstructed for dates before its reversal.
- Credit notes post their whole net to one returns account (4900); no per-line revenue reversal.
- No cost of sales on invoices until D-1 (stage 4); no stock movement from credit notes.
- The credit limit is shown as a warning only; it does not block.
- Changing the D-2 setting affects receipts assigned afterwards; earlier advances keep their VAT.
- The customer dropdown's "open receivables" figure counts every active allocation (including
  receipts not yet posted), unlike aging.
- No attachments; no e-mail of invoices or statements (by design: no messages to customers).
