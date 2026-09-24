# Verification Report — Sales CRM & Commissions

Branch `feature/sales-crm-commissions` · base `4640cbe`.

Reported in the six separate categories the brief asked for, because collapsing them into one
number is how a suite that proves little comes to look like a suite that proves a lot.

**A note on what these numbers are not.** An assertion count is a measure of how much was
checked, not of how much is covered. 500 assertions about one function and 500 spread across a
module are the same number and completely different facts. Nothing below is offered as proof
that the module is defect-free; it is a record of what was exercised, and §4–§6 are the parts
worth reading if you want to know what was not.

---

## 1. Existing regression — did this branch break anything already working?

The operational ERP's own 26-suite regression, run against this branch's build, on the
non-production regression database with migration 21 applied.

**Result: recorded at the end of this section once the run completes.** *(See §1a.)*

What this does and does not establish:

- It **does** show that orders, production, packaging, QC, dispatch, blending, accounting and
  the reset paths still behave as their own suites assert, with the 19 new tables present and
  with `POST /api/orders` now delegating to the extracted `orders/create-order.ts`.
- It **does not** establish "zero regression". These suites cover what they cover. A behaviour
  none of them asserts could have changed and this run would be just as green.

The single most load-bearing suite for this change is `order-to-delivery`, because order
creation was refactored: the route no longer builds orders itself, it calls the shared service.
If that extraction were wrong, an order would come out with the wrong lines or the wrong
kilograms, and that suite drives a real order all the way to a delivery.

### 1a. Result

```
ERP_E2E_BASE_URL=http://127.0.0.1:3010 node withpkg-sales.mjs node scripts/e2e/regression/run-all.mjs
```

<!-- RESULT-PLACEHOLDER -->

---

## 2. New feature tests — API and domain level

Five suites, run with `npm run regression:sales` against `sales_crm_preview`.

| Suite | Assertions | What it proves | Needs |
|---|---|---|---|
| `commission-engine` | **48** | the arithmetic: base, tiers, splits, periods, rounding, refusals | nothing — pure |
| `quotes-domain` | **112** | quotation pricing, the lifecycle table, and the whole CSV layer | nothing — pure |
| `sales-commissions-db` | **23** | constraints exist, concurrency resolves, a rollback leaves nothing | PostgreSQL |
| `sales-security` | **34** | what is refused — every case passes only if the server said no | running app |
| `sales-workflow` | **182** | the ordinary path end to end, with rows checked after every step | running app |
| | **399** | **0 failed** | |

The two pure suites are the ones to trust most: every expected figure in them was worked out by
hand and written as a literal, so none of them can pass by the code agreeing with itself.

`sales-workflow` is the one that answers "can a user actually do this": lead → duplicate
handling → conversion → activities → sample → quotation → discount refusal → issue → revision →
acceptance → order → idempotent replay → won → collections → accrual → approval → refund →
adjustment → payout → target → report → CSV import → CSV export. After each step it reads the
database rather than believing the response.

---

## 3. Browser workflows exercised

Chrome, real screens, real keypad sign-in. `npm run uat:sales`.

**44 tests, 0 failed** (`tests/e2e/sales-crm.spec.ts`), plus **15, 0 failed** in the existing
`permissions.spec.ts`, extended with the three CRM roles.

| Group | Workflows driven |
|---|---|
| Sign-in and session | a rep signs in and the session survives a reload; signing out refuses a protected page; a deactivated employee is unauthenticated on the very next request |
| Leads | create through the form; the same phone in another format is reported and the operator may still proceed; a rep cannot see or reach a colleague's lead; a manager can; conversion makes one customer and one deal however many times it is clicked |
| Deals | the deal page opens; a stage move writes an event and survives a reload; a rep cannot close a deal at all; a manager marking one lost cannot until a reason is typed; the server refuses it too when the dialog is bypassed; reopening is a separate privilege and clears the stale loss reason |
| Quotations | build a quotation line by line and the server prices it; a rep is refused at the discount threshold; a manager issues it and the approval is recorded on the document; the issued quotation is read-only on screen and on the server; a revision supersedes and carries the lines; the revision is issued at a corrected price and accepted |
| Orders | the accepted quotation becomes exactly one order with kilograms derived by the order service; clicking again returns the first order; the order appears on the operational Orders screen; the deal can then be won |
| Commission | a rep cannot record a collection; a partial collection accrues once and a re-delivery changes nothing; the rep sees their own figure marked as sandbox and cannot open the team review; the second instalment adds the difference and the rows sum to the period; two people on different plans are paid differently for the same money; finance reviews and the ledger reconciles with the rows; finance cannot approve their own; approval makes the rows immutable; a refund after approval corrects the ledger and leaves the approved rows untouched |
| Arabic, mobile, keyboard | RTL renders with Arabic headings and no horizontal overflow at 390px; the follow-ups screen works at phone width; a form is completed with the keyboard alone, reached by label; Escape closes a dialog without saving; an invalid form cannot be submitted and the server agrees; the CSV importer previews before it writes |
| Targets and reports | a manager sets a target and the bar reflects real collections; a manager cannot set their own; the reports screen states the denominator of its conversion rate; a rep's reports are scoped to their own work |

