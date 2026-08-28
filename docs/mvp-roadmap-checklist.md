# Hiqbah Coffee ERP — MVP Roadmap & Readiness Checklist

> **Living document.** Update this file whenever a checklist item is completed, a policy decision is made, or the MVP scope changes.
> **Report first, approve each step** — no code, schema, or doc changes until the user confirms.

---

## 1. Purpose and How to Use This Document

This document tracks the path from current state to internal MVP launch for the Hiqbah Coffee ERP.

- **Phase 0** — Foundation work already completed. Do not reopen.
- **Phase 1 (Pre-MVP)** — Required before the system can be considered ready for internal production use. Complete these in order.
- **Phase 2 (Post-MVP Backlog)** — Planned but deferred until after MVP is stable.
- **Go/No-Go criteria** — The 12 items in Section 9 must all be satisfied (or formally deferred) before internal MVP launch.

**How to use:** Check off items as they are completed. For policy decisions, record the decision text in-line. For deferred items, note the rationale.

---

## 2. Current Status Summary

| | |
|---|---|
| **Date last updated** | 2026-08-26 |
| **Phase 0 (Foundation)** | Complete |
| **Phase 1 (Pre-MVP)** | In progress — Google Drive triage remains |
| **Migration baseline** | Established 2026-05-22; three migrations tracked |
| **Active migrations** | 13 tracked. Baseline through `20260801111404_add_order_operations_s0`, plus `20260826090000_add_shelf_allocation`, `20260826120000_backfill_shelf_reservations` and `20260827090000_allow_roast_to_stock` — all three on the local test DB only, not yet deployed to demo or production. |
| **Production deployment** | `prisma migrate deploy` in `package.json` build script |
| **Open Go/No-Go blockers** | Google Drive triage |

---

## 3. Foundation Layer — Completed Work

> Phase 0. All items below are done. Do not reopen without an explicit remediation decision.

- [x] **Migration baseline established (2026-05-22)** — Option A full-replacement baseline executed. `_prisma_migrations` now tracks `20260522000000_baseline`. `prisma migrate deploy` is the production deployment command.
- [x] **Five P0 CHECK constraints documented** — Non-negative inventory quantities enforced at DB level via `prisma db execute`. Documented in `docs/migration-drift-and-db-constraints.md`.
- [x] **R01: Purchase receive guard aligned** — `POST /api/purchases` enforces `requireSub("inventory", "receive")`.
- [x] **R02: QC view_records guard enforced** — `GET /api/qc-records` changed from `requireModule("qc")` to `requireSub("qc", "view_records")`.
- [x] **R04: Translate rate limiting** — `POST /api/translate` rate-limited at 60 requests / 15 min per authenticated user. Uses `RateLimit` table and `checkAndRecordRateLimit` helper.
- [x] **R05: Public cupping rate limiting** — All four public cupping route handlers rate-limited. GET: 60 / 15 min per IP. POST: 20 / 15 min per IP.
- [x] **R04/R05 migration** — `20260528084853_add_rate_limit` generated on Neon dev branch, reviewed, and deployed to production via `prisma migrate deploy`.
- [x] **QC final decision reason field** — `20260526115344_add_qc_final_decision_reason` migration tracked and applied.
- [x] **Documentation synced** — `docs/module-map.md`, `docs/migration-drift-and-db-constraints.md`, `docs/saas-readiness.md` updated to reflect all Phase 0 work.

---

## 4. MVP Scope Definition

The MVP is the system as it currently stands, with the Phase 1 pre-MVP items below completed. The MVP is **not** a multi-tenant SaaS product. It is a single-tenant internal ERP for one coffee roastery.

**In scope for MVP:**
- All 17 modules listed in `docs/module-map.md`
- Single-tenant, JWT-cookie auth
- Existing Prisma / Neon / Next.js stack

**Explicitly out of scope for MVP:**
- Multi-tenancy (no `tenantId`, no Tenant model, no JWT payload changes)
- RBAC Role model
- AuditLog model
- Billing / subscriptions / entitlement
- SaaS features of any kind

