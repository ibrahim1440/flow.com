# Figma / UX Handoff — **FIGMA_IN_PROGRESS**

## Status: connectivity works, initial designs exist, the deliverable is **not** complete.

The previous version of this document said `FIGMA_BLOCKED` and stated there was no Figma file,
no prototype and no frame links. All three of those statements are now false and have been
replaced. What has **not** changed is that this is still an open deliverable: the design covers
every route at desktop, but not every route at every breakpoint, and none of it has been
through design review or user acceptance.

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
| 5 | `/dashboard/sales/quotes/new` | **SC-06** `254:188` | **T-03** `262:449` | **MB-03** `263:458` | discount-approval gate |
| 6 | `/dashboard/sales/quotes/[id]` | **SC-07** `255:368` | — | — | revision history |
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
| P3 · line-item editor | `262:449` | `263:458` | quotes/new |
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

## 6. Implementation differences — design vs code today

Design decisions a reviewer should settle, and gaps between the frames and `main`:

| # | Design | Code today | Kind |
|---|---|---|---|
| 1 | Header shows `N shown · N overdue · N with no next step` + scope line | Implemented | **closed** |
| 2 | Lead row opens the lead; company is a link | `/dashboard/sales/leads/[id]` built, list links to it | **closed** |
| 3 | Per-row next action (convert / log follow-up / schedule) | All three on the detail screen; activity + date written together | **closed** |
| 4 | Commission calculation collapsed by default, expandable | Per-row toggle with `aria-expanded` | **closed** |
| 5 | Pipeline board with configurable stage columns | Was never a gap — already built. See the correction below. | **closed** |
| 6 | Discount over role limit switches the primary action | Was largely never a gap either — see below | **closed** |
| 7 | Status badges from the four new sets | Adopted for the 5 genuine domain statuses | **closed** |
| 8 | Sandbox notice is one line; detail lives in docs | One sentence | **closed** |
| 9 | Arabic desktop is the governing reference | Aligned, and now asserted by `sales-rtl-audit` | **closed** |

### A third correction: gap 6 was mostly not a gap

A previous revision said "the quote editor has no discount handling at all." That was produced
by grepping `quotes/new/page.tsx` — a **67-line redirect stub** that creates a draft and
navigates away. The real editor is `quotes/[id]/page.tsx`, 734 lines, and it already had
per-line `discountPercent`, live recalculated totals, the server-supplied threshold, a
`needsApproval` banner naming who must issue, an approved-discount marker and a revise path.

The server side was already stronger than the design asked for: `issueQuote` re-checks the gate
**at issue time** rather than trusting what was true when the lines were saved, and the route
derives `quote_approve_discount` from the session. Nothing needed building.

What inspection *did* find was a refusal that named an impossible action: `assertTransition`
appended "Raise a new revision instead" for ACCEPTED and SUPERSEDED, and `isRevisable` permits
neither. Only the wording was changed — whether an accepted quotation *should* be revisable is
a business decision and the rule is untouched.

### Remaining gaps, stated plainly

- **Pipeline on a phone** scrolls horizontally; the designed stage accordion (pattern P5) is not
  implemented. Recorded as a `KNOWN GAP` in `sales-rtl-audit` so it prints on every run.
- **Nine lint errors** remain across nine Sales screens, all one pattern
  (`react-hooks/set-state-in-effect` on a `useCallback` loader). `my-commissions` was fixed and
  is clean; the others reuse their loader after mutations, so inlining would break working
  flows. They need one repo-wide refactor, not nine spot fixes.
- **Eleven routes** still inherit a responsive pattern rather than having their own frame at
  each width.

Nothing above changes commission policy. The four load-bearing commission decisions are
untouched and are documented in `COMMISSION_RULES.md`.

### Two claims in the previous revision were wrong — corrected here

**1. "`npm run build` runs `prisma migrate deploy`." False for this repository.**

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

