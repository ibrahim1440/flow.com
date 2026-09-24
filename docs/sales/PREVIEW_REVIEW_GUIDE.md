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

**The quickest route: run the browser suite once.**

```bash
SALES_ENV=<preview env file> BASE_URL=http://127.0.0.1:3020 \
  node withsales.mjs playwright test --project=sales
```

Its fixture setup creates exactly these three accounts in the preview database, along with
pipeline stages, two commission plans at different rates, a product catalogue and customers
— then the suite drives the whole module through them, so a green run is also a working
dataset to review. The accounts and their PINs are defined in
`tests/e2e/support/roles.ts` as `crmRep`, `crmManager` and `crmFinance`. They are test
fixtures for a disposable database, which is why they live in the repository and why no PIN
is repeated in this document.

Or create three accounts by hand in **Employees**. The permissions that matter:

| Role | `sales` | `commissions` |
|---|---|---|
| **Sales rep** | `lead_write`, `lead_convert` | `view_own` only |
| **Sales manager** | the above plus `lead_assign`, `deal_close`, `deal_reopen` | `view_team`, `manage_plans`, `approve`, `sandbox_collections` |
| **Finance** | none | `view_team`, `approve`, `record_payout` |

`sandbox_collections` is deliberately **not** on the rep. A rep who could record a collection
could manufacture the money they are paid on.

`manage_plans` is deliberately **not** on finance either: somebody who approves a commission
should not also be able to change the rate they are approving against. And regardless of any
privilege, the service refuses to let anyone put themselves on a plan, set their own target,
or approve their own commission — because `manage_plans` can legitimately belong to a sales
manager who is on a plan themselves.

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

### As the rep, continued — the quotation

6. Open the deal and press **New quotation**. Add a line, pick a product, set a quantity. The
   totals beneath the lines are a **preview** and say so; press *Save* and the server's
   figures replace them.
7. Set a line discount of **25%** and press *Issue*. You are refused: above 10% a quotation
   needs a manager with discount approval. The screen warns before you press it, not after.

### As the manager

8. Open the same quotation and press **Issue**. It succeeds, the lines go read-only, and the
   quotation records **who** approved the discount rather than leaving it implied.
9. Press **Document**. The quotation renders as a customer document from the snapshot frozen
   at issue. Rename the product in **Products**, come back and reload — the document has not
   changed, because it is not reading the live catalogue.
10. Press **Revise**. The original becomes *superseded*, a new draft carries revision 2 and the
    lines come with it. Change the discount to 5%, issue, then press **Accepted**.
11. Press **Create order**. An order appears in **Orders** with the quotation's lines, its
    quotation number, and kilograms the ORDER service derived from the SKU.
12. **Press Create order again.** It reports that the order already exists and creates no
    second one.
13. Now press **Won** on the deal. It is allowed only because an accepted quotation exists —
    try it before step 10 and you are refused with that reason.
14. **Commission plans** → *New plan*. Give it a base rate of 1% and a tier if you like; the
    form states that a tier adds percentage POINTS to the slice inside its band, with the
    worked example. Then *Assign someone* → the rep.
15. Try to assign the plan to **yourself**. Refused, whatever your privileges: nobody sets
    their own rate.
16. Record a sandbox collection through `POST /api/commissions/sandbox-collections` with an
    `externalRef`, `amountGross: 5750` and `amountTax: 750` against the deal. The qualifying
    base is **5,000** and the rep accrues **50.00**. (There is deliberately no screen for
    this — see §6.)
17. Send the **same `externalRef` again**. It answers as a replay and accrues nothing further.
18. Record another 5,750 under a new ref. The rep's total becomes **100.00** — the second
    payment adds 50, it does not re-add 100.

### As finance

19. **Commission review** → pick the month. Each person shows what the LEDGER says and what
    the accrual rows add up to, **and whether the two agree**. A row that does not reconcile
    is marked, and it is the one thing on that screen worth stopping for.
