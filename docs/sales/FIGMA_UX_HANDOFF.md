# Figma / UX Handoff — **FIGMA_BLOCKED**

## Status: not delivered. This is an outstanding mandatory deliverable.

There is no Figma file, no prototype and no frame links, because the Figma integration in this
session is **not authorised**. This document records the exact blocker and what was built
instead, rather than substituting a screenshot or an in-code mockup and calling the
requirement met.

---

## 1. What was actually checked

The task said not to assume the official Figma MCP server is read-only, and to inspect real
capabilities rather than rely on recollection. That inspection was done:

| Check | Result |
|---|---|
| Is a Figma MCP server installed? | **Yes** — `plugin:figma:figma`, HTTP at `https://mcp.figma.com`. |
| Is it authenticated? | **No.** Only two tools are exposed: `authenticate` and `complete_authentication`. |
| Are any design tools available (create frame, component, variable, prototype)? | **No.** None are exposed while the server is unauthenticated, so its write capability could not be tested either way. |
| Was an OAuth flow started? | **Yes.** `authenticate` was called and returned an authorisation URL, which was given to the account holder. |
| Was it completed? | **No.** It requires the account holder to authorise in a browser. |
| Is there an alternative design surface? | A Claude design-system connector exists, but it manages code-based component libraries — it is not Figma and would not satisfy an "editable Figma file" requirement. |

The account holder's instruction was explicit: their authorisation message does **not**
replace the interactive OAuth step, and I must not bypass it, impersonate approval, or ask
them to paste callback URLs or tokens into chat. So the flow is **left pending**, which is the
correct end state rather than a failure to try.

---

## 2. What to do to unblock it

1. Open the authorisation URL produced by the Figma MCP `authenticate` call (re-runnable at
   any time; it prints a fresh URL).
2. Authorise the connection in the browser, as the Figma account holder.
3. Once the server's real tools appear in a session, the design work can begin — and the first
   thing to establish is whether the server can **write** native canvas content, since a
   read-only Dev-Mode connection would still leave the "create an editable file" requirement
   unmet and would need a different route (the Figma REST API with a personal access token, or
   a person doing it in the app).

**Do not treat step 3 as a formality.** Whether this server can create frames, components and
prototypes has not been demonstrated, and claiming it can would be a guess.

---

## 3. What was built instead, and how it is marked

Per the explicit exception granted — provisional UI using existing ERP components so backend
work was not held hostage to a design tool — two screens were implemented:

| Screen | Route |
|---|---|
| Leads | `/dashboard/sales/leads` |
| My commissions | `/dashboard/sales/my-commissions` |

Both carry a **visible amber banner in the interface itself** reading *"Provisional interface —
pending design review"* / *«واجهة مبدئية — في انتظار مراجعة التصميم»*. A provisional screen
that looks finished is worse than one that admits it, because nothing that appears already
signed off gets reviewed.

### UX decisions made in the absence of a design, and why

These are decisions a designer should review, not settle facts:

- **The next commitment is a column, not a detail.** `nextFollowUpAt` sits on the lead row and
  a lead with none says so in amber. The commonest failure in a sales pipeline is a lead
  nobody owns a next step for, and that has to be visible without opening anything.
- **Overdue is counted in the header.** A number beside the title, not a filter the user has
  to think to apply.
- **Duplicates are surfaced, never merged, and never silently blocked.** A phone match is
  treated as strong (one handset, probably one person); a company match is weak, because
  several buyers at one café is the normal case. On a strong match the save is refused once,
  the candidates are listed, and a *Create anyway* button lets the operator proceed
  deliberately.
- **Required fields first, optional after.** Company, contact, then phone/city/source/
  follow-up. A long form gets abandoned halfway and leaves a half-built record.
- **The commission screen shows the arithmetic, not a total.** Each accrual carries collected,
  of which tax, qualifying base and effective rate. A final number nobody can check is not an
  explanation, and a commission figure is exactly the number people argue about.
- **Status is never colour alone.** Every badge carries a word as well as a tone.
- **Arabic is the default and is first-class.** Labels are authored in both languages, the
  layout inherits the app's existing RTL handling, and phone numbers are forced `dir="ltr"`
  inside RTL text so they do not render reversed.

### Not built, and honestly so

Pipeline Kanban, deal detail, activities/tasks, quotes, sales targets and commission
administration screens are **not implemented**. The nav links to Pipeline exist but the page
does not, which is itself a gap to close — either build it or remove the link. Designing nine
screens against no design system, then rebuilding them once a design exists, would be waste;
the two screens that were built are the ones the end-to-end flow needed.

---

## 4. Reconciliation plan, for when Figma is available

1. Establish whether the connection can write to a canvas. If not, stop and report that
   instead of improvising.
2. Find the authorised ERP design file or design system and confirm it belongs to this system
   before using its tokens. Do not assume colours, type or logo from memory.
3. Build the flows for all three roles — rep, manager, finance — as wireframes first, then
   high-fidelity, then an interactive prototype.
4. Reconcile the two provisional screens against the design, then remove the provisional
   banner **only when the screen actually matches**.
5. Record a frame-URL → route/component mapping in this file, and a visual comparison at the
   agreed breakpoints with any intended differences explained.

Until steps 1–5 are done, **this feature must not be described as scope-complete**, whatever
the state of the backend.