**Where the API is used instead of the UI, and why.** Two places, both marked in the file.
Sandbox collection events, because there is deliberately no screen for them — the collection
source is an adapter behind three server-side gates, and an operator-facing way to type in
payments would be building the very thing this module does not claim to have. And every
negative permission check, because a hidden button is a courtesy and the handler is the control.
Both call the endpoint **from inside the logged-in browser session**, with the real cookie.

**Nothing external is mocked, because nothing external exists**: no email, no SMS, no payment
provider, no queue. The only outbound integration in the codebase is an optional translation
API which this module does not touch.

---

## 4. Requirements not yet covered

The full matrix is `REQUIREMENTS_MATRIX.md`. What is NOT built, gathered here:

| Gap | Where it stands |
|---|---|
| **A printable / PDF quotation document** | `issuedSnapshot` already stores exactly what a renderer needs — lines, names and prices as at issue. Nothing renders it. |
| **A pipeline-stage settings screen** | Stages are fully configurable through `GET/POST/PATCH /api/sales/stages`, and the board reads them. There is no screen to reorder or rename them. |
| **Report export** | Leads export to CSV. The reports do not. |
| **A screen to delete a lead** | The rule (never once it has history) is enforced on `DELETE /api/sales/leads/[id]`; no screen offers it. |
| **Figma design and prototype** | See §5. |

Two rules are implemented and enforced but have **no assertion of their own**: retiring a
pipeline stage that still holds deals, and ending a commission assignment. Both are exercised
incidentally by other tests. They are listed here rather than counted as covered.

---

## 5. Tests and work blocked or skipped

| Item | Status | Precisely what is missing |
|---|---|---|
| **Hosted Preview deployment and smoke test** | **BLOCKED** | Vercel refuses a branch-scoped Preview variable for a branch that does not exist on the remote (`branch_not_found`). The branch must be pushed first, and pushing triggers the first deployment. That first build was verified to **fail closed at the environment gate** — no `DATABASE_URL`, no `PIN_LOOKUP_SECRET` — before compiling anything and before any connection. The sequence to finish it is in `PREVIEW_REVIEW_GUIDE.md` §1. Not done because the instruction was explicit: do not push until the trigger and the effective isolation are verified, and the latter needs a deployment. |
| **Figma design and prototype** | **BLOCKED** | The MCP server is installed but unauthenticated; only `authenticate` and `complete_authentication` are exposed. OAuth consent is the account holder's to give and was not bypassed. Whether that server can write canvas content at all is **still untested** — the tools do not appear until authentication succeeds, so claiming it can would be a guess. `FIGMA_UX_HANDOFF.md` holds the handoff material. |
| **Database privilege isolation for the preview** | **NOT DONE, deliberately** | `DATABASE_ISOLATION.md` §3b. One role owns everything and can reach the production-derived `neondb` on the same branch; only the application allowlist prevents it. The fix changes role grants on infrastructure shared with the operational regression, so it is written down rather than taken. |
| **Load, performance and soak testing** | **NOT ATTEMPTED** | No claim is made about behaviour under concurrent load beyond the specific races the DB suite asserts. |
| **Accessibility audit beyond what is tested** | **PARTIAL** | Labels, keyboard operation, focus states, `aria-*` on dialogs and progress bars are implemented and partly tested. No screen-reader pass and no contrast audit was run. |

