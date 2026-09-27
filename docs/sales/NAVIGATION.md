# Navigation — three levels from one registry

What the menu is, why the second level was missing, and what decides who sees what.

---

## 1. The root cause, with evidence

The contextual navigation in the reference design was **not removed and not broken. It was
never expressible.**

`src/app/dashboard/layout.tsx` held `NAV_ITEMS`: a flat array of 24 entries, eleven of them
Sales pages, rendered by one `.map()` into one level of links. Three things follow from that,
and all three were observable before any change:

- **No parent relationships.** Every entry was a sibling. A contextual bar shows *the pages of
  the section you are in*; there was no "section" for anything to be in.
- **No shared route metadata.** `requiredModuleFor()` re-derived a route's module by
  string-prefixing the same flat array. Nothing else could ask "what is this page's parent?"
  because nothing stored one.
- **No second-level component, anywhere.** `grep -rln "aria-current\|role=\"tablist\"\|SubNav\|
  TabNav\|Breadcrumb" src/` returned two files, both in-page panels
  (`sales/deals/[id]/page.tsx`, `components/OrderLifecyclePanel.tsx`) and neither part of the
  shell.

So this was not a regression to repair. The structure had to be created.

---

## 2. The model

| Level | Where it lives | Example |
| --- | --- | --- |
| Module | sidebar, as a disclosure | المبيعات |
| Subunit | sidebar, beneath the module | إدارة العملاء |
| Page | contextual bar inside the page | العملاء المحتملون · العملاء |

**The sidebar stops at the subunit.** Its pages appear once, in the bar, where you are already
standing. Listing them in both places is how a sidebar becomes a wall of links again, only
indented.

**A subunit with one destination shows no bar.** One tab is decoration pretending to be
navigation.

### Sales

| Subunit | Pages | Routes |
| --- | --- | --- |
| إدارة العملاء | العملاء المحتملون · العملاء | `/dashboard/sales/leads` · `/dashboard/customers` |
| الفرص والمتابعات | مسار الصفقات · الأنشطة والمتابعات | `/dashboard/sales/pipeline` · `/dashboard/sales/activities` |
| عروض الأسعار والطلبات | عروض الأسعار · طلبات البيع | `/dashboard/sales/quotes` · `/dashboard/orders` |
| التحصيلات | — (single destination) | `/dashboard/sales/collections` |
| الأداء والعمولات | الأهداف · تقارير المبيعات · عمولاتي · مراجعة العمولات · خطط العمولات | `/dashboard/sales/targets` · `/dashboard/sales/reports` · `/dashboard/sales/my-commissions` · `/dashboard/commissions/review` · `/dashboard/commissions/plans` |
| إعدادات المبيعات | — (single destination) | `/dashboard/sales/settings` |

**نظرة عامة is absent on purpose.** There is no `/dashboard/sales` page in the application, and
a placeholder would be a page that exists only to fill a row in a menu.

### Finance, Operations and the rest

| Module | Contents |
| --- | --- |
| المالية | التحصيلات · مراجعة العمولات · عمولاتي · المحاسبة |
| العمليات | الطلبات* · تجهيز الطلبات · الإنتاج · أوامر الإنتاج · التعبئة · التسليم · الجودة · التذوق |
| المخزون والمنتجات | المخزون · المشتريات · المنتجات · الملصقات |
| التقارير والسجل | التحليلات · السجل |
| singles | لوحة التحكم · الموظفون · الإعدادات |

* **Orders is placed deterministically, once.** `/dashboard/orders` is a sales order to a
salesperson and the thing being prepared to operations, and both need it. The Sales
placement carries `requiresAll: [sales]`; the Operations placement carries
`unlessAny: [sales]`. So whoever holds the sales module meets it under Sales, everybody
else meets it under Operations, and **nobody meets it twice**. Dispatch, production and the
legacy order-taking role no longer see a "Sales" heading that exists to hold one link.
العملاء works the same way: under Sales for a CRM user, a plain top-level entry for anybody
else. Asserted for all nine role definitions and all fifteen accounts in the preview
database.

**Order preparation moved to Operations**, which is where fulfilment belongs. Its route and its
permissions are untouched; only its listing changed. The order it prepares is the same record
the sales list shows — one system, two contexts.