**2. "Pipeline board not built." False.** `/dashboard/sales/pipeline` is a working 353-line
screen: it loads `/api/sales/opportunities`, renders configurable stages from the server,
filters open deals per stage, moves a deal with `POST …/transition`, requires a reason to mark
lost, gates close/reopen on `can.close` / `can.reopen`, flips its chevrons for RTL, and has a
real empty state when no stages are configured. The gap was only that the **design** did not
exist; the feature did. The page's own header comment ("no Figma design exists yet") is now
stale.

A related correction runs the other way: the design used **«خط الأنابيب»** for this screen while
the application already used the better term **«مسار الصفقات»** (`pipelineNav`). The Figma frame
was renamed to match the code, not the reverse.

---

## 7. Verification evidence, and what each piece actually covers

Keep these three separate. They are not interchangeable.

### 7a. Design completion — **partial**

Verified by screenshot of every frame at creation, plus a structural integrity read confirming
all 8 pre-existing Order component sets unchanged (names, variant counts, descriptions) and
token totals still 4 / 76 / 18 / 3. Prototype audit: 48 reactions, 0 unresolved.

**Complete:** 14/14 desktop routes, 4 component sets, 6 modals, states board, 3 wired journeys.
**Incomplete:** tablet/mobile for 11 of 14 routes; no design review has happened.

### 7b. Preview verification — **NOT performed for this change**

- Repository: `feature/sales-crm-commissions`, HEAD **`371ee1b`**, 7 commits ahead of origin.
- The §7 UI change is **uncommitted working-tree modification** on top of `371ee1b`.
- The hosted Preview runs deployment `dpl_HynUSRbdwvVVzBYC99yoQW4iM8TY`, built from **`84fd9d6`**.
  **It does not contain this change.** The 66 hosted smoke assertions cite that deployment and
  say nothing about the code added here.

Offline checks run against the working tree, with the shared database compute deliberately left
idle. `npm run build` is skipped — **not** because it migrates (it does not; see the correction
in §6) but because `next build` can open a connection while prerendering:

| Check | Result |
|---|---|
| `prisma generate` | client generated (offline codegen, inert localhost URL) |
| `npm run build:test-domain` | exit 0 |
| `npx tsc --noEmit` (whole repo) | **exit 0** |
| `commission-engine.mjs` | **48 passed, 0 failed** |
| `quotes-domain.mjs` | **113 passed, 0 failed** |
| `quote-discount-authz.mjs` | **17 passed, 0 failed** |
| `follow-up-workflow.mjs` | **46 passed, 0 failed** |
| `sales-rtl-audit.mjs` | **7 passed, 0 failed** |
| lint across Sales + commissions | **0 errors** (was 10) |

**231 offline assertions.** None of it touches a database.

### Mocked browser UI verification — 31 checks, 0 failed

`npm run harness:ui`. Mounts the **real** Sales components in Chrome with a fixture-backed
`fetch` and real compiled Tailwind, at 1440 / 1024 / 390. Covers the pipeline board-versus-
accordion switch, accordion keyboard toggling, a 76-character Arabic company name wrapping
rather than widening the page, no horizontal page overflow at any width, lead detail, the three
follow-up failure paths, commission expansion by Enter, quotation discount above and below the
threshold, and empty / error / not-found states.

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

### 7c. User acceptance — **has not happened**

Passing automated checks are not acceptance, and neither is a design existing. Reviewer
walkthrough is `REVIEW_GUIDE_AR.md`; reviewer accounts are the `RVW_`-prefixed set provisioned by
`scripts/sales-preview/reviewer-accounts.ts`. **Reviewer credentials were not rotated.**

---

## 8. What this module still must not be called

The financial cycle is **not integrated**. There is no invoice or receivables model in this ERP,
so commission input is a sandbox adapter behind three gates and no figure corresponds to money
anyone received. The sandbox notice is part of the design, not decoration.

Do not describe the Sales CRM module as production-ready, and do not describe this design
deliverable as complete.
