# Preview Review Guide — Sales CRM & Commissions

**Hosted preview status: NOT DEPLOYED.** See §1 for the precise reason. A verified preview
runs locally against the isolated database, and §2 explains how to bring it up.

No passwords or PINs appear in this document. The reviewer uses accounts they create or that
are seeded into the preview database.

---

## 1. Why there is no hosted Preview URL

### A correction to what this document used to say

It previously said a preview "inherits project-level environment variables". **That is not how
Vercel works, and the earlier wording overstated the danger while missing the real one.**
Variables carry an environment scope, and a Production-scoped variable does not reach a Preview
deployment at all. Branch-specific Preview variables override branch-agnostic Preview ones.
(https://vercel.com/docs/environment-variables)

### What this project's configuration actually is

Read from the authenticated Vercel CLI — names and scopes only; no value is readable and none
was read:

| Variable | Scope | Reaches a preview of this branch? |
|---|---|---|
| `DATABASE_URL` | **Production** | **No** — Production-scoped, so it cannot |
| `JWT_SECRET` | Production | No |
| `PIN_LOOKUP_SECRET` | Production | No |
| `DATABASE_URL`, `DIRECT_URL` | Preview, pinned to two named release branches | No |
| `JWT_SECRET` | **Preview, branch-agnostic** | **Yes** |
| **`DIRECT_URL`** | **Preview, branch-agnostic** | **Yes — and this is the real hazard** |

So the production database credential was never going to reach a preview. The genuine risk is
the **branch-agnostic Preview `DIRECT_URL`**, whose value cannot be read and which **Prisma uses
for migrations**. Left unoverridden, a preview of this branch would carry a migration URL
pointing somewhere nobody in this session can identify.

There is also no branch-agnostic Preview `DATABASE_URL` and no Preview `PIN_LOOKUP_SECRET`, so a
preview of this branch has neither.

### Why the branch-scoped overrides could not be set yet

`vercel env add DATABASE_URL preview feature/sales-crm-commissions` was attempted and refused:

> `branch_not_found`: Branch "feature/sales-crm-commissions" not found in the connected Git
> repository.

Vercel will not create a branch-scoped variable for a branch that does not exist on the remote,
and the branch has not been pushed. That is a genuine ordering problem, not a missing
permission: **the branch must be pushed before its variables can be scoped to it, and pushing is
what triggers the first deployment.**

### What a premature push would actually do

Verified locally rather than assumed. `npm run build` runs `scripts/validate-env.ts` **first**,
before `prisma generate` and before `next build`. With no `DATABASE_URL` and no
`PIN_LOOKUP_SECRET` — exactly what a first push would have — it prints:

```
Refusing to build: this environment is not configured to run (2 problems):
  - DATABASE_URL is not set.
  - PIN_LOOKUP_SECRET is not set.
```

and exits non-zero. The validator never contacts a database, `prisma generate` opens no
connection, and no migration runs during a build. So the first deployment would **fail closed at
the environment gate**, before compiling anything and before any server started.

That makes a push safe in practice. It was still not done, because the instruction was explicit:
do not push until the deployment trigger and the effective isolation have been verified, and
"effective isolation" cannot be verified without a deployment.

### The sequence that completes it

1. Push `feature/sales-crm-commissions`. The first build fails at the environment gate; nothing
   is deployed and nothing is reachable.
2. Set the five **branch-scoped** Preview variables (values from the preview env file; the last
   is literal):
   ```
   vercel env add DATABASE_URL            preview feature/sales-crm-commissions
   vercel env add DIRECT_URL              preview feature/sales-crm-commissions
   vercel env add JWT_SECRET              preview feature/sales-crm-commissions
   vercel env add PIN_LOOKUP_SECRET       preview feature/sales-crm-commissions
   vercel env add SALES_SANDBOX_COLLECTIONS preview feature/sales-crm-commissions   # true
   ```
   `DIRECT_URL` is the one that must not be skipped: it is what overrides the branch-agnostic
   Preview value, and it is what Prisma would migrate with.

   `JWT_SECRET` and `PIN_LOOKUP_SECRET` must be **the same values the preview database was
   seeded with**. A different `PIN_LOOKUP_SECRET` leaves a preview nobody can sign in to: the
   stored selector is a keyed derivation of the PIN, so a new key selects no row at all.
3. Redeploy the branch and confirm from the build log which database it resolved.

**Production variables must not be touched at any point.** Nothing above changes one.

### The complete set the application reads

So that "three variables" is not mistaken for the whole configuration:

| Variable | Required? | Used by |
|---|---|---|
| `DATABASE_URL` | **yes** | runtime pool, and the build's environment gate |
| `DIRECT_URL` | effectively yes | Prisma CLI for migrations — the non-pooler URL |
| `JWT_SECRET` | **yes** | session signing at module load; also the rate-limit pepper, minimum 32 characters |
| `PIN_LOOKUP_SECRET` | **yes** | the build's environment gate, and PIN sign-in |
| `RATE_LIMIT_SECRET` | no | falls back to `JWT_SECRET` |
| `SALES_SANDBOX_COLLECTIONS` | no | the sandbox collection gate; absent means off, which is the safe default |
| `TRANSLATION_API_KEY` | no | the only outbound integration; absent means the endpoint does not call out |
| `SHADOW_DATABASE_URL` | no | not used by this deployment; the guard checks it anyway |

There are no workers, no queues, no object storage and no authentication callback URLs: sign-in
is a first-party PIN flow against the application's own database, so there is no OAuth redirect
to register for a preview domain.

---

## 2. Running the verified preview

The preview database already exists and already has all 21 migrations applied. Bring the app up
against it with the guarded runner:

```bash
SALES_ENV=<preview env file> node withsales.mjs next start -p 3020
```

Or, to drive the whole thing the way the tests do:

```bash
# The five API-level suites (refuse any database but sales_crm_preview)
SALES_ENV=<preview env file> SALES_TEST_BASE_URL=http://127.0.0.1:3020 \
  node withsales.mjs node scripts/e2e/regression/run-sales.mjs

# The browser suite, in the Chrome already installed on the machine
SALES_ENV=<preview env file> BASE_URL=http://127.0.0.1:3020 \
  node withsales.mjs playwright test --project=sales
```

The runner refuses to start unless every connection path names both the approved endpoint and
the `sales_crm_preview` database. If it prints `REFUSE:`, it is doing its job — fix the target
rather than the guard.

Then open `http://127.0.0.1:3020`.

---

## 3. Roles to review with

Create three accounts in **Employees**, or seed them. The permissions that matter:

| Role | `sales` | `commissions` |
|---|---|---|
| **Sales rep** | `lead_write`, `lead_convert` | `view_own` only |
| **Sales manager** | the above plus `lead_assign`, `deal_close`, `deal_reopen` | `view_team`, `manage_plans`, `approve`, `sandbox_collections` |
| **Finance** | none | `view_team`, `approve`, `record_payout` |

`sandbox_collections` is deliberately **not** on the rep. A rep who could record a collection
could manufacture the money they are paid on.

---

## 4. The five-minute walkthrough

### As the rep

1. **Leads** → *New lead*. Company and contact are required; everything else is optional. Set a
   follow-up date in the past to see the overdue treatment.
2. Save a second lead with the **same phone number**. The save is refused once, the existing
   lead is listed, and *Create anyway* lets you proceed on purpose. Nothing is merged.
3. Note the line *"Showing only your own leads."* — the scoping is in the query, not the
   stylesheet.
4. Open a lead and press **Convert to customer**. It creates a customer and a deal.
5. **Press Convert again.** It reports the lead was already converted and creates nothing. This
   is the button people double-click; that is why it is idempotent.

### As the manager

6. **Commission admin** is not built (see §6). Create a plan and assignment directly in the
   database, or via the domain service, to give the rep a rate — for example 1%.
7. Record a sandbox collection through `POST /api/commissions/sandbox-collections` with an
   `externalRef`, `amountGross: 5750` and `amountTax: 750` against the deal. The qualifying
   base is **5,000** and the rep accrues **50.00**.
8. Send the **same `externalRef` again**. It answers as a replay and accrues nothing further.
9. Record the remaining 5,750. The rep's total becomes **100.00** — the second payment adds 50,
   it does not re-add 100.

### As the rep again

10. **My commissions** → pick the month. You should see the accruals with, for each one:
    collected, of which tax, qualifying base, and the effective rate. Not just a total.
11. Note the amber banner: these figures come from a sandbox source and **no real payment was
    received**. That statement is the point of it.
12. Reload the page. Everything persists — it is in the ledger, not in component state.

### Checking the boundaries

13. As the rep, call `POST /api/commissions/sandbox-collections`. **403.**
14. As the rep, take another rep's lead id and call `…/convert`. **404** — not 403, because
    confirming the row exists would tell you it is somebody else's.
15. As the rep, post a lead with `ownerId` set to a colleague. It saves, but the owner is
    **you**. Ownership is never taken from the request body.

---

## 5. Arabic and responsive

Switch language in the profile. Both screens are authored in Arabic and English; the layout
inherits the app's existing RTL handling. Phone numbers are forced left-to-right inside
right-to-left text so they do not render reversed. Check at a phone width too — the lead cards
and the commission summary reflow to a single column.

---

## 6. What is not there

Be clear-eyed about this while reviewing:

- **Pipeline, deal detail, activities, quotes, sales targets and commission administration
  screens are not built.** The Pipeline nav link exists but the page does not.
- **Quote-to-order integration is modelled in the schema but has no route or screen.** The
  `OpportunityOrder` bridge, its idempotency key and the first-order flag exist; nothing drives
  them yet.
- **Both screens are provisional** — no Figma design exists. See `FIGMA_UX_HANDOFF.md`.
- **The financial cycle is not integrated.** Every figure traces to the sandbox source. Nothing
  has been paid and no accounting system is connected.
