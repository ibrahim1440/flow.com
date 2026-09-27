# Preview Review Guide — Sales CRM & Commissions

**Hosted preview: live.** The URL and how to get into it are in §1. It runs the branch's own
code against an isolated database that contains only synthetic fixtures, with a sandbox
collection source and no outbound integration of any kind.

No password, PIN or connection string appears in this document. The reviewer signs in with
accounts seeded into the preview database; §3 says how to get them and where to read their
PINs.

---

## 1. The hosted Preview

| | |
|---|---|
| **URL** | `https://flow-com-git-feature-sale-adea3e-ibrahimmutambak-4927s-projects.vercel.app` |
| Branch | `feature/sales-crm-commissions` |
| Access | Vercel SSO — sign in with the account that owns the `flow` project |
| Database | `sales_preview` on `ep-wandering-leaf-aqjtuin5`, as the restricted role `sales_preview_app` |
| Collections | sandbox only, every row stamped `sourceSystem = "SANDBOX"` |

The URL above is the **branch alias**: it follows the branch and keeps working after every
redeployment, which the per-deployment URLs do not.

### Getting in

The project has `ssoProtection: all_except_custom_domains`, so every preview URL redirects to
Vercel's sign-in. That is deliberate and was not changed: the preview holds a full working
copy of the application and should not be world-readable. Open the link while signed in to the
Vercel account that owns the project and it will let you straight through.

A Protection Bypass for Automation secret was created so an automated smoke test could reach
the URL, and **revoked as soon as that finished**. If you want to run
`scripts/sales-preview/smoke-hosted.mjs` yourself you will need to create another one; the
script's README explains how, including the one header not to send.

### What it is safe to do here

Everything in §4. It is a disposable environment:

- No real customer, employee or order data exists in it — see `DATABASE_ISOLATION.md` §7.
- The credential the application runs as **cannot read any other database on that branch**,
  proven by 36 assertions, so a mistake here cannot reach the production-derived copy sitting
  on the same compute.
- Recording a collection moves no money. Approving a commission pays nobody. Marking a payout
  writes a record and says so on screen.
- There is no email, SMS, payment provider or queue anywhere in this module, so nothing you do
  can leave the system.

### One operational caution

`sales_preview` and the operational regression database share a single Neon compute on the
free tier. **Do not run the regression suites while somebody is using the hosted preview**, or
both will see dropped connections. `VERIFICATION_REPORT.md` §1a is what that looks like when
it happens.

### The deployment configuration, in case you need to change it

`vercel.json` controls whether pushing this branch deploys it:

```json
{ "git": { "deploymentEnabled": { "feature/sales-crm-commissions": true } } }
```

Keys are exact branch names and anything unlisted defaults to `true`, so this file affects
this branch and nothing else. It was set to `false` for the push that created the branch —
so that the branch could exist, and its environment be configured, before any build ran — and
flipped to `true` once the five branch-scoped Preview variables were in place.

Those five variables are scoped to this branch specifically:
`DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `PIN_LOOKUP_SECRET` and
`SALES_SANDBOX_COLLECTIONS`. Branch-scoped values take precedence over branch-agnostic
Preview values, which matters here: the project has a branch-agnostic Preview `DIRECT_URL`
pointing somewhere else, and the branch-scoped one is what stops it applying.

---

## 2. Running the same thing locally

The hosted preview is the easier route. Run it locally if you want to change code, or to watch
the guards refuse things.

The database already exists with all 21 migrations applied. Bring the app up against it as the
**restricted runtime role**:

```bash
PREVIEW_ENV=<the app env file> node scripts/sales-preview/withpreview.mjs next start -p 3020
```

Or drive it the way the tests do:

```bash
# The five API-level suites
PREVIEW_ENV=<the app env file> SALES_TEST_BASE_URL=http://127.0.0.1:3020 \
  node scripts/sales-preview/withpreview.mjs node scripts/e2e/regression/run-sales.mjs

# The browser suite, in the Chrome already installed on the machine
PREVIEW_ENV=<the app env file> BASE_URL=http://127.0.0.1:3020 \
  node scripts/sales-preview/withpreview.mjs playwright test --project=sales
```

The runner refuses to start unless **every** connection path names the approved endpoint, the
`sales_preview` database, **and** the restricted role `sales_preview_app`. If it prints
`REFUSE:`, it is doing its job — fix the target rather than the guard. It also refuses to run
`prisma` at all: migrations belong to a second identity with its own runner,
`withmigrate.mjs`, which in turn refuses to run anything but `prisma`.

`scripts/sales-preview/README.md` describes both env files and what each secret in them does.
Note in particular that `PIN_LOOKUP_SECRET` is not an ordinary secret: changing it makes every
seeded employee unable to sign in until the fixtures are regenerated.

Then open `http://127.0.0.1:3020`.

---

## 3. Roles to review with

**The quickest route: run the browser suite once.**

```bash
PREVIEW_ENV=<the app env file> BASE_URL=http://127.0.0.1:3020 \
  node scripts/sales-preview/withpreview.mjs playwright test --project=sales
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
