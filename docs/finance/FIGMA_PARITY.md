# Figma ↔ running ERP — Finance parity (closure pass, 2026-09-26)

Figma file: https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/ERP-Design-System--amp--Order-Operations
page **15 — Finance · Cash & Budget** (`node-id=325-2`).

## How this was verified

- App: production build (`npm run build` + `next start -p 3040`) on the local fixture
  (`npm run finance:fixture -- --reset`), captured by `tests/finance/visual/capture.mjs`
  (screens, in the states drawn in Figma, full height by growing the viewport — no injected
  CSS) and `tests/finance/visual/states.mjs` (states and breakpoints). Browser: Chrome via
  Playwright. **All viewport sizes are Chrome viewport emulation on a desktop, not devices.**
- Figma: frames exported at 1:1 through the Figma API; dialogs as the dialog node, trimmed of
  the 32 px shadow bleed.
- `tests/finance/visual/compare.mjs` writes `<id>-side.png` (Figma left, app right). The pixel
  ratio is a coarse signal; **every status comes from reviewing the side-by-side** and, for
  layout, from measured block geometry (Figma node bounds vs DOM rectangles).

Status vocabulary: **Match** · **Match, documented differences** (only non-material ones) ·
**Differs — decision needed** (a material difference remains; see DECISIONS.md). A screen is
not marked Match while a material difference is open.

## 1. Screens

| Screen | Figma | Route | Viewport | Height Figma / app | Status | Remaining differences |
|---|---|---|---|---|---|---|
| Overview | [FIN-01](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=326-2) | `/dashboard/finance` (`fin.manager`) | 1440 | 1403 / 1404 | Match, documented differences | Blocks within 1–4 px of the frame after the typography fix; shell header (existing code) 3 px taller and uses Arabic-Indic digits |
| Transactions & reconciliation | [FIN-02](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=329-2) | `/dashboard/finance/transactions` | 1440 | 1231 / 1498 | **Differs — D2** | Review panel sections not drawn (suggestions, allocation from receipt, note, history) |
| Cash allocation | [FIN-03](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=331-2) | `/dashboard/finance/allocation` | 1440 | 1786 / 1824 | **Differs — D3a/D3b** | "+ new category" button; profit footnote |
| Monthly budget & variance | [FIN-04](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=332-2) | `/dashboard/finance/budget` | 1440 | 2082 / 2234 | **Differs — D4a** | Owner and "may be incomplete" under lines (D4b closed: frame corrected to the permission policy) |
| Obligations & forecasts | [FIN-05](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=334-2) | `/dashboard/finance/obligations` | 1440 | 1384 / 1616 | **Differs — D5** | Cancel per obligation, counterparty, show-all, Export |
| Reports & settings | [FIN-06](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=335-2) | `/dashboard/finance/reports` | 1440 | 1865 / 2369 | **Differs — D6** | Account, branch-access and category forms not drawn |
| Approvals dialog | [FIN-07a](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=336-2) | header → Approvals (`fin.approver`) | 1440 | 434 / 486 | Match, documented differences | Queue order follows the data |
| CSV import preview | [FIN-07b](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=336-36) | Transactions → Import CSV | 1440 | 541 / 544 | Match, documented differences | Native select/file controls per ERP convention (D7); counts reflect a 5-row sample |
| Payment request | [FIN-07c](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=336-111) | Allocation → Payment request | 1440 | 574 / 576 | Match, documented differences | Native select/date controls per ERP convention (D7) |
| Record payment made | [FIN-07d](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=361-6616) | Allocation → open request | 1440 | 236 / 241 | Match, documented differences | Native select per ERP convention (D7) |
| States | [FIN-08](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=337-2) | §2 | 1440 | — | Match, documented differences | All five panels match (both set-up actions for a user who can set up; inline duplicate-reference warning); a view-only user sees no set-up actions, per FIN-08's own rule |
| Overview — tablet | [FIN-09](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=337-5712) | `/dashboard/finance` | 1024 | 2282 / 2255 | Match, documented differences | As FIN-01 |
| Overview — English | [FIN-10](https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/?node-id=338-2) | `/dashboard/finance` (`fin.manager.en`) | 1440 | 1403 / 1404 | Match, documented differences | As FIN-01 |

## 2. States and the 1024 px breakpoint (Chrome emulation)

`evidence/states/states-manifest.json` records per capture: `innerWidth`,
`documentElement.clientWidth`, the `(min-width: 1024px)` query, sidebar on-canvas, menu button
visible, horizontal overflow.

