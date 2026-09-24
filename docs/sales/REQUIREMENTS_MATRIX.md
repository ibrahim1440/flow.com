# Requirements → deliverables → evidence

Every requirement of the Sales CRM & Commissions brief, with the service that implements it,
the API that exposes it, the screen that drives it, and the test that proves it.

**Status vocabulary.** `DONE` means it is built and a named test exercises it. `PARTIAL`
means some of it is built and the rest is named below. `NOT BUILT` means exactly that.
`REFUSED` means it was deliberately not built, with the reason. Nothing untested is called
done.

Branch `feature/sales-crm-commissions` · base `4640cbe`.

Test identifiers:
- `engine:` `scripts/e2e/regression/commission-engine.mjs` — pure arithmetic, no database
- `quotes:` `scripts/e2e/regression/quotes-domain.mjs` — pricing, lifecycle, CSV, no database
- `db:` `scripts/e2e/regression/sales-commissions-db.mjs` — real PostgreSQL
- `sec:` `scripts/e2e/regression/sales-security.mjs` — real HTTP, negative cases
- `flow:` `scripts/e2e/regression/sales-workflow.mjs` — real HTTP, the ordinary path
- `ui:` `tests/e2e/sales-crm.spec.ts` — Chrome, real screens. `ui N.M` is the Mth test of
  the Nth `describe` block in that file.
- `perm:` `tests/e2e/permissions.spec.ts` — Chrome, the role matrix

---

## 1. Leads

| # | Requirement | Service | API | Screen | Tests | Status |
|---|---|---|---|---|---|---|
| 1.1 | Capture a lead: company, contact, phone, email, city, source | `sales/leads.ts` | `POST /api/sales/leads` | Leads → New lead | flow A1, ui 2.1 | **DONE** |
| 1.2 | Detect duplicates without merging | `findDuplicateCandidates` | same, 409 + candidates | in-form duplicate panel | flow A2/A3, ui 2.2, sec C1 | **DONE** |
| 1.3 | Normalise Arabic names and phone formats for comparison | `normalizeCompany` / `normalizePhone` | — | — | flow A1/A4 | **DONE** |
| 1.4 | Assign / reassign an owner | — | `PATCH /api/sales/leads/[id]` | Leads | flow A4, sec C1 | **DONE** |
| 1.5 | Edit a lead; refuse editing a converted one | — | `PATCH /api/sales/leads/[id]` | Leads | flow A4/A6 | **DONE** |
| 1.6 | Delete a lead raised in error, but never one with history | — | `DELETE /api/sales/leads/[id]` | Leads → delete | ui 8.5/8.6 | **DONE** |
| 1.7 | Lead status lifecycle (new → contacted → qualified / unqualified) | — | `PATCH /api/sales/leads/[id]` | Leads filter + form | flow A4 | **DONE** |
| 1.8 | Follow-up date, and a visible overdue state | — | list ordering | Leads, Follow-ups | ui 6.2 | **DONE** |
| 1.9 | Convert to customer + deal, idempotently | `convertLead` | `POST /api/sales/leads/[id]/convert` | Leads → Convert | flow A5, db B1/B2, ui 2.5 | **DONE** |
| 1.10 | Import leads from CSV, validated | `sales/csv.ts` | `POST /api/sales/leads/import` | Leads → Import CSV | quotes I1–I10, flow H1–H4, ui 6.6 | **DONE** |
| 1.11 | Export leads to CSV, scoped and privilege-gated | `sales/csv.ts` | `GET /api/sales/leads/export` | Leads → Export CSV | flow H5 | **DONE** |

---

## 2. Pipeline and deals

