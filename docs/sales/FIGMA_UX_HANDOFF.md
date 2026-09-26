# Figma / UX Handoff — **FIGMA_IN_PROGRESS**

## Status: connectivity works, initial designs exist, the deliverable is **not** complete.

The previous version of this document said `FIGMA_BLOCKED` and stated there was no Figma file,
no prototype and no frame links. All three of those statements are now false and have been
replaced. What has **not** changed is that this is still an open deliverable: the design covers
every route at desktop, but not every route at every breakpoint, and none of it has been
through design review or user acceptance.

**All fourteen designed routes have now been implemented against their frames and compared
capture-to-frame at 1440, 1024 and 390** — see §6 for the route-by-route result and the list of
deliberate deviations, and §7b for how the comparison was made.

Two things are **not** done, and neither is an implementation gap:

- **The hosted Preview does not contain this work.** `git push` is refused by the current
  session's permission classifier; nothing was routed around it. §7c.
- **The printed quotation has no VAT registration numbers**, because the schema has no field
  for them. A Saudi tax document needs them. §6.

Read the status line precisely. **In progress is not done.**

---

## 1. Connection — what is actually true now

| Check | Result |
|---|---|
| Is the Figma connector reachable? | **Yes.** The claude.ai Figma web connector (`Figma`, 40 tools) is `connected`. |
| Did a real Figma call succeed? | **Yes.** `whoami` returned the account, and every design below was written through `use_figma`. |
| Can it write native canvas content? | **Yes — demonstrated, not assumed.** Pages, component sets, variants, variable bindings, text styles and prototype reactions were all created through the API. |
| Which seat? | The file sits on the **Hiqbah ERP** plan (`team::1650589810646679944`), where the account holds a **Full** seat. Two other plans on the account hold **View** seats only and cannot be written to. |
| What about `plugin:marketing:figma`? | Still `needs_auth`. It is a **separate, unauthenticated plugin server** and is not what serves these tools. The earlier "unauthenticated, only `authenticate` exposed" finding described *that* server. |

The old §1/§2 OAuth narrative is obsolete and has been deleted rather than left to mislead.

---

## 2. The file

**ERP Design System & Order Operations** — `CYWypOA4538FYoTDUdGyP5`

https://www.figma.com/design/CYWypOA4538FYoTDUdGyP5/ERP-Design-System--amp--Order-Operations

Three pages were added. Nothing existing was renumbered, moved or edited.

| Page | Node | Contents |
|---|---|---|
| `10 — Sales CRM Components` | `229:2` | 4 component sets, 38 variants |
| `11 — Sales CRM Screens` | `229:3` | 14 route frames, 6 modals, states board, 6 responsive frames, rationale panel |
| `12 — Sales CRM Prototype` | `229:4` | 19 frames, 48 wired reactions, 3 flow starting points |

> **Reading the file:** `get_metadata` with no `nodeId` returns only the Cover page. That is a
> partial result, not the file structure. Enumerate pages with a read-only `use_figma` over
> `figma.root.children`, then address pages by id.

---

## 3. Route → frame coverage (all 14 routes)

Shared frames are listed where one frame genuinely covers the route. Every link is
`…/ERP-Design-System--amp--Order-Operations?node-id=<id>` with colons written as dashes.