| Capture | How it is produced | Result |
|---|---|---|
| `STATE-loading-1440` | `/api/finance/**` held open by route interception | real LoadingState (skeleton + "loading finance data") as FIN-08 |
| `STATE-error-1440` | HTTP 500 injected on `/api/finance/overview` | real ErrorState with retry, as FIN-08 |
| `STATE-empty-setup-1440` | real APIs: the pre-Finance admin grants `new.preparer` settings duties; the Finance manager gives them a new branch with no accounts | both set-up actions, as FIN-08 |
| `STATE-empty-1440` | `fin.viewer` (Finance, no branch access) | empty state without set-up actions (cannot set up) |
| `STATE-validation-dialog` | amount `12.345`, empty date | both field errors; nothing sent |
| `STATE-validation-future-confirmed` | CONFIRMED dated 2030-01-01, SNB-CUR, reference TRF88213 | future-date refusal and the inline "same reference on this account — saved and flagged" warning, as FIN-08 |
| `STATE-noperm-1440` | `no.finance` | shell no-permission; API 403 (`tests/finance/http`) |
| `BP-1023` / `BP-1023-drawer-open` | 1023 px | `lg` false; sidebar off-canvas; menu button opens an overlay drawer; no overflow |
| `BP-1024` / `BP-1025` | 1024 / 1025 px | `lg` true; sidebar inline; no overflow |
| `BP-1023-budget` / `BP-1025-budget` | widest table screen | table scrolls inside its card; no page overflow |

`clientWidth` = `innerWidth` in every capture: the document never scrolls (`<main>` does), so a
classic scrollbar cannot move the breakpoint.

## 3. Typography, RTL and platform

- **Line height (fixed):** the frames use Figma "Auto", which renders Tajawal at 1.2× the font
  size (11→13, 12→14, 13→16, 14→17, 15→18, 20→24, 24→29 px, measured). The app inherited
  Tailwind's 1.5; `src/app/dashboard/finance/finance.css` now applies 1.2 inside the Finance
  root. FIN-01 geometry after the fix (Figma / app, px): tabs 43/43, KPI cards 89/88, alerts
  498/501, chart 354/358, categories 357/355, footnote y 1319/1320.
- **Digits:** Latin in Finance (sales audit decision). The existing shell's header date uses
  Arabic-Indic digits on `origin/main`; the sales branch's shell fixes it.
- **Signed numbers:** LTR isolates in the app; Figma ignores isolates (a few negatives render
  with a trailing minus in the frames) — Figma limitation.
- **Native controls:** the ERP convention (D7 — closed): native `<select>`, date and file inputs everywhere; the frames draw stylised controls and are not redrawn.
- **Server error text** is English inside the localised error card (detail line only).

## 4. Decisions

See **[DECISIONS.md](DECISIONS.md)** — each with Figma and app crops, the exact difference, the effect
on the user, a recommendation and what it changes. Open: D2, D3a, D3b, D4a, D5, D6. Closed: D4b
(design corrected to the permission policy), D7 (ERP convention).

## 5. Changes made after implementation

Figma (every change, with its classification):

| When | Frame(s) | Change | Classification |
|---|---|---|---|
| first pass | FIN-01/07a | approvals badge 0 for a preparer | Design error |
| first pass | FIN-01/06 | accounts ordered by code | Design error |
| first pass | FIN-01 | full category names in alerts | Design error |
| first pass | FIN-05 | 45 → 33 expected-receipt items | Design data error |
| first pass | FIN-03 | "run on receipt" button removed | Aligned to an implementation decision (action lives in the review panel) |
| first pass | FIN-03 | Café pool card | Design omission |
| first pass | FIN-06 | accounts card; categories list 6 rows + "+11" | Design omission / list collapsing |
| first pass | FIN-08 | no-permission wording = existing shell | Implementation limitation (shell unchanged) |
| first pass | FIN-01/09/10 | chart plot rebuilt; header spacer | Design drawing errors |
| 2026-09-26 | all | 173 placeholder icon squares → the lucide icons the app renders | Design completion |
| 2026-09-26 | FIN-07c | subtitle: "…until the payment made is recorded (the app sends no money)" | Wording change from review (app changed identically) |
| 2026-09-26 | FIN-07d (new) | "Record payment made" dialog | Design omission |
| 2026-09-26 | FIN-02 | class labels "تحويل بين حسابات الشركة", "تسوية نقاط البيع (صافي الرسوم)" | Design used outdated labels |
| 2026-09-26 | FIN-07b | "confirms a recorded line" box and footnote | New behaviour after the design |
| 2026-09-26 | FIN-01/03/09/10 | figures briefly set to the first D1 rule (−450.00), then **restored to the original values** when the final D1 rule was adopted | Business-rule change (D1); no net change to those figures |
| 2026-09-26 | FIN-04 | "إغلاق الفترة" removed from the preparer toolbar (D4b) | Design error: the frame contradicted the permission policy |
| 2026-09-26 | FIN-03 | pending sentence split: "pending out deducted: 0.00" and "pending out awaiting review (not deducted yet): 450.00" | Business-rule change (D1) |