| # | Requirement | Service | API | Screen | Tests | Status |
|---|---|---|---|---|---|---|
| 2.1 | Configurable pipeline stages, ordered, bilingual | — | `GET/POST/PATCH /api/sales/stages` | Sales settings | flow I1, ui 8.3 | **DONE** |
| 2.2 | A stage holding deals cannot be retired | — | `PATCH /api/sales/stages` | Sales settings | flow I2, ui 8.4 | **DONE** |
| 2.3 | Kanban board of open deals, and a way to open one | — | `GET /api/sales/opportunities` | Pipeline | ui 3.1 | **DONE** |
| 2.4 | Deal detail: value, probability, dates, customer, owner | — | `GET/PATCH /api/sales/opportunities/[id]` | Deal detail | ui 3.2, flow D5 | **DONE** |
| 2.5 | Move between stages, with the move recorded | `transitionOpportunity` | `POST .../[id]/transition` | Deal detail stage row | ui 3.3 | **DONE** |
| 2.6 | Won requires a customer AND an accepted quotation | `transitionOpportunity` | same | Deal detail | flow C1/D5, ui 4.9 | **DONE** |
| 2.7 | Lost requires a reason | `transitionOpportunity` | same | Lost dialog | flow D5, ui 3.5/3.6 | **DONE** |
| 2.8 | Reopening a closed deal is a separate privilege | `transitionOpportunity` | same | Deal detail | ui 3.7, sec B1 | **DONE** |
| 2.9 | A rep sees only their own deals | `sales/scope.ts` | every sales endpoint | every sales screen | sec C2/D1, ui 2.3/2.4 | **DONE** |
| 2.10 | Split attribution between several people | `validateSplits` | `PUT .../[id]/owners` | Deal detail → Split | engine D1/D2, flow F1 | **DONE** |
| 2.11 | A split takes effect from its own date; history is not re-pointed | `sharesForCollection` | same | Split dialog notice | flow F1 | **DONE** |

---

## 3. Activities, follow-ups and samples

| # | Requirement | Service | API | Screen | Tests | Status |
|---|---|---|---|---|---|---|
| 3.1 | Log a call, visit, meeting or note against a lead or deal | — | `POST /api/sales/activities` | Deal detail, Follow-ups | flow B1, ui 6.3 | **DONE** |
| 3.2 | Tasks with a due date; a task cannot exist without one | — | same | Activity dialog | flow B1 | **DONE** |
| 3.3 | Overdue / due-today / open queue | — | `GET /api/sales/activities` | Follow-ups | flow B1, ui 6.2 | **DONE** |
| 3.4 | Complete a task; completing twice keeps the first timestamp | — | `PATCH /api/sales/activities/[id]` | Follow-ups, Deal detail | flow B1 | **DONE** |
| 3.5 | Only the owner completes or edits their own activity | — | same | — | flow B1 | **DONE** |
| 3.6 | A completed activity cannot be deleted | — | `DELETE .../[id]` | — | flow B1 | **DONE** |
| 3.7 | Record a sample: product or description, quantity, status | — | `POST /api/sales/samples` | Deal detail → Sample | flow B2 | **DONE** |
| 3.8 | Sample lifecycle; feedback only after it was sent | — | `PATCH /api/sales/samples/[id]` | Deal detail | flow B2 | **DONE** |
| 3.9 | A sent sample schedules its own follow-up | — | both sample routes | — | flow B2 | **DONE** |
| 3.10 | **Recording a sample does not move stock** | — | response `notice` | screen notice | flow B2 (asserts no `InventoryMovement`) | **DONE** |
| 3.11 | Send email / SMS / WhatsApp from the CRM | — | — | — | — | **REFUSED** — nothing here dispatches a message, and no screen implies it does. A CRM that logs "sent" without sending is worse than one that logs nothing. |

---

## 4. Quotations

