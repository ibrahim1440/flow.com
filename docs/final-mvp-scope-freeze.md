# Final MVP Scope Freeze — Hiqbah Coffee ERP

**Date:** 2026-05-29
**Status:** PASS WITH WARNINGS — Technically ready for internal MVP soft launch review, with accepted P3/P4 warnings and operational launch prerequisites.

---

## Final Decision Statement

> **Internal MVP scope is frozen as of 2026-05-29.**
>
> The Hiqbah Coffee ERP is declared feature-complete for internal MVP. All 12 Go/No-Go criteria are satisfied or formally deferred with documented rationale. No new features enter MVP scope unless classified as P0 or P1 launch blockers. All other requests move to the Phase 2 backlog.

---

## Readiness Status

| | |
|---|---|
| **Overall result** | PASS WITH WARNINGS |
| **Go/No-Go criteria** | All 12 satisfied or formally deferred |
| **P0/P1 security gaps** | None found |
| **Accepted warnings** | P3/P4 only — see accepted warnings table below |
| **Deployment type** | Single-tenant internal ERP — not SaaS, not multi-tenant, not a public product |
| **Build status** | `npm run build` passes; `npx tsc --noEmit` exits 0 |
| **Migration status** | 3 migrations applied, no pending, no schema drift |
| **P0 CHECK constraints** | All 5 verified present in production database |

This status reflects the outcome of the Final Verification Closure Pass (2026-05-29) and all preceding Phase 0 and Phase 1 remediation work. It does not imply SaaS, enterprise production, or unrestricted public launch readiness.

---

## In-Scope MVP Modules

The following modules are implemented, route-guarded, and verified for internal MVP use. Detailed route paths, guard functions, and sub-privilege enforcement are documented in `docs/module-map.md`.

| Module | Summary |
|---|---|
| **Auth / Login / Profile** | PIN and username/password login. JWT-in-httpOnly-cookie (8h). DB-backed rate limiting on login. Profile self-service: phone, language, PIN change. |
| **RBAC permission system** | Five predefined roles (`admin`, `inventory`, `roasting`, `qc`, `dispatch`) plus `custom`. Module-level `none / view / edit` access. Sub-privileges per module. All enforced via `requireAuth`, `requireModule`, `requireEdit`, `requireSub`, `requireAnyModule`. |
| **Dashboard overview** | KPI tiles, weekly production chart, inventory alerts, QC alerts, order pipeline. `openQcBatches` safe limit: `take: 50`. |
| **Inventory basics** | Green beans, finished goods lots (read), inventory movements (read + manual adjust). All five P0 non-negative CHECK constraints enforced at the database level. |
| **Purchases** | Purchase records against green bean stock. `POST /api/purchases` requires `inventory.receive` sub-privilege. `GET /api/purchases` is module-guarded (`requireModule("inventory")`). Safe-limit status should be verified separately if purchase volume grows. |
| **Suppliers** | Supplier list and creation. Creation requires `inventory.adjust`. |
| **Inventory movements** | `GET /api/inventory-movements` (`take: 300`). Manual adjustment via `POST /api/inventory/adjust` (`inventory.adjust`). |
| **Roasting / production batches** | Create, cancel, blend, date-edit, and package batches. All writes sub-privilege guarded. `GET /api/roasting-batches` cross-module readable (`production`, `qc`, `packaging`). MVP safe limit: `take: 500`. Optional restock-on-cancel requires `inventory.override`. |
| **QC records and finalization** | Submit, view, and finalize QC records. Bulk finalization. Guest invite link generation. MVP safe limit: `take: 500` on record list. Final decision reason field supported. |
| **External guest QC** | `GET/POST /api/guest-qc/[batchId]/[token]` — token-authenticated external QC submission. No auth cookie required. Creates `QcRecord` with `isExternal: true`. Only active while batch status is `"Pending QC"`. |
| **Cupping basics** | Internal cupping sessions (create, close, score). Public cupping panel for external tasters via session token. Public routes rate-limited (60/15min GET, 20/15min POST per IP). Blind projection on public routes. |
| **Packaging via roasting batch package route** | `GET/POST /api/roasting-batches/[id]/package` guarded by `requireModule("packaging")`. InventoryMovement ledger entry created on packaging. FinishedGoodsLot created and linked. |
| **Finished goods lots** | `GET /api/finished-goods-lots` (read-only, inventory-guarded). FGL required for all new deliveries. |
| **Orders** | Create, edit, delete orders with order items. Sub-privilege guarded writes. `GET /api/orders` cross-module readable (`orders`, `production`, `dispatch`). MVP safe limit: `take: 500`. |
| **Deliveries / dispatch** | Mark delivery against a packaged FGL. Packaged-quantity guard enforced. `finishedGoodsLotId` required; missing FGL rejected with 400. MVP safe limit: `take: 500`. |
| **Customers / preferences** | Customer CRUD. Roast preferences per customer. `customers.manage` sub-privilege required for preference management. |
| **Products / SKUs / labels catalog basics** | CoffeeProduct and ProductSKU management. `GET /api/coffee-products` module-guarded; writes require `requireEdit("labels")`. CoffeeProduct is catalog/master data — preserved on admin reset. |
| **Employees basic management** | Create, update, delete employees. PIN uniqueness enforced via SHA-256 hash. `GET /api/employees` accessible to any authenticated user (cross-module design; no credential fields exposed). |
| **Admin reset** | Full operational data reset behind three independent guards: `settings.reset` sub-privilege + confirmation phrase (`RESET HIQBAH`) + admin PIN re-verify. FK-safe deletion order. Preserves catalog and config data (Employee, Supplier, CoffeeProduct, ProductSKU, SystemConfig, LoginAttempt, RateLimit). |
| **Training reset** | Demo/training phase cleanup tool. Extends Admin Reset scope to also delete catalog data (ProductSKU, CoffeeProduct, Supplier). Three independent guards: `settings.training_reset` sub-privilege + confirmation phrase (`CLEAR DEMO DATA`) + admin PIN re-verify. For use before real production data is entered only — must not be triggered after real production data exists. Preserves: Employee, SystemConfig, LoginAttempt, RateLimit. |
| **Logo / branding** | Upload, replace, or remove company logo stored in `SystemConfig`. `PUT /api/settings/logo` requires `requireEdit("settings")`. `GET /api/settings/logo` is unauthenticated (required for login page). |
| **History / export with MVP safe limits** | `GET /api/export?type=<type>` for orders, production, qc, deliveries — `take: 1000` per type. Guarded by `requireModule("history")`. |
| **Analytics / dashboard predictions** | `GET /api/dashboard/predictions` guarded by `requireModule("analytics")`. No pagination; acceptable at current data volumes. |
| **Rate limiting (translate + public cupping)** | Translate: 60 req / 15 min per authenticated user. Public cupping GET: 60 req / 15 min per IP. Public cupping POST: 20 req / 15 min per IP. Stored in `RateLimit` table; inline pruning on each request. |
| **Translation endpoint** | `POST /api/translate` with `requireAuth()` + rate limit. Google Cloud Translation if `TRANSLATION_API_KEY` configured; falls back to MyMemory free API. Input capped at 2000 characters. |

