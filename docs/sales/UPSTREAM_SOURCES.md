# Upstream Sources & Provenance

Honest accounting of what was taken from where. The short version: **no third-party code was
copied into this repository.** Nothing below creates a licence obligation, because nothing
below was vendored, adapted line-by-line, or added as a dependency.

---

## 1. NextCRM — reviewed, not reused

| | |
|---|---|
| Repository | https://github.com/pdovhomilja/nextcrm-app |
| Licence | MIT (per the repository's `LICENSE`) |
| Role here | **Reference only.** Zero files, zero dependencies, zero code. |

### Why nothing was copied

Each of these was checked against the source rather than assumed:

1. **It would have created a parallel customer and user system.** Its Prisma models carry
   their own id, auth and account conventions. Importing them beside this ERP's existing
   `Customer`, `Employee` and `Order` is precisely what the brief forbids, and merging them
   would be a larger and riskier change than writing the CRM natively.
2. **Its build applied migrations.** Its build command ran `migrate deploy`. This project
   deliberately separates migration from build, and the separation is load-bearing — the
   clean-build gate asserts zero migrations run during a build.
3. **No commission engine exists in it.** The largest single piece of this task — versioned
   plans, tiers, split attribution, cumulative accrual, reversals — has no counterpart to
   borrow.
4. **Its opportunity states did not separate WON/LOST as terminal outcomes.** This
   implementation needs them on a different column from the pipeline stage so a closed deal
   cannot be dragged back into the funnel. That is a schema-shape difference, not a patch.
5. **Its conversion-rate metric was not sound.** It divided opportunity count by lead count
   over a period, with nothing linking the two sets. That number does not measure conversion.
   Ours is computed from explicit `LeadConversion` rows, which is why that table exists.
6. **Version drift.** It targets different Next.js and data-layer versions. Raising this
   project's versions to match a reference would be a large, unrequested risk.

### What the review actually contributed

Interaction shape, carried as understanding rather than as code: a stage-column Kanban with a
deal-detail panel and an activity timeline beside it. That pattern is common to every CRM and
is not NextCRM's invention; it is recorded here because reading their implementation is what
settled the layout decision quickly.

**No file in this repository derives from NextCRM. No attribution is owed, and claiming reuse
that did not happen would be worse than claiming none.**

---

## 2. Other references consulted

| Source | Role | Code taken |
|---|---|---|
| https://github.com/marmelab/atomic-crm | CRM interaction reference | None |
| https://github.com/OCA/commission | Understanding what a commission module needs to model — versioned rules, split attribution, reversal rather than edit | **None.** Its licence (AGPL-family, per OCA convention) is incompatible with vendoring into this codebase, and it was read for requirements only. |
| https://github.com/twentyhq/twenty | Considered as an alternative architecture — running a separate CRM product instead of an internal module | None. Rejected: the brief's core requirement is a commission engine fed by this ERP's own collections, which a separate product cannot see without building the integration this task is meant to avoid. |

---

## 3. New dependencies added

**None.** The commission engine uses `Decimal` from `@prisma/client/runtime`, which is already
a dependency of this project; the domain deliberately does not import the generated Prisma
client, so it stays compilable and testable on its own.

---

## 4. What was implemented independently

Everything. Specifically:

- `src/lib/services/commissions/engine.ts` — tiers, qualifying base, split shares, plan
  version selection, Riyadh period boundaries.
- `src/lib/services/commissions/accrual.ts` — cumulative-target accrual, reversals,
  approvals, adjustments, period statements.
- `src/lib/services/sales/leads.ts` — Arabic-aware normalisation, duplicate candidates,
  idempotent conversion, server-enforced stage/outcome transitions.
- The 19 new Prisma models and migration 21.
- The API routes, permission registration, and both provisional screens.
- All four test suites.

Written against this ERP's own conventions — its `Decimal(18,2)` money rule, its
`requireModule`/`requireSub` auth helpers, its `handlePrismaError` response shape, its
translation dictionary and its component vocabulary — because matching the host codebase was
worth more here than matching any reference.