| # | Route | Desktop AR | Tablet 1024 | Mobile 390 | Interactions |
|---|---|---|---|---|---|
| 1 | `/dashboard/sales/leads` | **SC-02** `239:21` | **T-01** `262:294` | **MB-01** `263:341` | M-01 `261:291`, M-02 `261:335`, M-03 `261:355` |
| 2 | `/dashboard/sales/pipeline` | **SC-03** `250:113` | — | — | outcome badge over stage |
| 3 | `/dashboard/sales/deals/[id]` | **SC-04** `251:141` | — | — | M-04 `261:374`, M-05 `261:400` |
| 4 | `/dashboard/sales/quotes` | **SC-05** `255:194` | — | — | row actions per status |
| 5 | `/dashboard/sales/quotes/[id]` — DRAFT | **SC-06** `254:188` | **T-03** `262:449` | **MB-03** `263:458` | discount-approval gate |
| 6 | `/dashboard/sales/quotes/[id]` — ISSUED and after | **SC-07** `255:368` | — | — | revision history |
| 7 | `/dashboard/sales/quotes/[id]/print` | **SC-08** `257:260` (A4, no chrome) | n/a | n/a | print layout only |
| 8 | `/dashboard/sales/activities` | **SC-09** `257:333` | — | — | complete / overdue |
| 9 | `/dashboard/sales/targets` | **SC-10** `257:438` | — | — | attainment bars |
| 10 | `/dashboard/sales/reports` | **SC-11** `258:269` | — | — | KPI tiles + funnel |
| 11 | `/dashboard/sales/settings` | **SC-12** `258:324` | — | — | stages, sources, discount limits |
| 12 | `/dashboard/sales/my-commissions` | **SC-01** `236:2` | **T-02** `262:379` | **MB-02** `263:412` | expandable calculation |
| 13 | `/dashboard/commissions/plans` | **SC-13** `256:255` | — | — | versions + assignment |
| 14 | `/dashboard/commissions/review` | **SC-14** `253:181` | — | — | M-06 `261:414` |

**Desktop coverage: 14 / 14.** Responsive coverage is by **pattern**, mapped route by route on
board **RM** `273:420`. Five patterns are drawn at both 1024 and 390, and every non-print route
is assigned to one, with its state behaviour and recovery action named per route:

| Pattern | Tablet 1024 | Mobile 390 | Routes covered |
|---|---|---|---|
| P1 · filterable list | `262:294` | `263:341` | leads, quotes, activities, targets, plans, review, settings |
| P2 · record detail | `272:370` | `272:434` | deals/[id], quotes/[id] |
| P3 · line-item editor | `262:449` | `263:458` | quotes/[id] while DRAFT |
| P4 · statement & figures | `262:379` | `263:412` | my-commissions, reports |
| P5 · stage board → accordion | `272:498` | `272:569` | pipeline |

`quotes/[id]/print` is an A4 document and correctly has no phone or tablet canvas.

This is a mapping, not a promise: each pattern exists as a drawn frame at both widths, and the
mapping states what reflows (horizontal table → stacked cards, stepper → vertical list, columns
→ collapsible sections). What it does **not** yet include is a per-route drawn frame for the
eleven routes that inherit a pattern rather than having their own — a reviewer checking, say,
`targets` at 390px is reading P1 plus the mapping row, not a `targets`-specific canvas.

Screen states are defined **once** on a shared board — **ST** `260:275` — covering loading,
empty, error, permission-denied and input validation, and are intended to apply to all
fourteen with the same behaviour rather than being redrawn per screen.

### Components added (page 10)

| Set | Node | Variants | Stored enum |
|---|---|---|---|
| Sales / Lead Status Badge | `232:54` | 10 | `LeadStatus` (5) × Dir |
| Sales / Quote Status Badge | `234:90` | 12 | `QuoteStatus` (6) × Dir |
| Sales / Commission Accrual Badge | `235:106` | 10 | `AccrualStatus` (5) × Dir |
| Sales / Deal Outcome Badge | `235:135` | 6 | `OpportunityOutcome` (3) × Dir |

These are **separate from** the Order `Status Badge` (`34:51`), whose description pins it to the
eight order statuses. Widening its axis to 24 unrelated values across four domains would break
its contract and pollute every existing instance. Zero existing components were modified, and
no variables or text styles were added — the file still reads 4 collections / 76 variables /
18 text styles / 3 effect styles.

---

## 4. Prototype — three journeys

https://www.figma.com/proto/CYWypOA4538FYoTDUdGyP5/ERP-Design-System--amp--Order-Operations?node-id=264-62

48 reactions, **0 unresolved destinations**, 3 flow starting points. Navigation and primary
actions are wired to the real buttons, not screen-to-screen shells; each full screen carries a
working nav bar.