---

## 5. Pre-MVP Checklist — Phase 1

> Complete these before internal MVP launch. Policy decisions must be recorded in-line before the relevant criterion can be checked off.

### Required items

- [x] **R06: `.env.example` documented (2026-05-28)** — `TRANSLATION_API_KEY` (external translation API) and `RATE_LIMIT_SECRET` (HMAC key for rate limit hashing) added to `.env.example` with descriptions. No schema or DB change.

- [x] **R07: MVP safe limits applied (2026-05-28)** — Default hard limits added to all heavy GET endpoints. Full cursor-based pagination deferred to Phase 2.

  > **Implementation:** `take: 1000` on all four heavy export variants in `GET /api/export` (orders, production, qc, deliveries). `take: 500` on `GET /api/roasting-batches`, `GET /api/orders`, `GET /api/deliveries`, `GET /api/qc-records`. `take: 50` on the `openQcBatches` query in `GET /api/analytics`. `GET /api/inventory-movements` already had `take: 300` and was not changed. Response shapes and frontend pages are unchanged. No schema or migration changes.

- [x] **Policy decision: Delivery without FinishedGoodsLot** — Decided and enforced.

  > **Decision:** All new deliveries must reference a FinishedGoodsLot. No-FGL delivery submissions are rejected with 400. Samples, corrections, and exceptional withdrawals require future dedicated workflows. Enforced 2026-05-28 — `POST /api/deliveries` rejects missing `finishedGoodsLotId`.

- [x] **Policy decision: Admin reset + ledger orphans** — Decided and implemented 2026-05-28.

  > **Decision:** Admin reset performs full operational data reset. It deletes all transactional and operational records including inventory movements, purchase records, finished goods lots, production orders, cupping sessions and scores, orders, deliveries, batches, customers, and green beans. It preserves employees, suppliers, product catalog (CoffeeProduct, ProductSKU), system settings (SystemConfig), and security/rate-limit metadata (LoginAttempt, RateLimit). CoffeeProduct was removed from the deletion list — it is catalog/master data, not operational data. Enforced 2026-05-28 — `POST /api/admin/reset` now performs the full operational reset. Frontend warning text updated to accurately describe the full scope.
  >
  > **Training Reset** (`POST /api/admin/training-reset`) added 2026-05-29 — extends Admin Reset scope by also deleting catalog data (ProductSKU, CoffeeProduct, Supplier) for demo/training phase cleanup. Requires `settings.training_reset` sub-privilege (admin only by default). For use before real production data is entered only. Must not be used after real production data is entered.

### Optional items (complete before MVP if time allows)

- [ ] **labels.print sub-privilege enforcement** — The `print` sub-privilege is defined in `auth-shared.ts` but no labels route enforces it. Module-level access is the only check. Low risk if only trusted employees have labels access.

- [ ] **qc.edit_record route** — The sub-privilege is defined but no edit route exists. Required only if QC record editing is needed before MVP launch.

---

## 6. Post-MVP Backlog — Phase 2

> Planned work. Do not start until Phase 1 is complete and MVP is stable.

### Schema / migrations
- Add RBAC `Role` model (when authorized)
- Add `AuditLog` model (when authorized)
- Order `approvalStatus` and `paymentStatus` dedicated transition routes
- Blend transformation InventoryMovement ledger entry

### Architecture
- Automated pruning job for `RateLimit` table (currently pruned inline on each request; acceptable at MVP scale)
- Cursor-based pagination across all list endpoints
- Structured error logging and observability

### Features
- QC record edit route (`PUT /api/qc/[batchId]/records/[recordId]`)
- Delivery model FK to FinishedGoodsLot (currently FGL reference is stored only in `InventoryMovement.referenceEntityId` — no FK on `Delivery` record)
- `ProductionOrder` integration with the primary production workflow
- `approvalStatus` / `paymentStatus` transition UI

---

## 7. Remaining Foundation Risks

> Risks carried forward. Each must be resolved or formally deferred before Go/No-Go.

