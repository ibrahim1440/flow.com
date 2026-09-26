# Figma ↔ running ERP — Finance parity (re-verified 2026-09-26)

Figma file: https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/ERP-Design-System--amp--Order-Operations
page **15 — Finance · Cash & Budget** (`node-id=325-2`).

## How this was verified

- App: production build (`npm run build` + `next start -p 3040`) on the local fixture
  (`npm run finance:fixture -- --reset`), captured by `tests/finance/visual/capture.mjs`
  (screens, full content height by growing the viewport — no injected CSS) and
  `tests/finance/visual/states.mjs` (states and breakpoints). Browser: Chrome via Playwright.
  **All viewport sizes are Chrome viewport emulation on a desktop, not physical devices.**
- Figma: frames exported at 1:1 through the Figma API; dialogs exported as the dialog node
  and trimmed of the 32 px shadow bleed.
- `tests/finance/visual/compare.mjs` writes `<id>-side.png` (Figma left, app right). The
  pixel ratio it prints is a coarse signal only — any vertical offset (text wrapping, one
  extra row) propagates down the page — so **every status below comes from reviewing the
  side-by-side**, not from the ratio.

Status vocabulary: **Match** — no difference a reviewer would act on ·
**Match, documented differences** — only the non-material differences listed ·
**Differs — decision needed** — a material difference remains; see §4.

## 1. Screens

| Screen | Figma | Route / how to reach | Viewport | Status | Remaining differences |
|---|---|---|---|---|---|
| Overview | [FIN-01](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=326-2) | `/dashboard/finance` as `fin.manager` | 1440 | Match, documented differences | App cards have slightly more vertical padding (page 1522 px vs 1403 px); shell header date in Arabic-Indic digits (existing shell, §3) |
| Transactions & reconciliation | [FIN-02](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=329-2) | `/dashboard/finance/transactions`, first line opened | 1440 | **Differs — decision D2** | Review panel has sections not in Figma (order suggestions, allocation from this receipt, review note, history); Figma shows the line mid-classification and a filled reconciliation preview, the app shows first review and an empty reconciliation form |
| Cash allocation | [FIN-03](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=331-2) | `/dashboard/finance/allocation` | 1440 | **Differs — decision D3** | App shows a second, all-zero category table for the Café branch and "+ new category" buttons; category card title ("— company level" vs "— September 2026"); footnote about distributable profit only in app |
| Monthly budget & variance | [FIN-04](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=332-2) | `/dashboard/finance/budget` (report date 2026-09-26) | 1440 | **Differs — decision D4** | Toolbar wraps to two rows with an extra "New budget" button; line owner under each line; variance-explanation card uses "View / add explanation" + category chips instead of add/resolve buttons; revision log shows notes |
| Obligations & forecasts | [FIN-05](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=334-2) | `/dashboard/finance/obligations` | 1440 | Match, documented differences | App adds an Export button, a cancel icon per obligation, vendor under the name, "show all" link — additive, same data and layout |
| Reports & settings | [FIN-06](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=335-2) | `/dashboard/finance/reports` | 1440 | **Differs — decision D5** | Account form has more fields (bank, last 4 digits, opening balance and date, restricted) than Figma; branch-access assignment controls and "Add suggested" are not drawn; audit log shows 10 rows + "show more" |
| Approvals dialog | [FIN-07a](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=336-2) | header → Approvals, as `fin.approver` | 1440 | Match, documented differences | Queue order follows the data (budget request first in the app); decision note empty in the app (Figma shows one typed) |
| CSV import preview | [FIN-07b](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=336-36) | Transactions → Import CSV | 1440 | Match, documented differences | Counts differ because the capture imports a 5-row sample (Figma: a 49-row statement); native select/file controls (§3) |
| Payment request (override) | [FIN-07c](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=336-111) | Allocation → Payment request → green coffee + Colombia bill | 1440 | Match, documented differences | Native select and date controls (§3); obligation option also shows its due date |
| Record payment made | [FIN-07d](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=361-6616) | Allocation → open request → "تسجيل الدفع المنفّذ" | 1440 | Match, documented differences | Native select (§3); sample line differs (capture creates its own pending line) |
| States | [FIN-08](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=337-2) | see §2 | 1440 | **Differs — decision D6** | Loading, error, no-permission match. Empty state: app offers one action (Figma two) and shows it to view-only users. Validation: Figma shows an inline "same bank reference already exists" warning that the app does not implement in the dialog (duplicates are flagged after saving) |
| Overview — tablet | [FIN-09](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=337-5712) | `/dashboard/finance` | 1024 | Match, documented differences | As FIN-01; tab strip scrolls horizontally in both |
| Overview — English LTR | [FIN-10](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=338-2) | `/dashboard/finance` as `fin.manager.en` | 1440 | Match, documented differences | As FIN-01 |