| Flow | Start | Path |
|---|---|---|
| أ · lead → order | `264:62` | leads → create → duplicate → list → convert → deal → quote → approved quote → order created |
| ب · lost → reopen | `264:675` | deal → mark lost (reason required) → lost state → reopen → reopened |
| ج · plan → accrual → review | `264:955` | plans/assignment → accrual explanation → review → adjustment → after |

Journey أ ends at an explicit handoff frame: the order enters the **frozen** Order Preparation
path on page `08`, which Sales does not own past that point.

---

## 5. Findings the design corrected

These were real defects in the first design pass, found by reading the implementation:

1. **`AccrualStatus.PREVIEW` is never written.** Accruals are created directly as `ACCRUED`
   (`accrual.ts:299`), then `APPROVED` (`:391`), then `PAID`. An earlier frame showed a
   PREVIEW accrual as an ordinary state. The variant still exists because the enum value does,
   but SC-01's legend now states plainly that this build never produces it.
2. **The statement comes from the ledger, not the accrual rows.**
   `accrued = Σ ACCRUAL + Σ REVERSAL`, `adjustments = Σ ADJUSTMENT`, `paid = Σ PAYOUT`,
   `outstanding = accrued + adjustments − paid`. An earlier frame showed cards summing to 1,530
   under a headline of 6,120. SC-01 now reconciles exactly: 1,150 + 180 + 200 = 1,530 accrued,
   200 paid, 1,330 outstanding, with the ledger shown beneath it.
3. **A paid amount is part of accrued, not additional to it.** Stated explicitly on the screen,
   because adding the two is the obvious way to read a four-figure strip wrongly.
4. **Overdue scope.** `overdue` counts loaded rows — i.e. after search and filtering — with a
   `nextFollowUpAt` in the past, excluding `CONVERTED`. A lead with *no* follow-up date is not
   overdue. An earlier frame claimed 4 overdue against example rows containing 1.
5. **Leads missing search, filters and row actions.** The implementation has all three; the
   first frame omitted them.

---

## 6. Design vs code — route by route

Every route below was compared the same way: the Figma frame was read with
`get_design_context` / `get_screenshot`, the **real component** was rendered in the harness at
the same content width with fixtures carrying the frame's own content, and the two were put
side by side. The captures live in `tests/harness/shots/` (`<route>.png` at 1440,
`<route>-tablet.png` at 1024, `<route>-mobile.png` at 390) and are regenerated by
`node tests/harness/shoot-all.mjs <width> [suffix]`.

The comparison is against the **Sales content area**, not the whole page: the Figma frames are
content-only and do not include the ERP sidebar, so the sidebar is excluded on both sides.

| Route | Frame | What was wrong | State |
|---|---|---|---|
| `leads` | SC-02 `239:21` | Card list, not the compact table. Rebuilt: 8 columns, header band, 13px row padding, one action per row. | **matched** |
| `pipeline` | SC-03 `250:113` | Unnumbered columns, metadata-first cards, bare chevrons; Won/Lost were a 5th and 6th column behind a dashed rule. Rebuilt with numbered columns, labelled next/back, and outcomes in their own section below. | **matched** |
| `deals/[id]` | SC-04 `251:141` | Filled red/indigo action pair, a row of equal stage pills, English dates. Now one primary action (raise a quotation), outlined win/lose, and an ordered stepper. | **matched** |
| `quotes` | SC-05 `255:194` | Two headers collided (`الإجماليصالح حتى`) — no cell had horizontal padding. Rebuilt on `DataTable`: the design's 7 columns, one action per row, Arabic dates and money. | **matched** |
| `quotes/[id]` (draft) | SC-06 `254:188` | Latin figures, no header facts, a plain-text approval warning. Now the facts row, the amber approval card, per-line threshold marking, taxable base. | **matched** |
| `quotes/[id]` (issued) | SC-07 `255:368` | **Rendered the draft editor with `disabled` inputs.** Now a read-only record with the server's figures, a status strip and the revision chain. | **matched** |
| `quotes/[id]/print` | SC-08 `257:260` | Latin money and dates on an Arabic tax document. Now Arabic-Indic with ر.س, taxable base, terms, two signature blocks. | **matched, one gap** |
| `activities` | SC-09 `257:333` | A card list with violet buttons and `Jan 1, 2020` dates. Rebuilt: 6 columns, an overdue chip that says *how* late, a filled Complete. | **matched** |
| `targets` | SC-10 `257:438` | `SAR 350000.00 / 266000.00` as a subtitle, a flex-width violet bar, an English month control. Rebuilt on the design's 5 columns and a 220px tinted bar. | **matched** |
| `reports` | SC-11 `258:269` | Six separate KPI cards, `36.84%`, violet funnel. Now one divided strip, Arabic-Indic, the design's bar. | **matched** |
| `settings` | SC-12 `258:324` | Only the stage table existed. Added the two cards the design has — the seven stored lead sources and the discount limits. | **matched** |
| `my-commissions` | SC-01 `236:2` | No hero figure, no statement formula, no status legend, ledger as an unlabelled list. All four added; the arithmetic panel rebuilt. | **matched** |
| `commissions/plans` | SC-13 `256:255` | Tiers as a cramped inline list; no worked example. Now the bands as a table whose last column gives the rate on that slice, plus the example. | **matched** |
| `commissions/review` | SC-14 `253:181` | `المتبقيالتطابق` collided; no plan column; no rules card. All three fixed. | **matched** |
| `leads/[id]` | *no frame* | Not one of the 14 designed screens. Brought onto the design tokens and the Arabic date formatter for consistency. | **consistent** |