| Risk ID | Severity | Description | Status |
|---|---|---|---|
| R06 | P3 | `TRANSLATION_API_KEY` missing from `.env.example` — undocumented required env var | **Closed 2026-05-28** — `TRANSLATION_API_KEY` and `RATE_LIMIT_SECRET` documented in `.env.example`. |
| R07 | P3 | No pagination on analytics and other large GET endpoints — unbounded queries | **Closed 2026-05-28** — MVP safe limits applied. Full cursor pagination deferred to Phase 2. |
| labels.print | P3 | `labels` sub-privilege `print` defined but not enforced by any route | Open — acceptable for MVP if access is restricted to trusted employees |
| qc.edit_record | P3 | `qc` sub-privilege `edit_record` defined but no edit route exists | Open — no edit route needed for MVP unless explicitly requested |
| Delivery FGL | P4 | Deliveries without `finishedGoodsLotId` create no InventoryMovement ledger entry | **Closed 2026-05-28** — `POST /api/deliveries` rejects missing FGL with 400; UI no longer allows no-lot submission |
| Blend InventoryMovement | P4 | Blend transformation (`isBlend: true`) creates no InventoryMovement entry | Deferred to Phase 2 |
| approvalStatus | Info | `approvalStatus` / `paymentStatus` have no write path; all orders retain default values | Deferred to Phase 2 |
| Admin reset | Info | Admin reset is full operational data reset — all transactional records deleted; Employee, Supplier, CoffeeProduct, ProductSKU, SystemConfig, LoginAttempt, RateLimit preserved | **Closed 2026-05-28** |
| Training reset | Info | Training Reset (`POST /api/admin/training-reset`) extends Admin Reset scope — also deletes catalog data (ProductSKU, CoffeeProduct, Supplier). Admin-only (`settings.training_reset` sub-privilege). For demo/training phase cleanup before real production data is entered only. | **Added 2026-05-29** |
| QC rejection flow | Info | No enforced downstream policy when QC finalizes with a reject decision — batch is not automatically quarantined or flagged | Deferred to Phase 2 |
| R09+ | Deferred | Remaining identified risks (R09–R24) — not yet reviewed or approved | Deferred to Phase 2 |

---

## 8. Google Drive ERP TXT Files Intake Plan

> **Important:** Google Drive TXT file triage is a **dedicated controlled phase**. It must not be interleaved with active foundation remediation work. Schedule it as a separate review session only after the minimum foundation checklist (Phase 1 required items) is stable. Do not start triage while R06, R07, or policy decisions are still open.

The project has ERP-related TXT files stored in Google Drive. These may contain business requirements, workflow specifications, or operational decisions not yet reflected in the codebase or this document.

**Planned triage process (when scheduled):**
1. Pull all ERP TXT files from Google Drive into a local review folder.
2. Read each file and classify: (a) already implemented, (b) MVP-blocking gap, (c) post-MVP backlog, (d) superseded / irrelevant.
3. For any MVP-blocking gap: open a new remediation item in this checklist and assign a risk ID.
4. For any item classified as deferred: record rationale in the Phase 2 backlog.
5. Update Go/No-Go criterion #12 once triage is complete.

**Pre-conditions before starting triage:**
- Phase 1 required items (R06, R07, delivery FGL policy, and admin reset policy) are complete as of 2026-05-28. Google Drive ERP TXT files intake remains a dedicated controlled phase and must not interrupt foundation remediation work.
- A dedicated review session must be explicitly scheduled — triage must not begin reactively mid-remediation.

**Triage outcome (2026-05-28):** Google Drive ERP TXT controlled triage completed for MVP Go/No-Go. No MVP-blocking requirements were found. Periodic Inventory Count and QC Testing Waste Logging are formally deferred to Phase 2. All remaining Drive files are treated as future-state reference material unless later approved through a separate requirements intake process.

---

## 8b. Shelf-First Fulfilment — Delivered 2026-08-26

> Scope note: this closes a set of defects in the existing order/inventory workflow. It adds
> no new module and no new sub-privilege, and it does not change the MVP scope defined in
> Section 4.