---

## 3. What decides visibility

`src/lib/nav/registry.ts` is the single description: stable id, Arabic and English label,
route, parent, order, icon, required abilities. Sidebar, contextual bar, breadcrumbs,
active-page resolution and the dashboard route guard all read it.

- `anyOf` — the caller needs **one** of these abilities.
- `requiresAll` — additionally required for the node to appear **at this position**, without
  changing who may reach the page.
- `alsoMatches` — extra path prefixes that belong to a destination, so a detail page resolves
  to the list it came from.

### The Finance/Sales overlap

The commission screens are Sales work for a manager and Finance work for a finance user, and
Finance deliberately holds **no sales module** so it cannot read the pipeline. The Sales-side
placements carry `requiresAll: [sales]`; the Finance group carries `anyOf: [approve,
record_payout, collection_verify/reject/reverse]`.

| Role | Sees | Does not see |
| --- | --- | --- |
| Sales rep | المبيعات, العمليات | المالية |
| Sales manager | المبيعات (+ الإعدادات), العمليات, المخزون | المالية |
| Finance | المالية | المبيعات |

Every real role sees exactly one framing. Only an administrator, who holds every ability at
once, meets both — asserted as the single permitted exception.

### Visibility is not authorisation

> Hiding an entry hides a door. It does not lock one.

Every API re-checks the caller on every request. The shell's route guard exists so nobody is
shown a working-looking screen for work they cannot do, and it **deliberately keeps the
previous module-level semantics**: sub-privileges stay with the page and its API. Tightening it
would change who can open several existing screens, which a navigation change has no business
doing.

---

## 4. Behaviour

- A group opens at its **first permitted destination**, never a fixed default.
- A module or subunit with no permitted destination is **not rendered**.
- The group containing the current page opens itself; opening another is the reader's choice
  and is remembered. Derived, not synchronised through an effect — that would re-open a group
  the reader had just closed.
- Navigation is **client-side**. The previous sidebar used raw `<a href>` and reloaded the whole
  document on every click.
- Detail routes resolve to their list: a deal marks مسار الصفقات in both the sidebar and the bar.
- Deep links, refresh, Back and Forward all keep the markers correct.

### Accessibility

`aria-expanded` on each disclosure, `aria-current="page"` on the current page and `="true"` on
its section, labelled `<nav>` landmarks, keyboard-operable buttons, visible focus, Escape closes
the drawer, focus enters the drawer on open and returns to the opener on close. Nothing is
hover-only.

The contextual bar is **links styled as tabs, and is not announced as a tablist**. Tab semantics
describe panels swapped inside one document; these are separate URLs that must survive a
bookmark, a refresh and the Back button, and announcing them as tabs would promise arrow-key
behaviour that neither exists nor should.

### Unsaved work

`useUnsavedGuard` warns before a navigation discards unsaved changes — `beforeunload` for exits
that leave the application, and a capture-phase click interception for in-app links, because the
App Router exposes no navigation-start event. It is wired to the **quotation editor**, the only
form in the module that tracks a dirty flag. Other forms do not track one; adding that is a
change to those forms, not to the navigation.

---

## 5. Proof

| Suite | What it proves | Assertions |
| --- | --- | --- |
| `scripts/e2e/regression/navigation.ts` | The tree, against the real roles and the routes on disk | **117** |
| `scripts/e2e/regression/navigation-roles.ts` | The tree against every active account in the preview database | **108** |
| `scripts/e2e/regression/reviewer-collections.ts` | The actual `RVW_` reviewers, submitting and deciding | **49** |
| `tests/shell/navigation.spec.ts` | The rendered shell in a real browser, at three widths | **35** |

The registry suite runs through `tsx` against the **source** registry and the **source** role
definitions the browser suites use, so it cannot drift from either. It asserts, for all nine
roles, that no destination reachable before the restructuring is gone and none appeared that
was not. **It caught four modelling bugs while the tree was still just data** — a route claimed
by two placements, Finance losing my-commissions, a baseline that mis-stated the old
`alsoIf` rule, and the admin duplicate set.