### Deviations from the frames, and why

Each of these is a deliberate difference. None of them is the design being wrong about what it
wants; they are places where following the frame literally would have produced a control the
server refuses, a claim that is not true, or an RTL defect.

1. **Progress and funnel bars fill from the reading edge (right), not the left.** Every bar in
   SC-10 and SC-11 is drawn left-anchored, which is an artefact of how the rectangle was placed
   on an RTL canvas: it makes a bar grow away from the text that labels it. The implementation
   anchors at the start edge. **The Figma frames were not edited to match.**

2. **`quotes` has no "تصدير CSV" and no "عرض سعر جديد" in its header.** There is no quotes CSV
   export endpoint — only `leads/export` — and a quotation is raised from a deal, so a "new
   quotation" button with no deal lands on an error page. Both would be new API or new flow,
   not visual fidelity.

3. **An ISSUED quotation offers "تسجيل القرار", not "تحويل إلى طلب".** SC-05 puts convert-to-order
   on the issued row; `create-order` refuses anything that is not ACCEPTED with no order against
   it. The list offers the action the server will accept.

4. **`activities` keeps its filters inline** instead of behind SC-09's "تصفية" button. They are
   the primary control on the screen and are already wired; a button that opens nothing would be
   worse than the extra row. Its "نشاط جديد" is absent for the same reason as (2) — activities
   are logged against a lead or a deal.

5. **`settings` puts the stage table full-width** with sources and limits side by side beneath,
   where SC-12 pairs stages with sources. The app's stage table is interactive (reorder, edit,
   retire) and does not fit half a row.

6. **`settings` shows the app's real discount limits (10% / 60%)**, not the frame's illustrative
   15% / 30% / unlimited. The frame's numbers are placeholder content.

7. **The accrual arithmetic is shown in the engine's order.** SC-01 writes
   `base × rate × share`; `shareOfBase` applies the share to the base *before* the rate, which
   the frame's own explanatory line also says. Both orders reach the same total; only one is
   what the code does.

8. **`review` keeps a period totals strip** that SC-14 does not have, and shows the
   reconciliation chip **only when a row does not reconcile**. A green "matches" on every row is
   noise a reviewer learns to skip.

9. **Statuses keep the wording the module already uses** where the frame's differs — the
   statement cell is `المُسجّل كمصروف` rather than `مدفوع`, because in a sandbox nothing has been
   paid and the distinction is the point of the banner above it.

### Gaps that need a decision, not more implementation