| # | Requirement | Service | API | Screen | Tests | Status |
|---|---|---|---|---|---|---|
| 4.1 | Build a quotation from catalogue products or free text | `sales/quotes.ts` | `POST /api/sales/quotes`, `PUT .../[id]` | Quote editor | quotes A/B, flow C2, ui 4.1 | **DONE** |
| 4.2 | Server-side pricing; a client total is ignored | `priceQuote` | same | editor marks its preview as a preview | quotes B1, flow C3 | **DONE** |
| 4.3 | Per-line discount and tax, discount before tax | `priceLine` | same | Quote editor | quotes A3 | **DONE** |
| 4.4 | Validation: quantity, price, ranges, whole packs, active SKU | `validateLines` | same | inline errors | quotes C1–C7, flow C4 | **DONE** |
| 4.5 | A discount above the threshold needs approval to issue | `discountNeedsApproval` | `POST .../[id]/transition` | warning + refusal | quotes D1/D2, flow C5, ui 4.2/4.3 | **DONE** |
| 4.6 | The approver is recorded on the document | `issueQuote` | same | badge | flow C5, ui 4.3 | **DONE** |
| 4.7 | Issue freezes the lines and prices as sent | `issueQuote` (`issuedSnapshot`) | same | read-only editor | flow C5, ui 4.3/4.4 | **DONE** |
| 4.8 | Accept / reject / expire, rejection needs a reason | `decideQuote` | same | Accept / Reject | quotes E4, flow C8 | **DONE** |
| 4.9 | An issued quotation cannot be edited | `saveQuoteLines` | `PUT .../[id]` | disabled inputs | flow C6, ui 4.4 | **DONE** |
| 4.10 | Revisions supersede, and the chain is walkable both ways | `reviseQuote` | `POST .../[id]/revise` | Revise | flow C7, ui 4.5 | **DONE** |
| 4.11 | An accepted quotation cannot be revised or un-accepted | `isRevisable`, `assertTransition` | same | control hidden | quotes E3/E4, flow C8 | **DONE** |
| 4.12 | Validity date required to issue; an expired quote cannot be accepted | `issueQuote`, `hasExpired` | same | date field + hint | quotes E5 | **DONE** |
| 4.13 | Quotation numbering, unique and readable | `nextQuoteNumber` | — | shown everywhere | flow C2 | **DONE** |
| 4.14 | Printable quotation document, from the frozen snapshot | — | `GET /api/sales/quotes/[id]` | Quote → Document | ui 8.1/8.2 | **DONE** — renders `issuedSnapshot`, so renaming a SKU afterwards does not rewrite what the customer was sent; printed through the browser rather than a PDF library |
| 4.15 | Quotations in a currency other than SAR | — | — | — | quotes (currency guard) | **REFUSED** — no exchange-rate policy exists to honour |

---

## 5. Quotation → order

| # | Requirement | Service | API | Screen | Tests | Status |
|---|---|---|---|---|---|---|
| 5.1 | An accepted quotation becomes a real order | `sales/quote-to-order.ts` | `POST .../[id]/create-order` | Quote editor → Create order | flow D1, ui 4.6 | **DONE** |
| 5.2 | Through the existing order service, not a second writer | `orders/create-order.ts` (shared with `POST /api/orders`) | same | — | flow D1 (asserts derived kilograms), full regression | **DONE** |
| 5.3 | Idempotent: one agreement, one order | `requestKey` unique | same | — | flow D2, ui 4.7 | **DONE** |
| 5.4 | A draft or issued quotation cannot become an order | — | same | control hidden | flow D3 | **DONE** |
| 5.5 | A free-text or fractional line is refused BY NAME, not dropped | — | same | error text | flow D4 | **DONE** |
| 5.6 | First order vs repeat business recorded | `isFirstOrder` | same | Deal detail → Orders | flow D1 | **DONE** |
| 5.7 | The order is visible to the operational ERP | — | — | Orders screen | ui 4.8 | **DONE** |

---

## 6. Commission engine

| # | Requirement | Service | API | Screen | Tests | Status |
|---|---|---|---|---|---|---|
| 6.1 | A different rate per employee | `plans.ts`, `engine.ts` | `/api/commissions/plans`, `/assignments` | Commission plans | engine B1, ui 5.5 | **DONE** |
| 6.2 | Base is net collected cash, excluding tax and non-qualifying lines | `qualifyingBase` | — | explained on My commissions | engine A1–A3 | **DONE** |
| 6.3 | Incremental tiers as percentage POINTS on a slice | `commissionOnCumulativeBase` | — | stated next to the field | engine C1–C6 | **DONE** |
| 6.4 | Retroactive tiers | `validatePlanRules` | refused at 400 | — | engine F1, flow E2 | **REFUSED** — they pay very differently on identical numbers; refused rather than approximated |
| 6.5 | Plan versioning; a live rule is never edited in place | `addPlanVersion` | `POST /plans/[id]/versions` | Commission plans | flow E1 | **DONE** |
| 6.6 | The plan is chosen by the date the CASH arrived | `selectPlanVersion` | — | — | engine H1 | **DONE** |
| 6.7 | No overlapping assignments for one person | `findOverlappingAssignment` | `POST /assignments` | Assign dialog | engine H2, flow E1 | **DONE** |
| 6.8 | Nobody puts themselves on a plan | `assignPlan` | same | — | flow E1 | **DONE** |
| 6.9 | An assignment is ended, never deleted | `endAssignment` | `PATCH /assignments` | Commission plans | flow I3 | **DONE** |
| 6.10 | Partial collection accrues once; instalments add the difference | `recomputeEmployeePeriod` | sandbox adapter | My commissions | engine E1, flow E3/E5, ui 5.2/5.4 | **DONE** |
| 6.11 | A re-delivered payment changes nothing | unique `(sourceSystem, externalRef)` | same | — | engine E2, db A2, flow E4, ui 5.2 | **DONE** |
| 6.12 | Rounding across instalments totals exactly | `roundMoney` | — | — | engine E3, db C4 | **DONE** |
| 6.13 | Refunds reverse without editing anything | `postDelta` | `PATCH /sandbox-collections` | — | engine E4, flow E8, ui 5.8 | **DONE** |
| 6.14 | Split commissions divide the BASE, not the finished commission | `shareOfBase` | `PUT .../owners` | Split dialog | engine D1, flow F1 | **DONE** |
| 6.15 | Riyadh month periods | `riyadhMonthStart/End` | every period endpoint | month pickers | engine G1–G3, db D1 | **DONE** |
| 6.16 | Money is never floating-point | `Decimal` throughout | — | `formatMoney` pads as strings | db C4, quotes A4/A5 | **DONE** |

