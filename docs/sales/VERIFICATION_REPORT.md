# Verification Report — Sales CRM & Commissions

Branch `feature/sales-crm-commissions` · base `4640cbe` · this report covers up to `4fcca9e`.

Honest status per item. **PASS** means it ran and passed. **BLOCKED** means an external
dependency prevented it. **NOT DONE** means it was not attempted. Nothing untested is
described as working.

---

## 1. Gates actually run

| Gate | Result | Evidence |
|---|---|---|
| TypeScript typecheck (`tsc --noEmit`, whole app) | **PASS** — 0 errors | run after each slice |
| Production build (`next build`, Turbopack) | **PASS** — compiled in 24.6 s | no migrations run during build |
| Commission engine — pure arithmetic | **PASS — 48 / 0** | `scripts/e2e/regression/commission-engine.mjs` |
| Sales & commissions — PostgreSQL integration | **PASS — 23 / 0** | `sales-commissions-db.mjs`, against `sales_crm_preview` |
| Security negative tests — real HTTP API | **PASS — 34 / 0** | `sales-security.mjs`, against a running app |
| Migration on an **empty** database | **PASS** — 20 baseline + migration 21, 0 pending, 0 unfinished | `sales_crm_preview`, created empty |
| Migration on a **populated prior schema** | **PASS** — applied to the regression database carrying the existing 20-migration schema and synthetic fixtures | additive; existing suites then run against it |
| Existing full regression (26 suites) | see §5 | run against this branch's build |
| Hosted Preview deployment + smoke | **BLOCKED** | §6 |
| Figma design + prototype | **BLOCKED** | `FIGMA_UX_HANDOFF.md` |
| Browser E2E (Playwright, three roles) | **NOT DONE** | §7 |

**105 assertions across the three new suites, 0 failed.**

---

## 2. Requirements mapped to the tests that prove them

| Requirement | Proven by | Result |
|---|---|---|
| Different rate per employee | engine B1 — 1% → 100.00, 2% → 200.00 on a 10,000 base | PASS |
| Base is net of tax | engine A1/A2 — 11,500 gross with 1,500 tax → base 10,000; 5,750 → 5,000 | PASS |
| Non-qualifying lines excluded | engine A3 | PASS |
| Incremental tiers on the slice | engine C1 — 110,000 → **1,150.00**, effective 1.045455% | PASS |
| Tier boundaries | engine C2–C6 — below, exactly at, above, one riyal inside, open-ended band | PASS |
| Partial collection accrues once | engine E1 — 5,000 → 50.00, then +50.00, never +100.00 | PASS |
| Duplicate collection event | engine E2 (zero delta) + security E4 (replay) + db A2 (unique constraint) | PASS |
| Rounding across instalments | engine E3 — three thirds total exactly 100.00 | PASS |
| Refunds / reversal | engine E4 → −20.00; db C2 — negative ledger entry, original unedited | PASS |
| Split commissions | engine D1 — 60/40 on 5,000 → 30.00 and 40.00 | PASS |
| Splits must total 100 | engine D2 — 90% refused, not normalised | PASS |
| Plan effective dates | engine H1 — version chosen by the date the money arrived | PASS |
| No overlapping assignments | engine H2 | PASS |
| Riyadh month boundaries | engine G1–G3 (both directions) + db D1 (survives a round trip) | PASS |
| Retroactive tiers refused | engine F1 | PASS |
| Multi-currency refused | engine F2 + security F2 | PASS |
| Money never floating-point | db C4 — 0.10 + 0.20 sums to exactly 0.30 | PASS |
| Approved accrual immutable | db C3 — status, base, rate and approver all survive reload | PASS |
| Constraints exist, not merely intended | db A1–A4 — four constraints proven by violation | PASS |
| Concurrent lead conversion | db B1 — two real connections → **one** conversion, **one** customer | PASS |
| Transaction rollback | db B2 — aborted conversion leaves nothing | PASS |
| Unauthenticated access refused | security A1 — four endpoints | PASS |
| Role without module refused | security B1 | PASS |
| Mass assignment on ownership | security C1 — supplied `ownerId` ignored, caller stored | PASS |
| Read scoping | security C2 — no foreign row reaches the client | PASS |
| ID manipulation across owners | security D1 — 404, and no conversion created | PASS |
| Rep cannot fabricate collections | security E1/E2 — refused, nothing recorded | PASS |
| Sandbox labelled in data and response | security E3 + db E1 | PASS |
| Validation refuses nonsense | security F1–F4 | PASS |
| Errors leak no Prisma/SQL | security H1 | PASS |
| Existing domain undisturbed | db F1/F2 + the existing regression | PASS |

---

## 3. Defects found and fixed during verification

All four were found by tests rather than by reading, which is the point of them.

1. **`Prisma.Decimal.Value` is not a namespace member in Prisma 7.** The engine would not
   compile standalone. Fixed by spelling out the accepted input types.
2. **The engine imported the generated Prisma client**, which made it uncompilable on its own
   and dragged the entire data layer into a file that is pure arithmetic. Now imports `Decimal`
   from `@prisma/client/runtime` — better architecture, and it is what lets the worked examples
   be asserted with no database.