## 2. States and the 1024 px breakpoint (Chrome emulation)

`states-manifest.json` records, per capture, `innerWidth`, `document.documentElement.clientWidth`,
the `(min-width: 1024px)` media query, whether the sidebar is on-canvas, whether the menu button
is visible, and horizontal overflow.

| Capture | How it is produced | innerWidth / clientWidth | lg query | Sidebar | Menu button | Page overflow |
|---|---|---|---|---|---|---|
| `STATE-loading-1440` | `/api/finance/**` held open by route interception; real `LoadingState` | 1440 / 1440 | yes | inline | no | no |
| `STATE-error-1440` | HTTP 500 injected on `/api/finance/overview`; real `ErrorState` + retry | 1440 / 1440 | yes | inline | no | no |
| `STATE-empty-1440` | `fin.viewer` (Finance, no branch access) → real empty scope, no interception | 1440 / 1440 | yes | inline | no | no |
| `STATE-validation-dialog` | manual entry, amount `12.345`, empty date → both field errors, nothing sent | 1440 / 1440 | yes | — | — | no |
| `STATE-validation-future-confirmed` | manual entry, CONFIRMED dated 2030-01-01 → refused, "record it as pending" | 1440 / 1440 | yes | — | — | no |
| `STATE-noperm-1440` | `no.finance` (no Finance module) → shell no-permission; API 403 in `tests/finance/http` | 1440 / 1440 | yes | inline | no | no |
| `BP-1023` | overview just below the breakpoint | 1023 / 1023 | **no** | off-canvas | **yes** | no |
| `BP-1023-drawer-open` | menu button pressed | 1023 / 1023 | no | overlay drawer with close button and backdrop | yes | no |
| `BP-1024` | at the breakpoint | 1024 / 1024 | **yes** | inline | no | no |
| `BP-1025` | just above | 1025 / 1025 | yes | inline | no | no |
| `BP-1023-budget`, `BP-1025-budget` | widest table screen either side | 1023 / 1025 | no / yes | off / inline | yes / no | no (the table scrolls inside its card) |

