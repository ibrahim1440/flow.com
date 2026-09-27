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
| ACC-27 Cash-flow statement | [`399:2`](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=399-2) | `/dashboard/accounting/reports` → Cash flow | ACC-27-app-1440.png, ACC-27-en-app-1440.png, ACC-27-390-app-390.png | Complete | The app shows the account code inside the line label instead of a separate Account column. It omits zero-movement placeholder rows (the design's "12xx" and "3100" rows at 0.00). At 390 px the report switcher scrolls sideways inside its own container. |

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