The system tracked packaged roasted coffee (`FinishedGoodsLot`) but could not sell it to any
order other than the one it was roasted for, and the split between "already on the shelf" and
"must be roasted" was a number typed by a clerk that nothing verified. Seven defects were
reproduced against a seeded database before any code changed, and each is now covered by an
assertion in `scripts/e2e/`.

| # | Defect | Resolution |
|---|---|---|
| D1 | `POST /api/deliveries` measured eligibility from the order item's own packaged batches but deducted from any product-matching lot — a full shelf was unsellable, and a passing delivery could reduce a lot the check never measured | Eligibility and deduction now speak about the same kilograms, via `consumeShelfStock()` |
| D2 | Preparation review stored client-supplied `availableQuantity` / `productionRequiredQuantity` without ever reading stock | Both are server-derived; a client-supplied decision is a claim and is refused with 409 when stock cannot back it |
| D3 | No reservation existed — N orders could all rely on the same kilograms, discovered only at shipping | `FinishedGoodsLot.reservedQty` + `StockAllocation`, taken under a conditional `UPDATE` |
| D4 | The roasting surplus gate compared against the full ordered quantity, so an item covered from the shelf still queued a full-size roast | Ceiling is now `productionRequiredQuantity ?? quantityKg` |
| D5 | Order creation checked green beans only and refused orders the shelf could fill | `checkOrderAvailability()` lets the shelf absorb each line first |
| D6 | `greenBeanId` was optional on `POST /api/roasting-batches`, so a batch could consume no stock and write no ledger row | Rejected with 400. Blends are unaffected — they consume no green coffee by design |
| D7 | `fulfillment-options` derived shortage from `remainingQty`, whose meaning changes mid-lifecycle | Returns explicit `outstandingQty` / `freeToPromiseQty` / `shortageQty`; `remainingQty` keeps its own meaning and is documented |

**Also fixed:** both admin reset routes now delete `StockAllocation` before `FinishedGoodsLot`.
Without it the `ON DELETE RESTRICT` foreign key aborts the entire reset transaction — verified
by reverting the fix and watching `POST /api/admin/reset` return 409.

### Adversarial review round

The change was then reviewed across four lenses (concurrency, business-logic correctness,
regression/backward-compatibility, and authorisation/UI truthfulness), with every claim
independently verified before being accepted. 24 defects were raised and 18 survived
verification. All 18 are closed. The ones worth recording:

| Severity | Defect | Resolution |
|---|---|---|
| P0 | The dispatch lot picker filtered by free-to-promise, so a lot reserved to the very order being delivered was hidden — packaging reserves a batch's whole output to its own order, which drove that lot's free quantity to zero and made the ordinary roast → package → deliver path impossible from the UI | Dispatch now asks `GET /api/order-items/[id]/fulfillment-options`, which returns each lot's `deliverableQty` for that item (its own reservation plus free stock). Covered by the OWN-LOT scenario in `shelf-flow.mjs` |
| P1 | `consumeShelfStock` checked the lot's aggregate `reservedQty`, so a concurrent release could let a delivery ship another order's reserved kilograms | The item's own allocation rows are now CLAIMED first with a guarded `updateMany`; only kilograms this transaction actually won are shipped against the promise |
| P1 | The dispatch "ready for delivery" list still gated on the item's own packaged batches — the exact rule D1 removed from the server — so a shelf-covered order never appeared | The list now also admits items with shelf coverage |
| P1 | An item reserving across several lots but delivered from one left the other reservations standing forever | `trimReservationToDemand()` runs after every delivery |
| P1 | Deleting an order or a line cascaded `StockAllocation` away without decrementing `FinishedGoodsLot.reservedQty`, permanently inflating it | Both delete paths release first, inside a transaction |
| P1 | The roasting ceiling read the stored `productionRequiredQuantity`, which goes stale and, for rows written before reservations existed, carries clerk-typed values — a stored `0` would have blocked production outright | The ceiling is derived live: ordered quantity minus what is actually reserved |
| P1 | The production screen still prefilled and validated roasts against the full ordered quantity, guaranteeing a 422 on any partially covered item | Both now use ordered minus shelf coverage |
| P1 | The review panel derived its decision from post-reservation numbers and showed "Needs Production" for an item that was already fully covered | `derivePreparationDecision` now evaluates the state a submission would leave behind, and takes the existing reservation into account |
| P2 | Packaging re-reserved stock to cancelled and Blocked items, stranding it | The auto-reserve skips them |
| P2 | The reservation guard compared a rounded JS figure against raw float columns and could silently skip a whole lot | Half a gram of tolerance on the column side of the comparison |
| P2 | `reservedQty` defaulted to 0 for lots that were already packaged-but-undelivered, so a new order could reserve them away from the order that paid for the roast | Migration `20260826120000_backfill_shelf_reservations` claims each such lot for its own live order item. Idempotent, and it deliberately leaves cancelled orders' lots free |
| P2 | A failed stock fetch left rows rendering as "Not Reviewed" while still being submitted | Save is refused when any included item has no stock data |