---

## 7. Commission review, approval and payout

| # | Requirement | Service | API | Screen | Tests | Status |
|---|---|---|---|---|---|---|
| 7.1 | An employee sees their own commission and how it was computed | `periodStatement` | `GET /api/commissions/me` | My commissions | flow E10, ui 5.3 | **DONE** |
| 7.2 | A manager / finance sees the team's | — | `GET /api/commissions/review` | Commission review | flow E6, ui 5.6 | **DONE** |
| 7.3 | The ledger and the accrual rows are reconciled, and the difference shown | review route | same | reconciliation pill | flow E6, ui 5.6 | **DONE** |
| 7.4 | Approve a period; approved figures become immutable | `approvePeriod`, `postDelta` | `POST /review/actions` | Approve | flow E7/E8, ui 5.7/5.8 | **DONE** |
| 7.5 | Nobody approves, adjusts or pays their own commission | actions route | same | — | flow E7, ui 5.7 | **DONE** |
| 7.6 | A correction is an appended adjustment with a reason and an actor | `adjust` | same | Adjust dialog | flow E9 | **DONE** |
| 7.7 | An adjustment is NOT absorbed by the next collection | `recomputeEmployeePeriod` | — | — | flow E9 (regression for defect 1) | **DONE** |
| 7.8 | Record a payout; never more than is owed, never before approval | actions route | same | Payout dialog | flow E9 | **DONE** |
| 7.9 | Actually moving money | — | — | — | — | **REFUSED** — there is no payment integration; the screen says a payout is a record, not a transfer |

---

## 8. Targets and reports

| # | Requirement | Service | API | Screen | Tests | Status |
|---|---|---|---|---|---|---|
| 8.1 | A monthly target per employee, with an optional bonus | — | `PUT /api/sales/targets` | Sales targets | flow G1, ui 7.1 | **DONE** |
| 8.2 | Progress measured against COLLECTIONS, not pipeline value | targets route | `GET /api/sales/targets` | progress bar | flow G2, ui 7.1 | **DONE** |
| 8.3 | Nobody sets their own target | targets route | same | — | flow G1, ui 7.2 | **DONE** |
| 8.4 | A target is not a commission rate | — | separate models | stated on screen | — | **DONE** (by construction) |
| 8.5 | Conversion rate as a COHORT rate from real conversion links | reports route | `GET /api/sales/reports` | Reports | flow G3, ui 7.3 | **DONE** |
| 8.6 | Pipeline by stage, count and value | reports route | same | Reports | ui 7.3 | **DONE** |
| 8.7 | Win rate, won/lost value, reasons for loss | reports route | same | Reports | flow G3 | **DONE** |
| 8.8 | Sales-cycle length, median and mean, with a sample size | reports route | same | Reports | flow G3 | **DONE** |
| 8.9 | Lead sources breakdown | reports route | same | Reports | flow G3 | **DONE** |
| 8.10 | Reports scoped to a rep's own work | `seesAllSales` | same | banner | ui 7.4 | **DONE** |
| 8.11 | Export a report to CSV | `sales/csv.ts` | `GET /api/sales/reports?format=csv` | Reports → Export CSV | ui 7.5 | **DONE** — one flat table, with the sandbox caveat as a row in the file |