3. **Three security cases used a one-character contact name** that validation correctly
   rejects, so they failed before reaching the behaviour under test. The fixtures were lazy;
   the validation rule is right and was not weakened.
4. **The security suite's teardown keyed leads on an id prefix**, but leads created through the
   API get cuid ids — so it silently left every API-created lead behind and the next run hit a
   foreign key deleting their owner. Now keys on the content prefix the suite actually writes,
   deletes child-first, and re-throws foreign-key errors instead of swallowing them.

No test was deleted, no assertion weakened, and no expected value changed to match wrong
behaviour.

---

## 4. Preview database identity — verified, no credentials

| | |
|---|---|
| Project | `hiqbah` (`dark-lab-61530722`), PostgreSQL 17, branch limit 10 |
| Branch | `erp-regression-r1` — non-production |
| **Database** | **`sales_crm_preview`** — created **empty** on 2026-09-23; nothing copied into it |
| Endpoint | `ep-wandering-leaf-…` — the regression endpoint, not production |
| Migrations | 21 applied, 0 pending, 0 unfinished |

**Why a fresh database rather than a branch of the approved parent:** `erp-regression-r1` was
inspected first. Business tables are empty, but it holds **17 untagged staff-shaped `Employee`
rows** — matching production's employee count exactly, six with passwords set, with the real
role spread (admin, dispatch, inventory, qc, roasting, custom). It therefore could not be
verified synthetic-only and was **not branched**. A new empty database was created instead: no
data copied, no branch slot consumed, parent untouched.

**Guard:** allowlist, not denylist. Both the endpoint and the database name must match or
nothing runs; every connection path is checked (`DATABASE_URL`, `DIRECT_URL`,
`SHADOW_DATABASE_URL`, `ERP_TEST_DATABASE_URL`, `POSTGRES_URL`); the three reported production
identifiers are denied as a second line of defence. **Proven both ways** — it refuses a
production endpoint and accepts the preview target.

### Correction to the reported production identifier

The brief named `ep-icy-field-aq4upc3z` as production. **That endpoint exists in no environment
of this project.** An earlier guard in this codebase named it and was therefore protecting
nothing — which is exactly why the brief's own instruction not to rely on a denylist alone is
right. The live production endpoint is `ep-dawn-dust-aqn1u1uf` (branch
`hiqbah-demo-training-20260529`, despite the name); `ep-jolly-feather-aqne6cp1` is the root
branch called `production`. All three are denied.

---

## 5. Existing regression against this branch

Migration 21 was applied to the regression database (non-production, additive) so the existing
26-suite regression could run against the new schema, then the full suite was run using this
branch's build.

**Result: recorded in the final session report.** The suite takes roughly half an hour; at the
time this document was written it was still running with **0 failures across the suites that
had reported**. Anyone resuming should re-run it and record the final line here:

```
ERP_E2E_BASE_URL=http://127.0.0.1:3010 node withpkg-sales.mjs node scripts/e2e/regression/run-all.mjs
```

---

## 6. Hosted Preview — BLOCKED

Pushing this branch would create a Vercel preview, and **a preview inherits project-level
environment variables unless Preview-scoped ones exist.** This project's production
`DATABASE_URL` is a write-only Vercel Secret whose environment scoping could not be read: the
Vercel connector in this session returns no accessible teams, and the CLI path is unavailable.

A preview URL does not demonstrate database isolation. An unverified preview of a module that
writes leads, customers and commission ledger entries is precisely what must not be pointed at
production by accident, so **the branch was not pushed and no deployment was created**.

**The one step that unblocks it:** set Preview-scoped `DATABASE_URL`, `DIRECT_URL` and
`SALES_SANDBOX_COLLECTIONS=true` on the Vercel project, pointing at `sales_crm_preview`. Do not
change Production variables. Then the branch can be pushed and the preview is safe by
construction.

A verified preview does run locally against the isolated database — see
`PREVIEW_REVIEW_GUIDE.md`.

---

## 7. Not done, and honestly so

- **Browser E2E (Playwright, three roles).** The API-level security suite covers the
  permission matrix through real HTTP, but that is not the same as driving the screens.
- **Screens not built:** deal detail, activities/tasks, quotes, sales targets, commission
  administration and approvals. Leads, Pipeline and My Commissions are built.
- **Quote-to-order integration** is modelled — `OpportunityOrder`, its idempotency key, the
  first-order flag — but has no route or screen driving it. `transitionOpportunity` already
  requires an accepted quotation before a deal may be Won, so that path is reachable only once
  quotes are built.
- **CSV import/export** for leads: not built. The security suite asserts a CSV-formula payload
  is stored verbatim, which is the input half; neutralising it on export is the export's job
  and there is no export yet.
- **Reporting screens:** not built. `LeadConversion` exists specifically so conversion rate can
  be computed from real links rather than by dividing unrelated counts, but no report consumes
  it yet.
- **Figma design and prototype:** blocked; see `FIGMA_UX_HANDOFF.md`.

---

## 8. Production

**Untouched.** No production database connection, no migration, no deployment, no environment
variable change, no push to `main`, no merge. The work is committed on a feature branch and the
only databases written were `sales_crm_preview` (created empty for this task) and the
non-production regression database.