**Verification:** `npx tsc --noEmit` exits 0; `npm run build` succeeds; eslint is at its
pre-change count (47 problems, none in the changed files); 30/30 assertions in
`shelf-flow.mjs`, 6/6 in `race.mjs` (six concurrent orders against a 10kg shelf — exactly
one wins), 5/5 in `reset.mjs`. All three suites were also run against a database built from
scratch — `prisma migrate deploy` then `npm run seed` — not only against an incrementally
migrated one.

**Accepted and not fixed:**

- `checkOrderAvailability` at order-creation time counts the same free shelf for every
  pending order, because nothing is reserved until preparation review. Two orders can
  therefore both be accepted against stock that covers only one; the second is corrected at
  review, which is where the reservation is actually taken. Reserving at creation would
  hold stock for orders that may never be approved.
- `decisionFor(0, 0)` labels a fully delivered item "Available on Shelf". It reads oddly but
  is harmless — there is nothing outstanding to source either way.
- The order form's "covered from shelf" preview matches on product only, while the
  reservation also enforces SKU, so the preview can be optimistic for an order that names a
  SKU. The server is authoritative and corrects it at review.

**Known limitation, not a defect:** shelf pooling needs the coffee to be identifiable. It keys
on `productId`, falling back to the order item's `greenBeanId`. Historical rows in this database
have neither — all 44 seeded `OrderItem` rows have `productId`, `productSkuId` and `greenBeanId`
all NULL, identified only by a free-text `beanTypeName` — so shelf-first cannot apply to them and
they keep the old per-order behaviour. Both pickers are optional in the order form; making at
least one of them required is the change that would extend shelf-first to everything, and it is a
business decision rather than a bug.

**Not in scope at the time:** a WIP layer for roasted-but-unpackaged coffee remains Gap 3 in
`docs/inventory-ledger-coverage.md`. The "roast to stock" limitation recorded here was lifted
the following day — see Section 8c.

---

## 8c. Roast to Stock — Delivered 2026-08-27

Shelf-first fulfilment let orders *consume* the shelf, but nothing could *fill* it on purpose:
`RoastingBatch.orderItemId` was a required foreign key, so every roast had to name an order.
The only stock that ever reached the shelf was accidental — an admin over-roasting against an
order, or leftovers from a cancelled one. Half a mechanism.

`orderItemId` is now nullable (migration `20260827090000_allow_roast_to_stock`, a widening
`DROP NOT NULL` on 44 rows that all carry a value, so no backfill). A batch with no order item
is a **stock batch**:

- It consumes green stock and writes the same `OUT / RAW_MATERIAL` ledger entry as any roast.
- It **must** name a `productId`. An order-backed batch can inherit its product from its order
  item at packaging time; a stock batch has no order item, and a lot nothing can identify is a
  lot no future order can be matched to.
- At packaging there is no owner to reserve the output to, so the whole lot lands
  free-to-promise. That is the entire point.
