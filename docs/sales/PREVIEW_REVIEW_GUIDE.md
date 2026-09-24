# Preview Review Guide — Sales CRM & Commissions

**Hosted preview status: NOT DEPLOYED.** See §1 for the precise reason. A verified preview
runs locally against the isolated database, and §2 explains how to bring it up.

No passwords or PINs appear in this document. The reviewer uses accounts they create or that
are seeded into the preview database.

---

## 1. Why there is no hosted Preview URL

Pushing this branch to the git remote would create a Vercel preview deployment, and **a preview
deployment inherits project-level environment variables unless Preview-scoped ones exist.**
This project's production `DATABASE_URL` is stored in Vercel as a write-only Secret; whether it
is scoped to Preview as well as Production could not be read, because the Vercel connector in
this session returns no accessible teams and the CLI path is unavailable.

So a hosted preview could not be proven to be isolated — and an unproven preview of a module
that writes leads, customers and commission ledger entries is exactly the thing that must not
be pointed at production by accident. A Preview URL does not demonstrate database isolation.

**The one step that unblocks it:** set Preview-scoped `DATABASE_URL` and `DIRECT_URL` on the
Vercel project pointing at the `sales_crm_preview` database, plus `SALES_SANDBOX_COLLECTIONS=true`
scoped to Preview only. Then this branch can be pushed and the preview will be safe by
construction. Production variables must not be changed.

---

## 2. Running the verified preview

The preview database already exists and already has all 21 migrations applied. Bring the app up
against it with the guarded runner:

```bash
SALES_ENV=<preview env file> node withsales.mjs next start -p 3020
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