The browser suite covers the disclosure, the contextual bar, client-side navigation, Back and
Forward, deep links, the mobile drawer's focus and Escape behaviour, and that no page scrolls
the document sideways at 1440, 1024 or 390.

**Neither is authorisation evidence.** The API suites are.

### Running the browser suite

One command. Nothing to set up first, and nothing left behind:

```
npm run test:shell
```

Four things happen, in order:

1. **It guards.** `scripts/sales-preview/preview-guard.ts` reads the preview app env file
   and refuses unless the connection string is the approved preview endpoint, the
   `sales_preview` database and the restricted `sales_preview_app` role — plus the same
   denylist of protected endpoints and privileged roles that `withpreview.mjs` applies to
   processes. Production is unreachable from here by construction, not by convention.
   `PREVIEW_ENV` overrides the file; the default is the one the other Preview suites use.
2. **It provisions** the three disposable `NAV_` identities from the shared `ROLES`
   definitions (Playwright `globalSetup`). Their PINs live in `preview-guard.ts`, shared
   with the suite so the two cannot drift, and are never printed to a terminal or a report.
3. **It starts a dev server on :3100** through the existing `withpreview.mjs`, which
   refuses to boot Next against anything but the preview database. Its own port, so it is
   never confused with an ordinary `npm run dev`. Set `SHELL_BASE_URL` to manage the server
   yourself and the launcher is skipped.
4. **It deletes every `NAV_` account** afterwards (`globalTeardown`), whether the run
   passed, failed or was interrupted — and prefix-wide, so it also clears fixtures an
   earlier aborted run abandoned. If the delete itself cannot run it says so and fails
   loudly, rather than exiting quietly with accounts still live.

To drive the browser by hand, `npm run preview:nav-fixtures` and
`npm run preview:nav-fixtures:remove` are the same two steps on their own.

Never the `RVW_` reviewer accounts: their PINs were issued once, somebody may be holding a
session, and rotating one would invalidate it. To exercise a *real* reviewer's stored
authorisation, `scripts/e2e/regression/reviewer-collections.ts` mints a session instead —
`getUserWithPermissions` reads `active`, `role` and `permissions` live from the employee row
on every request, so the token proves only identity and the authorisation under test is the
one really stored. That is authorisation evidence. It is **not** evidence that hosted login,
cookies or action visibility work in a browser; only a hosted sign-in shows that.

---

## 6. Design

Figma page **`14 — Navigation`**: four editable components — `Nav / Sidebar Group`
(Collapsed·Expanded), `Nav / Sidebar Subunit` (Default·Active), `Nav / Contextual Page Tab`
(Default·Active), `Nav / Breadcrumb Trail` — and frames NAV-00 … NAV-07 covering the three
roles, a detail-page breadcrumb, 1440, 1024 and the mobile drawer open and closed.

### Recorded deviations

1. **Two palettes.** The shell predates the Sales design system: the sidebar uses `#1F2937`
   with `#7C3AED` for the active state, while the contextual bar uses `action/primary`
   `#4F46E5`. Not unified — changing the shell's palette is outside a navigation change. The
   frames draw it as it is, not as it should be.
2. **Figma auto-layout has no RTL direction.** The first child is always leftmost, so these
   frames are authored in mirrored visual order. Anyone editing them must keep that order.
3. **`createAutoLayout` frames arrive with an opaque white fill.** A structural container has
   to clear it or it paints over whatever it sits on — which is what hid the dark sidebar on
   the first attempt.
4. **The code came before the frames this time.** The root-cause diagnosis required building
   the registry to discover what the structure even was; the components and frames then
   document what shipped rather than proposing it.
5. **طلبات البيع and العملاء sit under Sales** per the approved table. A dispatch or production
   user holds `orders` without the `sales` module and will therefore see a Sales group
   containing only طلبات البيع. Nothing is hidden; gating the group on `sales` instead **would**
   hide it, which is why it was not done.

---

## 7. The two purples — determined, with evidence

**Both are intentional. Neither is an implementation bug.** They come from two design
decisions taken at different times, and nothing had reconciled them.

`git log -S` on `src/app/globals.css` gives the history directly. Commit **`dcefa3d`**,
*"style(ui): refresh theme to clean purple interface"*, changed:

```
-  --orange: #E25D2F;          →  +  --orange: #7C3AED;
-  --sidebar-active: #E25D2F;  →  +  --sidebar-active: #7C3AED;
```

The ERP shell was deliberately recoloured from a warm orange to violet for the whole
application. The variable kept its old name, which is why `--orange` holds a violet — a
**naming** defect, not a colour one. The Sales design system arrived later with its own
`--oo-action-primary: #4F46E5`.

So: 31 files use the shell token, 23 use the Sales token, and the boundary between them was
never drawn.

**What was corrected here:** the navigation I introduced straddled that boundary — a violet
sidebar beside an indigo contextual bar, two purples inside one navigation system. The bar
now uses the shell token, so the whole navigation chrome is one colour. The Figma component
was updated to follow the corrected code, and its description records why.

**What was not corrected, and should be decided rather than guessed:** whether the ERP
unifies on `#7C3AED` or `#4F46E5`, and whether `--orange` is renamed. That touches 54 files
across every module and is a design decision, not a navigation change.

---

## 8. Unsaved work — the full inventory

Every dashboard page with an editable field, classified by whether a client-side navigation
can actually lose anything. A field inside a dialog is dismissed with the dialog; a search
or filter loses nothing; a page-level draft saved by an explicit button is the real risk.

| Route | Page-level fields | Risk | Guard |
| --- | --- | --- | --- |
| `/sales/quotes/[id]` | 8 (line editor) | **real** — inline, explicit Save | **yes** |
| `/sales/leads/[id]` | 16 (edit panel) | **real** — inline, explicit Save | **yes** |
| `/sales/leads` | 9 (create form) | low — a fixed overlay covers the page, so nav is unreachable while open | yes (covers refresh/close) |
| `/orders` | 15 | **real** — order entry, explicit Save | no |
| `/qc` | 15 | **real** | no |
| `/inventory` | 10 | **real** | no |
| `/purchases` | 9 | **real** | no |
| `/employees` | 6 | **real** | no |
| `/dispatch` | 5 | **real** | no |
| `/products` | 2 page + 21 dialog | low — the editing is in dialogs | no |
| `/commissions/plans`, `/commissions/review`, `/sales/deals/[id]`, `/sales/collections`, `/sales/settings`, `/sales/targets` | 0–1 | none — all editing is in dialogs | n/a |
| `/customers`, `/cupping`, `/history`, `/labels`, `/packaging`, `/production`, `/profile`, `/settings`, `/sales/pipeline`, `/production-orders/[id]` | filters, or no explicit save | none | n/a |

**Six pages outside the Sales module remain unprotected** — `/orders`, `/qc`, `/inventory`,
`/purchases`, `/employees`, `/dispatch`. Each needs its own notion of "dirty" (what the
baseline is, when a save resets it), which is a change to those pages and their tests, not
to the navigation. They are listed here rather than left to be discovered.

`isDirtyAgainst(active, value, baseline)` is a plain comparison, not a hook holding a
snapshot: the first version kept the baseline in a ref written during render, which the
React Compiler lint refuses, and rightly.

**A latent bug found while testing this:** `load()` on the lead detail page re-seeded the
form from the server unconditionally, so a reload arriving while the edit panel was open
discarded whatever had been typed. React StrictMode makes it reproducible in development by
running the mount effect twice. It now re-seeds only when the panel is closed — and
`saveEdits` closes the panel before reloading, so a save still refreshes correctly.

---

## 9. Latin digits in the shell

The Sales digit audit mounts page **components** against fixtures. The shell is not in it,
and the header date was calling `toLocaleDateString("ar-SA")`, which renders
**السبت، ٢٦ سبتمبر ٢٠٢٦** — Arabic-Indic digits, through every previous green run.

Corrected to `ar-SA-u-nu-latn-ca-gregory`, the same locale the Sales formatters use, and
covered by a shell-level audit at all three widths so it cannot come back.

**Still outstanding, outside this module:** `dashboard/page.tsx:223`,
`inventory/page.tsx:554`, and three call sites in `purchases/page.tsx` use raw `"ar-SA"`
and will render Arabic-Indic digits. Whether the Latin-digit rule extends beyond Sales is a
product decision; the locations are recorded so it is a decision and not a discovery.