- **The printed quotation has no issuer block and no VAT registration numbers.** SC-08 shows
  `مؤسسة هقبة للتحميص · الرقم الضريبي ٣١٠١٢٣٤٥٦٧٠٠٠٣` and a customer tax number. The schema has
  **no field for either** — no company-profile model, no `vatNumber` on `Customer`. A Saudi tax
  document needs both. Implementing it is a schema change plus a settings screen, which is
  outside a visual-fidelity pass and is flagged here rather than faked.

- **Native date and month controls render their own labels in the BROWSER's locale.** Every
  `<input type="month">` was replaced with a localised `<select>`, which fixed "September 2026"
  on the reports, targets, review and my-commissions screens. The one remaining native control
  is the quotation's `صالح حتى` **date** picker, which must stay a real date input; it will show
  `09/30/2026` to a browser set to US English. No CSS reaches it.

- **Eleven routes still inherit a responsive pattern** rather than having their own drawn frame
  at 1024 and 390. The implementation is verified at all three widths (below); the *design* is
  not drawn per route at the narrow widths.

Nothing above changes commission policy. The four load-bearing commission decisions are
untouched and are documented in `COMMISSION_RULES.md`.

### Corrections carried forward from earlier revisions

**"`npm run build` runs `prisma migrate deploy`." False for this repository.**

```
build = tsx scripts/validate-env.ts && prisma generate && next build
```

`vercel.json` sets no `buildCommand`, so Preview builds run exactly that. There are no
`postinstall`, `prepare` or `prebuild` hooks. Migrations are quarantined behind
`db:migrate:deploy` → `scripts/migrate-deploy.mjs`, which refuses to start without an explicit
`DIRECT_URL`, and `scripts/e2e/regression/harness-selftest.mjs:573` asserts *"the build does NOT
run `migrate deploy`"*. The claim came from a memory describing a **different worktree**.

The practical consequence is narrower than it sounds: a build will not migrate, but `next build`
can still open a database connection while prerendering, so it is **not** a safe check to run
while the compute is meant to stay idle. `tsc --noEmit` and `eslint` are.

**"Pipeline board not built." False.** It was a working screen before this pass; only the
*design* was missing. The page's own header comment saying so has been corrected.

**"The quote editor has no discount handling." False.** That came from grepping
`quotes/new/page.tsx`, a 67-line redirect stub. The real editor is `quotes/[id]/page.tsx`, and
`issueQuote` re-checks the discount gate **at issue time** rather than trusting what was true
when the lines were saved.

---

## 7. Verification evidence, and what each piece actually covers

Keep these three separate. They are not interchangeable.

### 7a. Design completion — **partial**

Verified by screenshot of every frame at creation, plus a structural integrity read confirming
all 8 pre-existing Order component sets unchanged (names, variant counts, descriptions) and
token totals still 4 / 76 / 18 / 3. Prototype audit: 48 reactions, 0 unresolved.

**Complete:** 14/14 desktop routes, 4 component sets, 6 modals, states board, 3 wired journeys.
**Incomplete:** tablet/mobile for 11 of 14 routes; no design review has happened.

### 7b. Visual comparison — **performed, per route, at three widths**

The method, so the evidence can be judged rather than taken:

1. The Figma frame is read with `get_design_context` / `get_screenshot` — structure and the
   rendered target, not a description of it.
2. The **real production component** is mounted in Chrome by the harness — not a recreation —
   with real compiled Tailwind and a fixture-backed `fetch`.
3. The fixtures carry the frame's own content (the same companies, the same figures) and are
   **relative to today**, because the frames say "اليوم ١٥:٠٠" and "متأخّر يومان"; fixed dates
   would make every capture disagree with its frame for a reason that has nothing to do with
   the implementation.
4. The capture is of the **Sales content area at the frame's content width**. The frames do not
   include the ERP sidebar, so it is excluded on both sides.
5. The two are compared, the difference is fixed, and the capture is retaken.

```
node tests/harness/build.mjs
node tests/harness/shoot-all.mjs 1440            # tests/harness/shots/<route>.png
node tests/harness/shoot-all.mjs 1024 -tablet
node tests/harness/shoot-all.mjs 390  -mobile
```

15 screens × 3 widths = **45 captures**, all rendering without an error state. A capture is
only counted when the screen rendered its real content; `shoot-all` fails a route that lands on
an error or a missing fixture rather than letting a red box through as "captured".

