# Figma ↔ application — Accounting

File: https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5 — page **"17 — Accounting · General Ledger"**
(`384:2`), built by cloning the Finance shell (FIN-01) and the Finance card/table/badge styles
(Tajawal; `#7c3aed`; 16 px cards; RTL order). No existing page was modified.

| Frame | Node | Route / component | Status | Documented differences |
|---|---|---|---|---|
| ACC-01 Overview | `384:3` | `/dashboard/accounting` · `page.tsx` | Match, documented differences | Figma shows a date-bounded TB (to 30 Sep); app shows since 1 Jan to today. |
| ACC-02 Journal list | `385:2` | `/dashboard/accounting/journals` | Match, documented differences | App adds a sort selector. |
| ACC-03 Editor (unbalanced) | `385:599` | `/journals/new` · `_components/journal-editor.tsx` | Match | App adds a Branch column (same data as the frame's cost-centre column group). |
| ACC-04 Detail, pending approval | `385:1147` | `/journals/[id]` | Match, documented differences | App shows the entry heading (number, amount, period) above the cards. |
| ACC-05 Chart of accounts | `386:2` | `/dashboard/accounting/accounts` | Match | Role labels in Arabic in both (Figma updated). |
| ACC-06 Periods & closing | `386:637` | `/dashboard/accounting/periods` | **Differs — minor** | App has no "locked by" column (ids only; names not resolved yet). |
| ACC-07 TB → GL drill | `386:1216` | `/dashboard/accounting/reports` | Functional match | The GL replaces the TB view in the app instead of appearing below it. |
| ACC-08 Statements | `386:1898` | `/reports` (views IS / BS) | Functional match | App shows one statement at a time (switcher), Figma side by side. |
| ACC-09 Automation & policies | `386:2435` | `/dashboard/accounting/automation` | Match, documented differences | App has no "party" column in the events table; policy text is bilingual. |
| ACC-10 States | `387:2` | shared states from the Finance kit | Match | |
| ACC-11 Mobile approval | `387:56` | `/journals/[id]` at 390 px | Functional match | Stacked lines + actions as drawn; app keeps the audit table below. |

Figma was synchronised to three implementation decisions: one page title for the module, no branch
selector (the ledger is company-wide; branch is a line dimension), Arabic role labels.
Evidence: `evidence/figma/ACC-*.png` (Figma exports), `evidence/app/ACC-*-app-*.png` (running app).
Capture environment note: the sandbox browser cannot load Tajawal from Google Fonts, so app
captures use a fallback font; spacing/typography comparisons are therefore indicative.
Code Connect was not set up (the Figma file has no published components; frames are auto-layout).