---

## Explicitly Out-of-Scope / Deferred to Phase 2 or Later

None of the items below are implemented. They must not be treated as in-scope for internal MVP. Formal deferral rationale is documented in `docs/mvp-roadmap-checklist.md` and `docs/module-map.md`.

### Architecture / Platform
- SaaS tenant isolation — no `tenantId`, no Tenant model, no JWT payload changes
- AuditLog model
- EventBus / outbox / notification system
- Billing / subscriptions / entitlement
- RBAC Role model as a separate database entity
- Mobile apps
- AI agents

### Schema / Migrations
- WIP / `ROASTED_BEANS` InventoryCategory — roasted layer tracked via RoastingBatch records only
- Delivery-to-FinishedGoodsLot FK schema link — FGL reference stored in `InventoryMovement.referenceEntityId` only
- Blend transformation InventoryMovement ledger entry
- `approvalStatus` / `paymentStatus` write paths — fields exist on Order model but have no transition routes

### Operations / Workflows
- Periodic Inventory Count (File 20) — formally deferred 2026-05-28; requires new schema models and multi-step approval workflow
- QC Testing Waste Logging (File 21) — formally deferred 2026-05-28; blocked by absent `ROASTED_BEANS` ledger category
- Full `ProductionOrder` dedicated API routes — model exists in schema; no endpoints implemented
- Calibration workflow and calibration waste
- Cleaning modules
- Order `"cancelled"` production status — value defined but no backend writes it
- QC rejection quarantine / downstream enforcement policy
- Full cursor-based pagination — MVP safe limits (`take: 300–1000`) are in place

### Enterprise / Business Features
- Full accounting / invoicing / VAT / Qoyod integration
- Sales management / commissions
- Advanced pricing engine
- HR / payroll / leave / shift management
- Governance / Authority Matrix — multi-approval workflows
- Advanced reports center
- Marketing module
- Product Transformation (blend → new SKU accounting)
- Integrations / device layer (scales, label printers, etc.)

### Enforcement Gaps (formally deferred, not being fixed for MVP)
- `labels.print` sub-privilege enforcement
- `qc.edit_record` route
- `production.view_history` sub-privilege enforcement
- `guest-qc` POST rate limiting

---

## Accepted MVP Warnings

No P0 or P1 security gaps were found. The following P3/P4 items are accepted for internal MVP launch and are not being fixed before launch.