**What a screenshot cannot show, and is therefore tested instead:** that the *document* does
not scroll sideways. A capture of the top of a page looks identical whether or not the page is
89px too wide. `npm run harness:ui` now asserts it for every route at every width — which is how
the `sr-only` bug in §6 was found at all.

### 7c. Preview verification — **NOT performed; the push is blocked in this session**

- Repository: `feature/sales-crm-commissions`. At the time this section was written HEAD was
  **`938c097`**, 6 commits ahead of origin. **It is now `6b86079`, 8 ahead** — the functional
  automation of `COLLECTIONS_WORKFLOW.md` was added after this paragraph.
- `git push` is refused by this session's permission classifier (first as "Out-of-Place
  Publication", on the later attempt as "Data Exfiltration"). Nothing was routed around it,
  in either attempt: no API, no CLI, no alternative transport.
- The hosted Preview therefore still runs the **pre-change** build. **None of the work in §6 is
  on the hosted Preview**, and no hosted smoke result cited anywhere in this document describes
  it.

Refreshing the Preview needs one of: the user running
`git push origin feature/sales-crm-commissions`, or granting this session push permission.
`vercel.json` enables deployments for this branch only, so that push produces a **Preview** and
cannot touch Production.

### 7d. Offline checks — run against the working tree

The shared database compute is deliberately left idle. `npm run build` is skipped — **not**
because it migrates (it does not; see §6) but because `next build` can open a connection while
prerendering:

| Check | Result |
|---|---|
| `npx tsc --noEmit` (whole repo) | **exit 0** |
| `eslint` across Sales + Commissions | **0 errors** |
| `npm run harness:ui` | **76 passed, 0 failed** |
| `node tests/harness/check-overflow.mjs 390 / 1024 / 1440` | **0px overflow on all 15 routes** |

The 42 lint errors `eslint src tests` reports are all pre-existing and outside this module —
`cupping`, `dispatch`, `history`, `inventory`, `packaging`, `purchases`, `qc`, `lib/db.ts`, and
the generated `tests/harness/bundle.js` (which is gitignored).

### Mocked browser UI verification — 76 checks, 0 failed

`npm run harness:ui`. Mounts the **real** Sales components in Chrome with a fixture-backed
`fetch` and real compiled Tailwind, at 1440 / 1024 / 390. Covers the pipeline board-versus-
accordion switch, accordion keyboard toggling, a 76-character Arabic company name wrapping
rather than widening the page, lead detail, the three follow-up failure paths, commission
expansion by Enter, quotation discount above and below the threshold, empty / error /
not-found states, and — new in this pass — every route at every width against horizontal
document overflow.

**This is layout and component-behaviour evidence only.** A stubbed `fetch` cannot refuse a
request, so none of it says anything about authorisation, and nothing it does persists.

**A local integration environment is not available.** Checked four ways: no `psql`, `pg_ctl`,
`initdb` or `postgres` on PATH; no Docker; nothing listening on 5432–5439; no registered
Postgres service. Standing one up means installing new software, which is outside existing
permissions — so local integration evidence is genuinely blocked rather than deferred by
preference.

### What `npm run regression:sales` actually is — inspected, not assumed

It runs seven suites in order. **Five are offline** (`commission-engine`, `quotes-domain`,
`quote-discount-authz`, `follow-up-workflow`, `sales-rtl-audit`) and are already green above.
**Three are not:**

| Suite | Needs | Writes? |
|---|---|---|
| `sales-commissions-db` | `DATABASE_URL` | **Yes — freely.** Raw `pg`, and its own guard says so |
| `sales-security` | `DATABASE_URL`, `SALES_TEST_BASE_URL`, `PIN_LOOKUP_SECRET` | Yes — 34 mutating calls |
| `sales-workflow` | same three | Yes — 131 mutating calls |

All three **hard-refuse any database not named `sales_preview`** (`exit 3`), because that one
is reached by `sales_preview_app`, a role that owns nothing and holds no DDL. That guard is
protection against pointing them at the wrong place; it is not permission to run them while a
review is in progress. **They mutate the shared preview database and will wake the shared
compute.** That is why they are not run here and must be coordinated.