---

## 9. Security and permissions

| # | Requirement | Where | Tests | Status |
|---|---|---|---|---|
| 9.1 | Two new permission modules with fine-grained sub-privileges | `auth-shared.ts` | perm, sec B1 | **DONE** |
| 9.2 | Unauthenticated access refused on every endpoint | `requireModule` / `requireSub` | sec A1 | **DONE** |
| 9.3 | A module without a sub-privilege is refused | `requireSub` | sec B1, ui 3.4/5.1 | **DONE** |
| 9.4 | Ownership cannot be set by the request body | lead / activity routes | sec C1, flow A1, ui 6.3 | **DONE** |
| 9.5 | Read scoping happens in the WHERE clause | `sales/scope.ts` | sec C2, ui 2.3 | **DONE** |
| 9.6 | Another owner's id in the URL reads as 404, not 403 | every `[id]` route | sec D1, ui 2.3 | **DONE** |
| 9.7 | A rep cannot fabricate a collection | sandbox gates | sec E1/E2, ui 5.1 | **DONE** |
| 9.8 | A deactivated employee is unauthenticated on the next request | `getUserWithPermissions` | ui 1.3 | **DONE** |
| 9.9 | Errors leak no SQL or Prisma internals | `handleDomainError` | sec H1 | **DONE** |
| 9.10 | A CSV export cannot carry a live formula | `neutralizeCsvCell` | quotes H1–H3, flow H5 | **DONE** |
| 9.11 | Export is its own privilege, and scoped | export route | flow H5 | **DONE** |
| 9.12 | The sandbox source is non-production-only and visibly labelled | three gates | sec E3, db E1, ui 5.3 | **DONE** |

---

## 10. Interface quality

| # | Requirement | Where | Tests | Status |
|---|---|---|---|---|
| 10.1 | Arabic RTL throughout | logical properties only, `dir` on `<html>` | ui 6.1 | **DONE** |
| 10.2 | Responsive down to phone width, no horizontal scroll | `TableWrap`, flex/grid | ui 6.1/6.2 | **DONE** |
| 10.3 | Labels wired to controls; keyboard-only operation | `Field`, explicit `aria-label`s | ui 6.3 | **DONE** |
| 10.4 | Escape and outside-click close a dialog without saving | `Modal` | ui 6.4 | **DONE** |
| 10.5 | Validation errors prevent submission and say what is wrong | disabled controls + inline text | ui 6.5 | **DONE** |
| 10.6 | Money formatted consistently, never through a float | `formatMoney` | ui 4.1 | **DONE** |
| 10.7 | Every screen states that it is provisional | `ProvisionalBanner` | ui 3.1 | **DONE** |
| 10.8 | Designed in Figma | — | — | **NOT DONE** — see `FIGMA_UX_HANDOFF.md`. The interface is built from the existing ERP components and says so on every screen. |

---

## 11. What is not built, gathered in one place

**One item, and it is not code.**

1. **Figma design and prototype.** (10.8) Blocked on OAuth consent that only the account
   holder can give. Everything else it would describe now exists as a tested reference
   implementation — see `FIGMA_UX_HANDOFF.md` §1a.

Everything in this matrix that is implemented has a named assertion of its own. The four
items that were listed here as NOT BUILT — the printable quotation document, the pipeline
settings screen, report export, and deleting a lead from the interface — are built and
tested. The two rules that were enforced but unasserted — retiring a stage that still holds
deals, and ending a commission assignment rather than deleting it — are covered by
`flow I2` and `flow I3`.

## 12. What is refused, and why

| Refused | Reason |
|---|---|
| Sending email / SMS / WhatsApp (3.11) | Nothing here dispatches a message. Logging "sent" without sending stops the rep chasing. |
| Non-SAR quotations and commissions (4.15) | No exchange-rate policy exists; a figure would have to be invented, inside somebody's pay. |
| Retroactive commission tiers (6.4) | They pay very differently on identical numbers, and the error surfaces in a payslip. |
| Moving money on payout (7.9) | There is no payment integration. The screen says so rather than implying one. |
| Moving stock from a sample (3.10) | The roastery has one inventory path with its own guards. A second one is the defect the packaging rework was spent closing. |
| A real receivables ledger | Out of scope: this is a CRM task, not an accounting system. Collection is an adapter, and its only implementation is a clearly labelled sandbox. |