20. Expand the rep. Each accrual names its collection event, its own qualifying base, the
    share applied and the effective rate — so the figure can be explained without re-running
    anything.
21. Press **Approve**. The rows become immutable.
22. Ask the manager to **reverse** one of the collections
    (`PATCH /api/commissions/sandbox-collections` with the same `externalRef`). Come back: the
    ledger has dropped by 50 through a **negative entry**, and the approved accrual rows are
    exactly as they were approved. That is the whole point of an append-only ledger.
23. **Adjust** the rep by +10 with a reason. Then record a payout — it refuses anything above
    what is outstanding, and refuses entirely while an accrual is still unapproved.
24. Try to approve **your own** commission. Refused.

### As the rep again

25. **My commissions** → the same month. You should see the same figure finance saw, with the
    accruals behind it: collected, of which tax, qualifying base, and the effective rate. Not
    just a total.
26. Note the banner: these figures come from a sandbox source and **no real payment was
    received**. That statement is the point of it.
27. Reload. Everything persists — it is in the ledger, not in component state.

### Checking the boundaries

28. As the rep, call `POST /api/commissions/sandbox-collections`. **403.**
29. As the rep, take another rep's lead id and open `/dashboard/sales/deals/<id>` or call
    `…/convert`. **404** — not 403, because confirming the row exists would tell you it is
    somebody else's.
30. As the rep, post a lead with `ownerId` set to a colleague. It saves, but the owner is
    **you**. Ownership is never taken from the request body.
31. As the rep, open **Commission review**. It is not in the sidebar, and the URL answers
    **403**.
32. Deactivate the rep in **Employees** while they have a tab open. Their very next request is
    **401** — not when a token happens to expire.

---

## 5. Arabic and responsive

Switch language in the profile, then **sign out and back in** — the language is baked into the
session at sign-in, so changing it and reloading leaves the old session in place.

Every screen is authored in Arabic and English and lays out from the same markup: `dir` is set
once on `<html>` and the components use logical properties throughout, so there is no separate
RTL stylesheet to drift out of step. Phone numbers are forced left-to-right inside
right-to-left text so they do not render reversed.

Check at a phone width (390px). Nothing should scroll sideways: wide tables scroll inside
their own box, which is asserted in the browser suite rather than assumed.

Worth trying with the keyboard alone — every field has a real label wired to it, which is what
makes it announced by a screen reader, clickable, and findable by name.

---

## 6. What is not there

Be clear-eyed about this while reviewing.

- **The financial cycle is not integrated, and this is the important one.** This ERP has no
  invoice, payment or receivables model — checked against the schema, not assumed. So
  collection is an **adapter**, and its only implementation is a sandbox behind three
  server-side gates. **No figure in the commission screens corresponds to money anyone has
  received.** Every screen that shows one says so.

  That is also why there is no screen for recording a collection: building an operator-facing
  way to type in payments would be building the thing this module explicitly does not claim to
  have. The events in this walkthrough are posted to the adapter directly.

- **Every screen is provisional** — no Figma design exists, and each one says so at the top.
  See `FIGMA_UX_HANDOFF.md`. They are built from the existing ERP components and the
  documented flow; they are functional, not final.

- **A payout is a record, not a transfer.** There is no payment integration and the screen
  says so.

- **Recording a sample does not move stock.** The roastery has one inventory path with its own
  guards; the CRM does not become a second way to decrement a shelf.

- **Nothing sends email, SMS or WhatsApp.** Logging a call records that it happened. A CRM
  that logs "sent" without sending is worse than one that logs nothing.

- **The quotation document prints through the browser**, not through a PDF renderer. Use the
  browser's *Print → Save as PDF*.

Everything else in the brief is built. `REQUIREMENTS_MATRIX.md` maps each requirement to the
screen and the named test that covers it, and marks explicitly what is refused and why.