**`regression:sales` is not hosted smoke.** Hosted smoke is a different script,
`scripts/sales-preview/smoke-hosted.mjs`, driven by `SMOKE_URL` and `SMOKE_PIN_*`, and it pins
the deployment id it tested. The regression suites point at whatever `SALES_TEST_BASE_URL`
says, which may be localhost. Conflating the two is how a run gets cited against a deployment
it never touched.

### Database-backed tests still needed, specifically

- **Follow-up persistence.** That scheduling really writes a `TASK` activity against the right
  lead *and* `nextFollowUpAt`. The sequencing, the half-write handling and the no-duplicate
  retry are proven offline with stand-in writers; that either write lands is not.
- **Real-session discount authorisation.** That a user **without** `quote_approve_discount`
  is refused at `POST /api/sales/quotes/[id]/transition {to:"ISSUED"}` on a quote above the
  threshold, and that one **with** it succeeds and stamps `discountApprovedById`. The offline
  suite proves no request body can carry the flag; it cannot prove the deployed route reaches
  `issueQuote` under a real session.
- **Editing an approved quotation.** That `PUT` on a non-DRAFT quote is refused and that
  `revise` is refused for `ACCEPTED`, end to end rather than by reading `isRevisable`.
- **Lead scoping.** That another rep's lead 404s at `/dashboard/sales/leads/[id]`.
- `next build` — it does **not** migrate, but it can open a connection while prerendering.
- The 66 hosted smoke assertions, against the new deployment id.

**Figma prototype walks are prototype evidence.** The 22-step journey walk asserts that clicking
a named layer lands on the expected frame. It is not application behaviour and is not security
evidence: a prototype cannot refuse anything.

### 7e. User acceptance — **has not happened**

Passing automated checks are not acceptance, and neither is a design existing. Reviewer
walkthrough is `REVIEW_GUIDE_AR.md`; reviewer accounts are the `RVW_`-prefixed set provisioned by
`scripts/sales-preview/reviewer-accounts.ts`. **Reviewer credentials were not rotated.**

---

## 8. What this module still must not be called

The financial cycle is **not integrated**. There is no invoice or receivables model in this ERP,
and no bank feed. The sandbox notice is part of the design, not decoration.

**Amended by section 9.** Commission input is no longer only a sandbox adapter. There is now a
second, real source: a salesperson records a receipt with evidence, and somebody in Finance
verifies it. That is an internal human control, stamped `MANUAL_FINANCE_VERIFICATION`, and it
is the only thing besides the sandbox that creates commission.

What it is **not**: a bank settlement, a reconciliation against a statement, or an accounting
integration. An approved collection means a person in Finance looked at a receipt and agreed
the money arrived. Calling it "verified" is accurate; calling it "verified by the bank" is not.

Do not describe the Sales CRM module as production-ready, and do not describe this design
deliverable as complete.

---

## 9. Sales Collections — page 13, added for the finance-verified collection workflow

Everything in sections 1–8 describes the fourteen routes that existed before. This section
covers what was added when the module gained a real collection workflow, and it is written
to the same rule: **no existing frame was edited to make an implementation look compliant.**

### 9a. What is on the page

A new page, **`13 — Sales Collections`**, holding eleven frames and two prototype flows. The
frames are built from the same colour variables and `Text/AR/*` styles as pages 10–12; no new
token or style was introduced.