Application (aligned to the design — no Figma change):

| Change | Screens |
|---|---|
| Line height 1.2 inside Finance (Figma Auto) | all |
| Multi-branch view omits branches whose categories never held money; single table titled by month | FIN-03 |
| One-row toolbar; "new budget" moved into the month selector | FIN-04 |
| Variance card: "add explanation" + "mark resolved" as drawn | FIN-04 |
| Empty state: both set-up actions, for users who can set up | FIN-08 |
| Manual entry: inline duplicate-reference warning | FIN-08 |
| "Close" → "Cancel" before submitting; outgoing-line picker formats amounts; missing-date validation; pending-lines copy | FIN-07c/07d/08/03 |

## 6. Evidence index

All images contain only fixture data (fictional names, no credentials). Paths relative to
`docs/finance/`.

| Id | Figma export | App capture | Side-by-side (Figma left, app right) |
|---|---|---|---|
| FIN-01 | [figma](parity/FIN-01-figma.png) | [app](parity/FIN-01-app-1440.png) | [side](parity/FIN-01-side.png) |
| FIN-02 | [figma](parity/FIN-02-figma.png) | [app](parity/FIN-02-app-1440.png) | [side](parity/FIN-02-side.png) |
| FIN-03 | [figma](parity/FIN-03-figma.png) | [app](parity/FIN-03-app-1440.png) | [side](parity/FIN-03-side.png) |
| FIN-04 | [figma](parity/FIN-04-figma.png) | [app](parity/FIN-04-app-1440.png) | [side](parity/FIN-04-side.png) |
| FIN-05 | [figma](parity/FIN-05-figma.png) | [app](parity/FIN-05-app-1440.png) | [side](parity/FIN-05-side.png) |
| FIN-06 | [figma](parity/FIN-06-figma.png) | [app](parity/FIN-06-app-1440.png) | [side](parity/FIN-06-side.png) |
| FIN-07a | [figma](parity/FIN-07a-figma.png) | [app](parity/FIN-07a-app-1440.png) | [side](parity/FIN-07a-side.png) |
| FIN-07b | [figma](parity/FIN-07b-figma.png) | [app](parity/FIN-07b-app-1440.png) | [side](parity/FIN-07b-side.png) |
| FIN-07c | [figma](parity/FIN-07c-figma.png) | [app](parity/FIN-07c-app-1440.png) | [side](parity/FIN-07c-side.png) |
| FIN-07d | [figma](parity/FIN-07d-figma.png) | [app](parity/FIN-07d-app-1440.png) | [side](parity/FIN-07d-side.png) |
| FIN-08 | [figma](parity/FIN-08-figma.png) | [no-permission](parity/FIN-08-noperm-app-1440.png) · [loading](evidence/states/STATE-loading-1440.png) · [empty (can set up)](evidence/states/STATE-empty-setup-1440.png) · [empty (view only)](evidence/states/STATE-empty-1440.png) · [error](evidence/states/STATE-error-1440.png) · [validation](evidence/states/STATE-validation-dialog.png) · [future date + duplicate reference](evidence/states/STATE-validation-future-confirmed.png) | — |
| FIN-09 | [figma](parity/FIN-09-figma.png) | [app](parity/FIN-09-app-1024.png) | [side](parity/FIN-09-side.png) |
| FIN-10 | [figma](parity/FIN-10-figma.png) | [app](parity/FIN-10-app-1440.png) | [side](parity/FIN-10-side.png) |
| Breakpoint | — | [1023](evidence/states/BP-1023.png) · [drawer](evidence/states/BP-1023-drawer-open.png) · [1024](evidence/states/BP-1024.png) · [1025](evidence/states/BP-1025.png) · [budget 1023](evidence/states/BP-1023-budget.png) · [budget 1025](evidence/states/BP-1025-budget.png) | [manifest](evidence/states/states-manifest.json) |
| Workflow | — | [allocated](evidence/workflow/wf-1-allocated.png) · [submitted](evidence/workflow/wf-2-submitted.png) · [payment recorded](evidence/workflow/wf-3-executed.png) · [statement preview](evidence/workflow/wf-3b-statement-preview.png) · [confirmed by statement](evidence/workflow/wf-3c-statement-confirmed.png) · [actual once](evidence/workflow/wf-4-report.png) | — |
| Decisions | [DECISIONS.md](DECISIONS.md) — matched Figma/app crops per decision | | |

Text alternative: each side-by-side places the frame left and the running app right at the same
width; §1 lists what differs per screen; DECISIONS.md describes each remaining difference in words.
