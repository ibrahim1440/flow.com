# Figma ↔ application — Accounting

File: https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5 — page [link](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=384-2) **"17 — Accounting · General Ledger"**
(`384:2`), built by cloning the Finance shell (FIN-01) and the Finance card/table/badge styles
(Tajawal; `#7c3aed`; 16 px cards; RTL order). No existing page was modified.

| Frame | Figma node (link) | Route | App evidence (`evidence/app/`) | Status | Documented differences |
|---|---|---|---|---|---|
| ACC-01 Overview | [`384:3`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=384-3) | `/dashboard/accounting` | ACC-01-app-1440.png, ACC-01-1024-app-1024.png | Complete | Figma shows a TB bounded to 30 Sep; app shows 1 Jan → today (date filter on the Reports screen). |
| ACC-02 Journal list | [`385:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=385-2) | `/dashboard/accounting/journals` | ACC-02-app-1440.png | Complete | App adds a sort selector. |
| ACC-03 Editor (unbalanced) | [`385:599`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=385-599) | `/dashboard/accounting/journals/new` | ACC-03-app-1440.png | Complete | App adds a Branch column (same data as the frame's cost-centre group). |
| ACC-04 Detail, pending approval | [`385:1147`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=385-1147) | `/dashboard/accounting/journals/[id]` | ACC-04-app-1440.png | Complete | App shows the entry heading (number, amount, period) above the cards. |
| ACC-05 Chart of accounts | [`386:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=386-2) | `/dashboard/accounting/accounts` | ACC-05-app-1440.png | Complete | — |
| ACC-06 Periods & closing | [`386:637`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=386-637) | `/dashboard/accounting/periods` | ACC-06-app-1440.png | Complete (fixed 2026-09-27) | “By” column (name · Riyadh day) now implemented; was missing. |
| ACC-07 TB → GL drill | [`386:1216`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=386-1216) | `/dashboard/accounting/reports` | ACC-07-app-1440.png, ACC-07-tb-app-1440.png | Complete — layout difference accepted | GL replaces the TB view instead of appearing below it (keeps the table readable at 1024 px). |
| ACC-08 Statements | [`386:1898`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=386-1898) | `/dashboard/accounting/reports (IS / BS / commission tabs)` | ACC-08-is/bs/com-app-1440.png | Complete — layout difference accepted | One statement at a time (switcher) instead of side by side. |
| ACC-09 Automation & policies | [`386:2435`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=386-2435) | `/dashboard/accounting/automation` | ACC-09-app-1440.png | Complete | No “party” column in the events table; policy text bilingual. |
| ACC-10 States | [`387:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=387-2) | `shared states (no permission, view-only, loading, error, empty)` | ACC-10-noperm/viewer-app-1440.png | Complete | — |
| ACC-11 Mobile approval (390 px) | [`387:56`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=387-56) | `/dashboard/accounting/journals/[id] at 390 px` | ACC-11-app-390.png | Complete (keyboard-scroll fix 2026-09-27) | App keeps the audit table below the actions. |

### Page 18 — Payables, bank and cash flow

Page [link](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=392-2) **"18 — Accounting · Payables & Bank"** (`392:2`).
Figma exports and app captures were refreshed on 2026-09-27 from the build under test. The app
captures use the synthetic local fixture, so the figures differ from the design's figures.

| Frame | Figma node (link) | Route | App evidence (`evidence/app/`) | Status | Documented differences |
|---|---|---|---|---|---|
| ACC-20 Supplier bills | [`392:3`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=392-3) | `/dashboard/accounting/payables` | ACC-20-app-1440.png | Complete | The module tab bar wraps to a second row at 1440 px in the app, because the fallback font is wider (see the capture note below). |
| ACC-21 Bill editor | [`394:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=394-2) | `/dashboard/accounting/payables/new` | ACC-21-app-1440.png | Complete | Date inputs use the browser's native format (mm/dd/yyyy in the capture browser) rather than the design's dd/mm/yyyy. Attachments are not implemented (the design shows one). |
| ACC-22 Bill detail | [`395:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=395-2) | `/dashboard/accounting/payables/[id]` | ACC-22-app-1440.png, ACC-22-posted-en-app-1440.png | Complete | The purchase-order link in the design depends on data; the fixture bills have no PO. |
| ACC-23 AP aging + statement | [`395:447`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=395-447) | `/dashboard/accounting/payables/aging` | ACC-23-app-1440.png, ACC-23-statement-app-1440.png | Complete — layout difference accepted | The app shows aging or the statement (switcher) instead of both stacked. |
| ACC-24 Bank-to-ledger | [`397:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=397-2) | `/dashboard/accounting/bank` | ACC-24-app-1440.png | Complete | Categories are listed in code order, not the design's order. |
| ACC-25 Bank ↔ ledger reconciliation | [`397:469`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=397-469) | `/dashboard/accounting/bank?view=reconcile` | ACC-25-app-1440.png | Complete | — |
| ACC-26 Mobile bill approval (390 px) | [`398:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=398-2) | `/dashboard/accounting/payables?status=PENDING` at 390 px | ACC-26-app-390.png | Complete | The fixture has a different number of pending bills than the design. |
| ACC-27 Cash-flow statement | [`399:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=399-2) | `/dashboard/accounting/reports` → Cash flow | ACC-27-app-1440.png, ACC-27-en-app-1440.png, ACC-27-390-app-390.png | Complete | The app shows the account code inside the line label instead of a separate Account column. It omits zero-movement placeholder rows (the design's "12xx" and "3100" rows at 0.00). At 390 px the report switcher wraps onto several rows (segmented controls wrap on narrow screens since 2026-09-28; it previously scrolled sideways). |

| ACC-28 Bank corrections | [`413:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=413-2) (page 18) | `/dashboard/accounting/bank?view=corrections` | ACC-28-app-1440.png, ACC-28-request (capture) · side: `side/ACC-28-side.png` | Complete | Figma frames on page 18 predate the Receivables tab, so their tab row has one tab fewer. |

### Page 19 — Receivables (Stage 3), [`407:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=407-2)

All figures in these frames and in the app captures are synthetic. The frames were drawn first; the app captures use the local fixture, so numbers and document numbers differ (INV-2045 in Figma, INV-1 in the fixture).
Side-by-side images: `evidence/side/ACC-3x-side.png` (Figma left, app right), made by `tests/accounting/visual/side-by-side.mjs`.

| Frame | Figma node (link) | Route | App evidence (`evidence/app/`) | Status | Documented differences |
|---|---|---|---|---|---|
| ACC-30 Sales invoices & credit notes | [`407:3`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=407-3) | `/dashboard/accounting/receivables` | ACC-30-app-1440.png, ACC-30-en-app-1440.png | Complete | App adds "Customer receipts" and "Aging & statements" buttons beside "Sales invoice"; the "Open" column counts a receipt only once its bank line has posted and notes allocations still awaiting posting. |
| ACC-31 Sales invoice editor | [`407:292`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=407-292) | `/dashboard/accounting/receivables/new` (`?order=`, `?edit=`) | ACC-31-app-1440.png | Complete | Quote price and "order will be marked sent" notes appear only when an order is chosen (the capture has none). |
| ACC-32 Invoice detail & approval | [`407:607`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=407-607) | `/dashboard/accounting/receivables/[id]` | ACC-32-app-1440.png (posted), ACC-32-submitted-app-1440.png | Complete | App adds the allocations table, apply-advance and credit-note actions, and the audit trail below the journal. Rejection reason is entered after pressing "Reject". |
| ACC-33 Customer receipts & assignment | [`407:890`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=407-890) | `/dashboard/accounting/receivables/receipts` | ACC-33-app-1440.png, ACC-33-assign-app-1440.png | Complete | Figma shows D-2 set to "at receipt"; the fixture leaves D-2 undecided (the real state), so the app shows "not decided yet" and the advance line is held. The collection row of the Figma allocation table is shown in the app as a "from collection" badge beside the customer. |
| ACC-34 AR aging & customer statement | [`407:1195`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=407-1195) | `/dashboard/accounting/receivables/aging` | ACC-34-app-1440.png | Complete | App adds an "As of" date, a "Credits" column (unapplied credit notes and receipts) and, when advances exist, an advances card (2410 + VAT). The switcher scrolls to the statement card instead of hiding the aging. |
| ACC-35 Credit note | [`407:1470`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=407-1470) | `/dashboard/accounting/receivables/new?creditFor=[id]` | ACC-35-app-1440.png | Complete | Lines start empty (Figma shows two filled lines). |
| ACC-36 Mobile approval (390 px) | [`407:1785`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=407-1785) | `/dashboard/accounting/receivables?status=PENDING` at 390 px | ACC-36-app-390.png | Complete — layout difference accepted | App keeps the module header, tabs and filters above the cards; Figma shows only the cards. Only SUBMITTED documents get approve/reject; an APPROVED one shows its state. |

### Page 20 — Inventory & costing (Stage 4), [`418:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=418-2)

The frames use the hand-worked chain of `tests/accounting/integration/inventory.test.ts`, dated
January–March. The local fixture replays the same chain in August–September, because it closes
January–June and locks July. The **amounts agree** with the frames: valuation 5,041.41;
1171 = 3,470.57; roasting 1,920.00 → 1,834.15 + 85.85; stock card closing 75 units / 798.21.
**Dates and document numbers differ.** Figures are synthetic; the loss bands are test assumptions.
Side by side: `evidence/side/ACC-40..47-side.png`.

| Frame | Figma node (link) | Route | App evidence (`evidence/app/`) | Status | Documented differences |
|---|---|---|---|---|---|
| ACC-40 Valuation | [`418:3`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=418-3) | `/dashboard/accounting/inventory` | ACC-40-app-1440.png, ACC-40-en-app-1440.png | Complete | Tie-out line wraps to two rows; units shown as stored (`kg`, `piece`) rather than the frame's Arabic unit names; rows sorted by kind then code. The D-1 notice states "not decided" (fixture state) where the frame shows the synthetic weighted-average assumption. |
| ACC-41 Documents | [`419:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=419-2) | `/dashboard/accounting/inventory/documents` | ACC-41-app-1440.png | Complete | The frame's "posted · awaiting supplier credit" and "posted · abnormal loss" status variants are shown as the plain posted/provisional badge; the GRNI page carries the awaiting-credit state. The fixture's documents all show "posted provisionally (test)" because D-1 is undecided. |
| ACC-42 Receipt editor | [`419:577`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=419-577) | `/dashboard/accounting/inventory/documents/new` (`?type=`, `?edit=`, `?targetLineId=`, `?billLineId=`) | ACC-42-app-1440.png | Complete | App adds a D-1 notice and a Description field; the unit select shows the conversion ("pack100 (= 100 piece)"); the preview lists account codes without names for inventory accounts; the unit-conversion note of the frame is not shown. |
| ACC-43 Production cost sheet | [`419:1149`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=419-1149) | `/dashboard/accounting/inventory/documents/[id]` | ACC-43-app-1440.png, ACC-43-submitted-app-1440.png | Complete | App adds the cost-moves card and the audit trail; lines table adds a base-quantity column. |
| ACC-44 Stock card | [`420:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=420-2) | `/dashboard/accounting/inventory/stock-card` | ACC-44-app-1440.png | Complete | — |
| ACC-45 GRNI / bill match / landed cost | [`420:557`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=420-557) | `/dashboard/accounting/inventory/grni` | ACC-45-app-1440.png | Complete — layout difference accepted | The frame's bill-match and landed-cost worked cards are on the document detail (ACC-43 layout) instead; this page lists bills without receipt with shortcuts to create them, drafts from operational records, operational agreement and gross margin. The fixture also has a Stage 2 packaging bill with no receipt, so GRNI differs from the frame's 3,033.00. |
| ACC-46 Items, bands, D-1 | [`420:1130`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=420-1130) | `/dashboard/accounting/inventory/setup` | ACC-46-app-1440.png | Complete | Operational links show the linked record's id prefix, not its business code; after the first posting the D-1 selects are disabled with an explanation. |
| ACC-47 Mobile approvals (390 px) | [`422:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=422-2) | `/dashboard/accounting/inventory/documents?status=PENDING` at 390 px | ACC-47-app-390.png | Complete (stage 4b) | The cards now show the frame's loss block (input yield, output, loss %, band, abnormal part), the cost, and the journal rows: posted rows once posted, otherwise the expected accounts labelled "on posting", with no amount shown before it is known. The app keeps the module header, tabs and filters above the cards |

### Page 21 — Accounting · Stage 4b (added 2026-09-28)

The frames were drawn **after** the screens were built (the reverse of the earlier stages'
Figma-first order), from the implemented layout, with synthetic data. They are a record of the
design for review, not a design the code was derived from.

| Frame | Figma node (link) | Route | App evidence | Status | Documented differences |
|---|---|---|---|---|---|
| ACC-48 Exceptions and the operations link | [`425:3`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=425-3) | `/dashboard/accounting/inventory/exceptions` | ACC-48-*.png | Frame after code | The frame shows the operational-events table and the reconciliation together; the app shows one tab at a time (operational events, cost of sales, reconciliation) |
| ACC-49 Customer returns | [`426:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=426-2) | `/dashboard/accounting/inventory/returns` | ACC-49-*.png | Frame after code | The record-a-return form and the receive dialog are not drawn |
| ACC-50 Gross margin with reconciliation | [`426:423`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=426-423) | `/dashboard/accounting/inventory/margin` | ACC-50-app-1440.png | Frame after code | Figures illustrative (synthetic), not the fixture's |
| ACC-51 Conversion-cost pools and absorption | [`426:916`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=426-916) | `/dashboard/accounting/inventory/setup` (pools section) | ACC-51-app-1440.png | Frame after code | The new-pool dialog is not drawn |

| ACC-31b Invoice editor: goods / non-stock, unit, fulfilment location, reissue, credit type | [`427:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=427-2) | `/dashboard/accounting/receivables/new` | ACC-31-app-1440.png | Frame after code | The frame shows three filled lines and the credit-note section together; the app shows the credit-note section only for a credit note |
| ACC-32b Invoice cost-of-sales card and line costing | [`427:459`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=427-459) | `/dashboard/accounting/receivables/[id]` | ACC-32-costing-app-1440.png | Frame after code | Frame shows a blocked invoice; the fixture's captured invoice is awaiting the timing decision |
| ACC-52 Supplier credit note: editor, settlement, application | [`427:862`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=427-862) | `/dashboard/accounting/payables/new?creditFor=…`, `/dashboard/accounting/payables/[id]` | ACC-52-app-1440.png, ACC-53-app-1440.png | Frame after code | Editor and posted state drawn in one frame; the app has them on two screens |
| OPS-01 Production batches with the accounting-status chip | [`427:1326`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=427-1326) | `/dashboard/production` (also purchases, packaging, dispatch) | OPS-production-app-1440.png, OPS-form-*.png | Frame after code | Drawn inside the accounting shell for speed; the app uses the operations sidebar. Reasons show on hover in the app |

### Page 22 — Accounting · Stage 5 (fixed assets, depreciation, year-end), [`430:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=430-2) (added 2026-09-29)

Designed **before** the code (Figma-first), from the Stage 5 design, with synthetic data; the screens
were then built and compared with the frames (captures in `evidence/app/ACC-6*.png`).

| Frame | Figma node (link) | Route | App evidence | Status | Documented differences |
|---|---|---|---|---|---|
| ACC-60 Register and reconciliation with the ledger | [`430:176`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=430-176) | `/dashboard/accounting/assets` | ACC-60-app-1440.png, ACC-60-390 | Figma first → built | App adds an as-of date for the reconciliation and an "unexplained" line; the fixture's differences are larger than the frame's (opening journals on the asset accounts, itemised) |
| ACC-61 Asset: sources, capitalisation by approval, expected schedule | [`430:542`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=430-542) | `/dashboard/accounting/assets/[id]`, `/assets/new` | ACC-61-app-1440.png, ACC-61-editor | Figma first → built | The draft editor is a separate state of the same screen; the posted depreciation lines are listed above the expected schedule |
| ACC-62 Monthly run: compute, approve, post, reverse | [`430:904`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=430-904) | `/dashboard/accounting/assets/runs` | ACC-62-app-1440.png | Figma first → built | The period picker and "compute" sit above the run; the frame shows them in the header |
| ACC-63 Disposal: gain or loss, journal, reversal | [`431:119`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=431-119) | `/dashboard/accounting/assets/[id]` (disposal form and card) | ACC-63-app-1440.png | Figma first → built | The expected-journal table is shown after approval (from the posted figures), not in the form; the form shows an estimated gain or loss |
| ACC-64 Classes and depreciation policy versions | [`431:421`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=431-421) | `/dashboard/accounting/assets/setup` | ACC-64-app-1440.png | Figma first → built | The policy statement is approved on the automation screen (link), as for the other policies |
| ACC-65 Year-end: conditions, closing entry, next-year opening | [`431:759`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=431-759) | `/dashboard/accounting/periods/year-end` | ACC-65-app-1440.png | Figma first → built | The frame shows a year ready to close; the fixture has only the current year, so the capture shows its unmet conditions. The posted state (opening balances table) is exercised in the DB test, not captured |

### Page 23 — Accounting · Stage 6 (e-invoicing local validation, VAT return), [`433:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=433-2) (added 2026-09-29)

Designed **before** the code (Figma-first), with synthetic data; every frame carries the "local
validation only — nothing sent to ZATCA" banner, as the screens do.

| Frame | Figma node (link) | Route | App evidence | Status | Documented differences |
|---|---|---|---|---|---|
| ACC-70 E-invoices: chain and local validation, detail and attempts | [`433:177`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=433-177) | `/dashboard/accounting/tax` | ACC-70-app-1440.png, ACC-70-detail, ACC-70-390 | Figma first → built | App adds a generate/retry action and a buyer-address dialog for documents that failed locally (not drawn); rule list is longer than the frame's sample |
| ACC-71 Seller profile and environment (local only) | [`433:433`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=433-433) | `/dashboard/accounting/tax/profile` | ACC-71-app-1440.png | Figma first → built | Shown as a read-only table once approved; the form appears for a new version |
| ACC-72 VAT return and reconciliation | [`433:757`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=433-757) | `/dashboard/accounting/tax/vat-return` | ACC-72-app-1440.png | Figma first → built | App adds the period pickers, an "unexplained" line and the unclassified-lines warning |

Found by comparing the stage 5–6 screens with their frames and fixed before the tested commit:
English text in the Arabic screens (catch-up note, reconciliation references, account names in the
closing entry, the "not sent" reason) and a disposal form that closed when the server refused it.

Fourth audit (Stage 4, 2026-09-28): ACC-40..47 added to `a11y.mjs`: 0 serious or critical findings
(same scope and caveats as above). Fifth audit (stage 4b): ACC-48..51 (and ACC-48 at 390 px) added: 0 serious or critical findings.
Sixth audit (stages 5–6): ACC-60..62, 64, 65, 70..72 (ACC-60 and ACC-70 also at 390 px) added; result in `TEST_RESULTS.md`.

Figma was synchronised to three implementation decisions: one page title for the module, no branch
selector (the ledger is company-wide; branch is a line dimension), Arabic role labels.
Evidence: `evidence/figma/ACC-*.png` (Figma exports), `evidence/app/ACC-*-app-*.png` (running app).
Capture environment note: the sandbox browser cannot load Tajawal from Google Fonts, so app
captures use a fallback font; spacing/typography comparisons are therefore indicative.
Code Connect was not set up (the Figma file has no published components; frames are auto-layout).

## Accessibility and RTL review (2026-09-27)

Automated audit: `tests/accounting/visual/a11y.mjs` (axe-core, WCAG 2.1 A/AA) over every screen above in
Arabic RTL and English LTR, desktop and 390 px.

| Finding (first run) | Where | Fix (code and Figma) |
|---|---|---|
| Table header text `#6B7280` on `#F3F4F6` = 4.39:1 (46 nodes) | shared Finance kit `Th`, segmented control | `text-gray-600` (≈7:1); Figma header text → `#4B5563` (83 layers) |
| Secondary 11–13 px text `#9CA3AF` on white = 2.53:1 (8) | KPI sub-lines, hints, timeline times | `text-brown` `#6B7280` (4.8:1); Figma 21 layers |
| Red badge / amounts `#E7000B` on `#FFE2E2` = 3.91:1 (4) | “rejected/bad” badge, net-loss amounts | `text-red-700`; Figma 14 layers |
| Horizontally scrolling table not keyboard-focusable (1) | ACC-11 at 390 px | kit `Table` wrapper is focusable with a visible focus ring |
| Sidebar role label `#7C3AED` on `#1F2937` = 2.57:1 (13) | **shared app shell** (`src/app/dashboard/layout.tsx`), not the accounting module | fixed in a separate one-line commit (`4015d3a`, `text-violet-300`), which can be reverted on its own |

The kit fixes also apply to the Finance screens that share the kit.

Second audit (Stage 2 and the cash-flow view, 2026-09-27): ACC-20..27 added to `a11y.mjs`. The
result is 0 serious or critical findings across the 23 audited views. It is an automated
WCAG 2.1 A/AA rule check of the accounting content and the shell around it. It is **not** a
claim that the whole application is accessible, and no manual screen-reader test was done.

Third audit (Stage 3, 2026-09-28): ACC-28 and ACC-30..36 added to `a11y.mjs`: 0 serious or critical
findings over 33 views (same scope and caveats as above).

## Seventh audit (2026-09-29, commit `74d4b03`) — code-first additions, recorded honestly

- **ACC-70 e-invoice detail, "Not standards-compliant — local validation only" notice** (lists the
  standards gaps): added in code **without a Figma frame first**; frame ACC-70 on page 23 does not
  show it yet. Capture: `evidence/app/ACC-70-simplified-gaps.png`.
- **ACC-65 year-end close in the ready, prepared and posted states** on the isolated synthetic
  prior year: the screen is the one designed on page 22 (ACC-65), exercised for the first time in
  these states. Captures `ACC-65-ye-ready`, `-prepared`, `-posted-opening`, `-balance-sheet`. No layout
  change was made; the balance-sheet heading fix (defect 36) is a text change.