`clientWidth` equals `innerWidth` because the document itself never scrolls — the shell scrolls
inside `<main>` — so a classic desktop scrollbar does not shift the breakpoint. (An earlier
version of this document said the 1024 capture fell below `lg` because of a scrollbar; that was
an artifact of the old capture's injected stylesheet and was wrong.)

## 3. Typography, RTL and platform differences (documented, not changed)

- **Font:** frames and app both use Tajawal (the font the app loads). Figma's text styles in
  this file are Noto Sans; the Finance frames override them deliberately.
- **Digits:** Finance renders Latin digits in Arabic, as the sales branch's audit decided.
  The **existing shell** (header date) renders Arabic-Indic digits on `origin/main`; the sales
  branch fixes it in its shell, `feature/ui-ux-alignment` does not (see SALES_INTEGRATION.md).
- **Signed numbers:** the app wraps signed amounts in LTR isolates (U+2066/U+2069), so "−450.00"
  reads correctly inside Arabic sentences. Figma ignores isolates, so a few negative values
  inside Arabic text render with a trailing minus in the frames. Figma limitation.
- **Native controls:** `<select>`, `<input type=date>` and `<input type=file>` render the
  browser's chevron, `mm/dd/yyyy` placeholder (from the browser UI locale, not the page) and
  "Choose file" label. Implementation limitation of native controls; replacing them with custom
  widgets is decision D7.
- **Server error text** is English (e.g. validation messages from the API) and appears as-is
  inside the Arabic error card's detail line; the headline and guidance are localised.

## 4. Decisions needed from the product owner

| # | Question | Current app behaviour | Options |
|---|---|---|---|
| D1 | Pending **outgoing** lines reduce eligible cash (changed 2026-09-26 to stop a recorded payment freeing the same cash twice) | eligible = confirmed unrestricted cash − pending outflows; pending inflows still not counted | confirm (Figma already updated) / revert and block payment recording against pending lines instead |
| D2 | Transactions review panel content | full panel (suggestions, allocation from receipt, note, history) | redraw Figma to the app / simplify the app |
| D3 | Empty branch category tables in "all branches" | every branch's table shown, even all zero | keep / collapse empty branches / show only on request |
| D4 | Budget toolbar and variance-explanation card | two-row toolbar with "New budget"; explanation via "view / add" | redraw Figma / move "New budget" into the month selector |
| D5 | Settings forms (account fields, branch access, suggested categories) | implemented, not drawn | redraw Figma (recommended — the app reflects the requirements) |
| D6 | Empty-state second action; inline duplicate-reference warning in manual entry | one action; duplicate flagged after save | add both to the app / remove from Figma |
| D7 | Native form controls | native | accept / build custom select and date picker (applies ERP-wide, not only Finance) |

## 5. Figma changes made after implementation

| When | Frame(s) | Change | Classification |
|---|---|---|---|
| first pass | FIN-01/07a | approvals badge 0 for a preparer | Design error (the preparer cannot decide their own requests) |
| first pass | FIN-01/06 | accounts ordered by code | Design error |
| first pass | FIN-01 | full category names in alerts | Design error |
| first pass | FIN-05 | 45 → 33 expected-receipt items | Design data error |
| first pass | FIN-03 | "run on receipt" button removed (the action lives in the transaction review panel) | Design aligned to an implementation decision — accept or reopen with D2 |
| first pass | FIN-03 | Café pool card added | Design omission |
| first pass | FIN-06 | accounts setup card added; categories list 6 rows + "+11" | Design omission / implementation limitation (long lists collapsed) |
| first pass | FIN-08 | no-permission wording aligned to the existing shell | Implementation limitation (shell not changed by this work) |
| first pass | FIN-01/09/10 | chart plot rebuilt; header spacer fixed | Design drawing errors |
| 2026-09-26 | all | 173 placeholder icon squares replaced by the lucide icons the app renders (same colour, size, stroke) | Design completion (placeholders were intentional stand-ins) |
| 2026-09-26 | FIN-07c | subtitle "…until the payment made is recorded (the app sends no money)" — app changed identically | Product wording change requested in review ("Execute payment" implied sending money) |
| 2026-09-26 | FIN-07d (new, `361:6616`) | "Record payment made" dialog added | Design omission of an implemented dialog, drawn after the rename |
| 2026-09-26 | FIN-01/03/09/10 | eligible and unallocated figures (−450.00) and the pending-lines sentence | **Implementation behaviour change** (D1), not a design error |
| 2026-09-26 | FIN-02 | class labels "تحويل بين حسابات الشركة", "تسوية نقاط البيع (صافي الرسوم)" | Design used outdated labels |
| 2026-09-26 | FIN-07b | "confirms a recorded line" count box and footnote | New behaviour (statement matching) added after the design |

App changes made during this comparison: pending-lines copy corrected (it said "not counted"
for outflows that are now deducted); missing-date validation added to manual entry; "Close" →
"Cancel" before submitting in the payment-request and transfer dialogs; the outgoing-line picker
formats amounts ("−4,800.00" instead of "-4800").

## 6. Evidence index

All images are in this repository and contain only fixture data (fictional names, no
credentials). Paths are relative to `docs/finance/`.

| Id | Figma export | App capture | Side-by-side (Figma left, app right) |
|---|---|---|---|
| FIN-01 | [FIN-01-figma.png](parity/FIN-01-figma.png) | [FIN-01-app-1440.png](parity/FIN-01-app-1440.png) | [FIN-01-side.png](parity/FIN-01-side.png) |
| FIN-02 | [FIN-02-figma.png](parity/FIN-02-figma.png) | [FIN-02-app-1440.png](parity/FIN-02-app-1440.png) | [FIN-02-side.png](parity/FIN-02-side.png) |
| FIN-03 | [FIN-03-figma.png](parity/FIN-03-figma.png) | [FIN-03-app-1440.png](parity/FIN-03-app-1440.png) | [FIN-03-side.png](parity/FIN-03-side.png) |
| FIN-04 | [FIN-04-figma.png](parity/FIN-04-figma.png) | [FIN-04-app-1440.png](parity/FIN-04-app-1440.png) | [FIN-04-side.png](parity/FIN-04-side.png) |
| FIN-05 | [FIN-05-figma.png](parity/FIN-05-figma.png) | [FIN-05-app-1440.png](parity/FIN-05-app-1440.png) | [FIN-05-side.png](parity/FIN-05-side.png) |
| FIN-06 | [FIN-06-figma.png](parity/FIN-06-figma.png) | [FIN-06-app-1440.png](parity/FIN-06-app-1440.png) | [FIN-06-side.png](parity/FIN-06-side.png) |
| FIN-07a | [FIN-07a-figma.png](parity/FIN-07a-figma.png) | [FIN-07a-app-1440.png](parity/FIN-07a-app-1440.png) | [FIN-07a-side.png](parity/FIN-07a-side.png) |
| FIN-07b | [FIN-07b-figma.png](parity/FIN-07b-figma.png) | [FIN-07b-app-1440.png](parity/FIN-07b-app-1440.png) | [FIN-07b-side.png](parity/FIN-07b-side.png) |
| FIN-07c | [FIN-07c-figma.png](parity/FIN-07c-figma.png) | [FIN-07c-app-1440.png](parity/FIN-07c-app-1440.png) | [FIN-07c-side.png](parity/FIN-07c-side.png) |
| FIN-07d | [FIN-07d-figma.png](parity/FIN-07d-figma.png) | [FIN-07d-app-1440.png](parity/FIN-07d-app-1440.png) | [FIN-07d-side.png](parity/FIN-07d-side.png) |
| FIN-08 | [FIN-08-figma.png](parity/FIN-08-figma.png) | [no-permission](parity/FIN-08-noperm-app-1440.png) · [loading](evidence/states/STATE-loading-1440.png) · [empty](evidence/states/STATE-empty-1440.png) · [error](evidence/states/STATE-error-1440.png) · [validation](evidence/states/STATE-validation-dialog.png) · [future-dated](evidence/states/STATE-validation-future-confirmed.png) | — (five panels vs five captures) |
| FIN-09 | [FIN-09-figma.png](parity/FIN-09-figma.png) | [FIN-09-app-1024.png](parity/FIN-09-app-1024.png) | [FIN-09-side.png](parity/FIN-09-side.png) |
| FIN-10 | [FIN-10-figma.png](parity/FIN-10-figma.png) | [FIN-10-app-1440.png](parity/FIN-10-app-1440.png) | [FIN-10-side.png](parity/FIN-10-side.png) |
| Breakpoint | — | [1023](evidence/states/BP-1023.png) · [1023 drawer](evidence/states/BP-1023-drawer-open.png) · [1024](evidence/states/BP-1024.png) · [1025](evidence/states/BP-1025.png) · [budget 1023](evidence/states/BP-1023-budget.png) · [budget 1025](evidence/states/BP-1025-budget.png) | [manifest](evidence/states/states-manifest.json) |
| Workflow | — | [allocated](evidence/workflow/wf-1-allocated.png) · [budget submitted](evidence/workflow/wf-2-submitted.png) · [payment recorded](evidence/workflow/wf-3-executed.png) · [statement preview: 1 confirms, 0 new](evidence/workflow/wf-3b-statement-preview.png) · [line confirmed by statement](evidence/workflow/wf-3c-statement-confirmed.png) · [budget actual 57,700.00](evidence/workflow/wf-4-report.png) | — |

Text descriptions for readers who cannot view the images: each `*-side.png` places the Figma
frame on the left and the running app on the right at the same width; §1 lists, per screen, the
differences a reviewer would see. `wf-3b` shows the import preview with "confirms a recorded
line: 1" and "new: 0"; `wf-3c` shows the payment line with the notice "confirmed by the bank
statement on 2026-09-26 (no new line created)"; `wf-4` shows green-coffee payments of 57,700.00
(26,500 + 31,200 counted once).

Regenerate: `npm run finance:fixture -- --reset`, then `node tests/finance/visual/capture.mjs
<dir>` / `states.mjs <dir>` (with `FIN_PASSWORD` from `.env`), export the frames above at 1:1,
and `node tests/finance/visual/compare.mjs <dir> FIN-01:FIN-01-app-1440.png … FIN-07a:FIN-07a-app-1440.png:32 …`.