- `recalcOrderItemStatus` is skipped; `qc-records/bulk-finalize` filters nulls out of its
  order-item list; blending stock inputs produces a stock blend.

**Authorisation.** Roasting to stock is deliberate surplus production — precisely what the
per-order surplus gate exists to control — and that gate cannot apply, because there is no
order to exceed. So it is gated on its own sub-privilege, `production.roast_to_stock`, rather
than falling out of `start_batch`. `allEdit("production")` grants it, so admin and the roasting
role keep it by default, but an admin can revoke it per employee. Verified: revoking it returns
403 for a stock batch while ordinary order-backed roasting still works.

**Verification:** `npx tsc --noEmit` exits 0; 18/18 assertions in `scripts/e2e/roast-to-stock.mjs`,
with `shelf-flow.mjs` (30/30) and `race.mjs` (6/6) confirming no regression.

### Adversarial review round

Four lenses (nullable-FK reachability, stock-batch semantics, UI/authorisation, data safety).
19 defects raised, 8 survived independent verification, all 8 closed. The ones worth recording:

| Severity | Defect | Resolution |
|---|---|---|
| P0 | The reserving side and the shipping side disagreed about which lots serve an order item. `lotMatchFilter` had gained a green-bean tier; `POST /api/deliveries` still restated a two-tier rule of its own. An order line naming a bean but no product could **reserve** a stock lot and then be **refused delivery** of it — stock stranded, order deadlocked | The delivery route now calls `lotMatchFilter` instead of restating it. Two copies of a rule is how they drifted apart in the first place |
| P1 | `roast_to_stock` was granted to the roasting role by default, which made the admin-only surplus gate circumventable by simply omitting the order item | `allEdit` gained an `except` list; the roasting role no longer receives it. An admin can still grant it per employee |
| P1 | The privilege is deny-by-default on a *missing* key, so it would have shipped inert for every existing employee — including admins, who have no bypass | `scripts/permission-backfill.ts` now understands `adminOnly` keys: a brand-new capability backfills as `false` for everyone and `true` for admins, rather than the usual "edit ⇒ true" rule which would have granted it to exactly the people it is being withheld from. Verified against simulated live rows: admin `true`, roasting `false` |
| P2 | Blending picked the blend's owner from `batches[0]` of an unordered `findMany`. With a stock batch in the selection, the same click could either orphan an order's production into free stock or claim stock for an order that never asked — decided by row order | Deterministic `orderBy`; mixed-ownership and multi-order selections are refused outright unless an `orderItemId` is named; **every** affected order item is recalculated, not just the winner |
| P2 | A stock blend inherited no product, so it could never be packaged — the same invariant `POST /api/roasting-batches` enforces was dropped on the blend path | A stock blend must resolve to a single product across its inputs |
| P2 | The blend modal showed nothing to distinguish a stock batch from an order-backed one | Each row now carries its owner (`#order` or `Stock`), and the client blocks the selection the server refuses |
| P2 | The stock roast form did not require a green bean, and the resulting 400 rendered *behind* the modal's own backdrop, so the button simply looked dead | Both fields are required and reflected in the submit state; the modal renders its own errors |
| P3 | The product picker was fed by an endpoint gated on the `orders` module while the feature is gated on production privileges — it rendered empty, silently, for a production-only user | `GET /api/coffee-products/summary` is now readable by `orders`, `production` or `packaging`. It is a name-and-id catalogue projection with no order or customer data in it |

**Verification:** `npx tsc --noEmit` exits 0; `npm run build` succeeds; eslint at its pre-change
count (47 problems, none in the changed files); **75 assertions pass** across five suites
(`shelf-flow` 30, `roast-to-stock` 18, `race` 6, `pages` 16, `reset` 5) against a database built
from scratch. `npm run e2e` now runs the first four.

**A caught regression worth naming:** making `orderItemId` nullable exposed **46 unguarded
dereferences** of `batch.orderItem` across the QC, packaging, production and cupping screens —
every one of which would have crashed the moment a stock batch appeared in those queues.
TypeScript could not see them because each page declared its own local type with `orderItem`
non-optional. Making those types honest turned the whole class into compile errors. The
API-level suites had all passed regardless: the break was in the browser, not the route.

