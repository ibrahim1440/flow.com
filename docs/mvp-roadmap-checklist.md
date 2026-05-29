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
| **Date last updated** | 2026-05-29 |
| **Phase 0 (Foundation)** | Complete |
| **Phase 1 (Pre-MVP)** | In progress — Google Drive triage remains |
| **Migration baseline** | Established 2026-05-22; three migrations tracked |
| **Active migrations** | `20260522000000_baseline`, `20260526115344_add_qc_final_decision_reason`, `20260528084853_add_rate_limit` |
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