| Frame | What it specifies |
| --- | --- |
| `SC-15 / التحصيلات — قائمة التحقق المالي / AR / Desktop` | The route at `/dashboard/sales/collections`, 1440 wide: totals strip, the seven-column queue with one row per status, and the rules card |
| `SC-16 / لوحة التحصيل داخل الصفقة — محصَّل جزئياً / AR` | The money panel on the deal: accepted total, approved, pending, **unpaid balance**, **available to submit**, derived state, commission effect, history |
| `SC-17 / نافذة تسجيل تحصيل / AR` | Recording a collection, including the server-derived tax and net shown read-only |
| `SC-18 / إرفاق الإثبات — الحالات / AR` | Evidence: idle, uploading, attached, and a file whose bytes contradict its name |
| `SC-19 / حالة التحصيل — بانتظار · معتمَد · مرفوض · معكوس / AR` | One collection in all four states, with what each is worth |
| `SC-20 / ملخص الصفقة — غير محصَّل · جزئي · بالكامل / AR` | The three derived payment states |
| `SC-21 / العمولة — تقدير بانتظار الاعتماد مقابل عمولة معتمَدة / AR` | The pending estimate beside the payable figure, and the period ledger |
| `SC-22 / نافذة العكس أو الاسترداد / AR` | Reversal: the original entry, the required reason, the negative adjustment it creates |
| `SC-23 / فارغة · تحميل · خطأ · لا صلاحية / AR` | The four states that show no data |
| `SC-24 / التحصيلات — تابلت 1024 / AR` | 1024 behaviour |
| `SC-25 / التحصيلات — جوال 390 / AR` | 390 behaviour |

### 9c. Revised 26/09/2026 — the two balances

Hosted verification found the deal panel showing one figure labelled «المتبقي» /
"Outstanding" that carried total − approved − **pending**, i.e. submission capacity, not the
debt. SC-16, SC-17, SC-20 and the SC-15 rules card were revised to name both quantities:
**«المتبقي غير المسدد»** (total − approved) and **«المتاح لتسجيل تحصيل إضافي»**
(unpaid − pending). SC-20’s middle card is where they diverge — 11,500.00 against 5,750.00 —
and is the state worth reviewing. No token or style was added; the rows reuse the existing
cells and Text/AR styles.

Prototype flows: **رحلة التحصيل — من الصفقة إلى العمولة** (SC-16 → SC-17 → SC-18 → SC-19)
and **قائمة التحقق المالي** (SC-15 → approve/reject/reverse → SC-20 / SC-21 / SC-22).

### 9b. Deviations, recorded rather than designed away

1. **Figma auto-layout has no right-to-left direction.** The first child of a horizontal
   auto-layout is always leftmost, so an RTL screen has to be authored in visual
   left-to-right order. These frames were built in logical order and then mirrored to match
   the convention pages 10–12 already use (primary column and title on the right, actions
   and dialog footers on the left). Anyone editing them must keep that convention: a row
   added in logical order will appear mirrored.

2. **Bidi isolates are in the text.** `-40.00 ر.س` renders as `40.00-` and `OF-1042` as
   `1042OF-` when a sign or a hyphen sits in an Arabic run, because those characters are
   bidi-neutral. The application solves this with `<bdi>`; the frames use `U+2066 … U+2069`
   isolate characters around signed amounts and document references. They are invisible and
   will be lost if the text is retyped.

3. **Prototype flows cannot cross pages in Figma.** The collection journey is therefore its
   own starting point on page 13 rather than an extension of the page-12 prototype. The two
   read as one journey; they are two flows because the tool requires it.

4. **The mobile frame shows the table clipped.** That is the real behaviour, not a drawing
   error: `DataTable` puts the horizontal overflow on the table's own card, so the table
   scrolls sideways inside it and the page never does.

5. **The fourteen older frames still show Arabic-Indic digits** (`كافيه ٢١`, `متأخر ٣ أيام`).
   The implementation now renders Latin digits everywhere by explicit instruction, so those
   frames are stale on that one point. They were **left untouched**: the instruction was to
   preserve the completed Sales frames, and rewriting them is a separate, deliberate pass.
   Page 13 uses Latin digits throughout, and the rendered-DOM audit
   (`tests/harness/digits.spec.ts`, 51 assertions) is the authority on the application.

### 9c. What the collections design does **not** claim

Nothing on page 13 depicts a bank integration. The queue is headed
«تحقّق مالي يدوي — ليست تسوية بنكية» and the approval is a person agreeing that money
arrived, recorded as `MANUAL_FINANCE_VERIFICATION`. A frame showing an approved collection is
a frame showing that a human in Finance accepted a receipt, and nothing more.