**Still not in scope:** `ProductionOrder` remains dead code — there is no planning layer, no
minimum-stock level and no automatic replenishment. A stock roast is a human decision. The WIP
layer for roasted-but-unpackaged coffee is still Gap 3.

---

## 9. Go/No-Go Criteria for Internal MVP Launch

> All 12 criteria must be satisfied or formally deferred with documented rationale before the system goes into internal production use.

- [ ] 1. `prisma migrate deploy` runs cleanly in CI/CD with no pending migrations.
- [ ] 2. All five P0 CHECK constraints (`GreenBean`, `RoastingBatch` ×3, `FinishedGoodsLot`) verified present after the most recent migration.
- [x] 3. R06 complete: `TRANSLATION_API_KEY` and `RATE_LIMIT_SECRET` documented in `.env.example`.
- [x] 4. R07 complete: MVP safe limits applied to all heavy GET endpoints. Full cursor pagination deferred to Phase 2.
- [x] 5. Delivery FGL policy decided and documented in this file.
- [x] 6. Admin reset + ledger policy decided and documented in this file.
- [ ] 7. All module routes match their documented guards in `docs/module-map.md`.
- [ ] 8. All enforced sub-privileges match the "Enforced by route?" column in `docs/module-map.md`.
- [x] 9. `.env.example` reflects all required environment variables with descriptions. Verified 2026-05-28: required `DATABASE_URL` and `JWT_SECRET` are documented; optional `RATE_LIMIT_SECRET` and `TRANSLATION_API_KEY` are documented with fallback behavior; no real secrets present.
- [ ] 10. No P0 or P1 open security gaps remain unresolved or without a formal deferral decision.
- [ ] 11. All three migrations (`baseline`, `add_qc_final_decision_reason`, `add_rate_limit`) verified applied in production `_prisma_migrations`.
- [x] 12. Google Drive ERP TXT files either triaged and confirmed no MVP-blocking requirements remain, or formally deferred from MVP with documented rationale. Verified 2026-05-28: all 28 files were inventoried; no hard MVP blockers found. File 20 Periodic Inventory Count and File 21 QC Testing Waste Logging formally deferred to Phase 2 with rationale. Future-state master/checklist/architecture files are reference material, not MVP scope.

---

## 10. Recommended Next 3 Actions

> **Resolved 2026-05-28:** Pre-existing `.next/dev/types/app/dashboard/layout.ts` TS2344 error caused by exporting `useUser` and `useLogo` from `src/app/dashboard/layout.tsx`. Fixed by moving `User`, `AppCtx`, `UserContext`, `useUser`, and `useLogo` into `src/app/dashboard/user-context.tsx`. Updated 14 dashboard consumer imports. `layout.tsx` now exports only default `DashboardLayout`. `npx tsc --noEmit` exits 0 with no errors. No schema, migration, database, API route, package, or env changes.

> **Resolved 2026-05-28:** Google Drive ERP TXT controlled triage complete. All 28 files inventoried. No hard MVP blockers found. File 20 (Periodic Inventory Count) and File 21 (QC Testing Waste Logging) formally deferred to Phase 2. Go/No-Go criterion #12 closed.

1. **MVP readiness verification pass** — Run `prisma migrate status` to verify all three migrations applied in production, run `prisma migrate diff` to confirm no pending migration drift, run `npx tsc --noEmit`, attempt a full build, spot-check route guard behaviour, and run an end-to-end smoke test against the production database branch.
2. **Final MVP scope freeze** — Confirm what remains in-scope for internal MVP and what is explicitly deferred to Phase 2. Record any remaining open items as formally deferred with rationale before Go/No-Go sign-off.
3. **Prepare internal MVP launch checklist** — Define initial users and roles, confirm seed/admin data, verify backup and restore procedure, and draft an operating SOP for the roastery team.