| # | Warning | Severity | Why accepted |
|---|---|---|---|
| W1 | `production.view_history` sub-privilege has no enforcing route | P3 | All standard roles unaffected; custom roles rare at launch; read-only endpoint |
| W2 | `labels.print` sub-privilege defined but unenforced | P3 | Labels module access manually controlled; only trusted employees have it |
| W3 | `qc.edit_record` sub-privilege defined; no edit route exists | P3 | No QC record editing needed at MVP |
| W4 | `POST /api/guest-qc/[batchId]/[token]` has no rate limiting | P3 | Token must be issued by a `qc.manage` user; single-batch token scope limits abuse |
| W5 | `GET /api/employees` returns permissions JSON to any authenticated user | P3 | No credential fields exposed; all users at launch are trusted roastery employees |
| W6 | `DELETE /api/employees/[id]` bypasses module permission system (uses `role === "admin"`) | P3 | Admin-only in practice; no functional difference at MVP scale |
| W7 | `GET /api/settings/logo` is unauthenticated | P4 | Returns image only; required for login page; no sensitive data |
| W8 | `GET /api/dashboard/predictions` has no pagination | P3 | Small dataset at launch; full pagination deferred to Phase 2 |
| W9 | Blend transformation creates no InventoryMovement ledger entry | P4 | Tracked via RoastingBatch records; no financial reporting at MVP |
| W10 | `approvalStatus` / `paymentStatus` not writable via dedicated routes | Info | Fields exist on Order with defaults; transition routes deferred to Phase 2 |

---

## Launch Prerequisites Checklist

Operational tasks required before soft launch. None require code or schema changes.

- [ ] **Verify or create the admin user** — Confirm admin account exists with a known PIN and the `admin` role. All sub-privileges enabled for `admin` by default.
- [ ] **Create or verify all employee accounts and PINs** — Assign appropriate roles (`roasting`, `qc`, `dispatch`, etc.) or custom permission sets. PIN must be ≥ 4 digits, unique per employee.
- [ ] **Verify essential catalog data is seeded** — Green beans, CoffeeProducts, ProductSKUs, Suppliers — minimum data set required for day-one operations.
- [ ] **Take a production database backup before launch** — Snapshot the Neon production branch or export a pg_dump. Verify the restore procedure works before proceeding.
- [ ] **Run one smoke test per critical workflow** — Auth → create order → start batch → QC → package → deliver. Confirm the full chain completes without error on the production branch.
- [ ] **Prepare a minimal SOP per user role** — One page per role covering: login, daily workflow, what to do if a step fails. Arabic preferred.
- [ ] **Define rollback procedure and contact** — Who to call if a critical issue appears post-launch; how to restore from backup; how to revert to a known-good build.
- [ ] **Decide and communicate the launch window** — Coordinate with the team. Avoid a Monday morning launch. A mid-week soft launch allows time to address issues before the weekend.
- [ ] **Verify `RATE_LIMIT_SECRET` is set in production** — Documented in `.env.example` as optional with a fallback; for production hardening a real HMAC key should be configured.
- [ ] **Document the admin reset recovery plan** — The reset is irreversible and deletes all operational data. Ensure all users understand a current backup must exist before it is ever triggered.

---

## Recommended Launch Sequence

- [ ] **Freeze scope** — This document is the scope freeze record. No new features enter MVP.
- [ ] **Commit and tag current code** — Create a git commit covering all Phase 0 and Phase 1 work. Tag as `v1.0.0-mvp` or equivalent. Establishes a clean rollback point.
- [ ] **Backup production database** — Neon branch snapshot or pg_dump. Store securely and verify restore before proceeding.
- [ ] **Run final build** — `npm run build` against the production `DATABASE_URL`. Confirm "No pending migrations to apply." Confirm TypeScript: 0 errors.
- [ ] **Run critical workflow smoke tests** — One pass per role-critical path: login, inventory, order creation, roasting batch, QC, packaging, delivery.
- [ ] **Train internal users** — Walk each role through their workflow using the SOP. Confirm each user can log in and reach their default page.
- [ ] **Soft launch with limited staff** — Bring the system live for a small group first (admin + one operator per role) before opening to all staff.
- [ ] **Monitor for 1–2 weeks** — Watch for 500 errors, slow queries, incorrect calculations, and unexpected data states. Do not deploy feature changes during this window.
- [ ] **Collect and triage issues** — Classify new issues as P0/P1 (fix immediately), P2 (next patch), or P3/P4 (Phase 2 queue).
- [ ] **Decide Phase 2 priorities** — After the monitoring window, hold a brief review. Prioritize the Phase 2 backlog based on what the team actually needs in production.

---

## Cross-References

| Document | Purpose |
|---|---|
| `docs/mvp-roadmap-checklist.md` | All 12 Go/No-Go criteria with completion status, Phase 1 remediation record, and Phase 2 backlog |
| `docs/module-map.md` | Full route map, guard functions, sub-privilege enforcement table, and known gaps per module |
| `docs/saas-readiness.md` | Formal rationale for deferring SaaS, multi-tenancy, AuditLog, billing, and RBAC Role model |
| `docs/migration-drift-and-db-constraints.md` | P0 CHECK constraints documentation and migration baseline record |
| `docs/inventory-ledger-coverage.md` | InventoryMovement ledger coverage map including Gap 3 (no ROASTED_BEANS category) and all deferred ledger entries |