Nothing was skipped because it was inconvenient, and no test was deleted, weakened or had an
expected value changed to accommodate behaviour.

---

## 6. Remaining implementation and integration gaps

**The financial cycle is not integrated, and this is the most important sentence in this
document.** This ERP has no invoice, payment or receivables model — verified against the
schema, not assumed. Commission is owed on money actually *collected*, so collection is an
**adapter**, and its only implementation is a sandbox: events entered deliberately through a
surface behind three server-side gates, every row stamped `sourceSystem = "SANDBOX"`, and every
screen that displays a figure derived from them says so.

**No commission figure in this module corresponds to money anyone has actually received.**

What a real integration would need to replace: one adapter, `POST`/`PATCH
/api/commissions/sandbox-collections`, writing `CollectionEvent` rows with a different
`sourceSystem`. Everything downstream — accrual, splits, tiers, periods, approval, ledger — is
already indifferent to where the event came from, which is why the adapter shape was chosen.

Other integration notes:

- **Quotation → order is real**, and goes through the same `orders/create-order.ts` that
  `POST /api/orders` uses. There is no second order writer.
- **Customers are the existing `Customer` model.** No parallel customer system was created.
- **Samples do not move stock**, deliberately. The roastery has one inventory path with its own
  guards; a second one is the defect the packaging rework was spent closing.
- **A payout is a record, not a transfer.**

---

## 7. Defects found and fixed during this work

All six were found by tests rather than by reading, which is the point of them. Each was fixed
at the root and each has a regression test.

1. **A manual adjustment was cancelled out by the next collection.** The accrual engine counted
   `ADJUSTMENT` ledger entries as part of its own baseline, so the next payment computed a
   target that already contained the adjustment and wrote a smaller delta to compensate. An
   agreed goodwill payment evaporated the moment the customer paid again; the only symptom was
   somebody being paid less than they were promised. Fixed: the engine's baseline is `ACCRUAL`
   and `REVERSAL` only — which is what `periodStatement` had always reported separately.
   *(flow E9)*
2. **Every accrual row carried the period's running total** instead of its own collection
   event's contribution. A month with 50 then 100 collected showed rows of 50 and 150, summing
   to 200 against a real 150; anyone adding up their own payslip got a different answer from the
   ledger. Fixed: accruals are marginal, and the review screen now reconciles the two and shows
   the difference. *(flow E5)*
3. **`postDelta` upserted over APPROVED accruals.** A refund after approval silently restated a
   figure somebody had already been told they had earned — the exact failure an append-only
   ledger exists to prevent. Fixed: an approved accrual is frozen and the correction lives
   entirely in the ledger. *(flow E8, ui 5.8)*
4. **The lead form's Source select announced itself as its own option list.** A `<select>`
   wrapped in a `<label>` takes its accessible name from the label's whole text content, options
   included, so a screen reader read it as "Source Walk-in Referral Phone Social…" — and it was
   indistinguishable from the Phone field. Fixed: explicit `aria-label` on every control.
   *(found by ui 2.1)*
5. **Money rendered without its decimals.** A Prisma Decimal serialises as the shortest string
   that represents it, so a quotation total displayed as "1552.5 SAR". Fixed with `formatMoney`,
   which pads and groups as string operations — `Number(x).toFixed(2)` would be shorter and
   would route the amount through binary floating point. *(ui 4.1)*
6. **The import preview miscounted the file**, reporting "2 of 2 rows would be imported" for a
   three-row file, because the denominator counted rows that parsed rather than rows the file
   held. *(quotes I1/I5, ui 6.6)*

Three of the test fixtures were also wrong and were corrected rather than accommodated: all
three sandbox payments shared one timestamp, which made it impossible to test that a split takes
effect *from* its own date; a BOM assertion read the decoded string, which is exactly where
`fetch` strips a BOM; and a URL poll was already satisfied on the page the click started from.

---

## 8. Production

**Untouched.** No production database connection, no migration, no deployment, no environment
variable change, no push to `main`, no merge, no resource deleted, no paid upgrade.

The only databases written to were `sales_crm_preview` (created empty for this work) and the
non-production regression database. The only Vercel operation performed was **reading** variable
names and scopes; one attempt to create a branch-scoped Preview variable was refused by Vercel
and nothing was created. Production variables were not read and not changed.
