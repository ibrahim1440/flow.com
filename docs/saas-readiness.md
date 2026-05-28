# Hiqbah Coffee ERP — SaaS Readiness Assessment

> **Note:** This document is descriptive and directional, not approval to implement SaaS.
> It documents the current architecture's readiness for multi-tenancy, identifies assumptions
> that must not be deepened, and defines the design constraint that governs all future work.
> It must not be used as approval to add tenantId columns, create a Tenant model, change
> auth flows, or begin any SaaS implementation.

## Last Validated

Generated from code audit on 2026-05-22.
Must be revalidated after any Prisma schema change, auth change, or new module addition.

---

## Related Documents

- [docs/module-map.md](module-map.md) — Module boundaries, guards, sub-privileges, known gaps
- [docs/inventory-ledger-coverage.md](inventory-ledger-coverage.md) — InventoryMovement ledger events and gaps
- [docs/migration-drift-and-db-constraints.md](migration-drift-and-db-constraints.md) — Migration history drift and DB-level constraints

---

## 1. Purpose

This document assesses the current ERP architecture for multi-tenant SaaS readiness.
It answers two questions:

1. How ready is the current codebase to be extended into a multi-tenant SaaS product?
2. What must every future design and implementation decision keep in mind?

It does not prescribe an implementation timeline. The decision documented in Section 2
governs how this assessment is to be used.

---

## 2. Current Decision: SaaS Constraint Now, Implementation Later

**The decision is:**

> Add SaaS as an architecture constraint now. Do not implement SaaS now.

This means:

- Every future design decision must be evaluated against multi-tenant readiness.
- No SaaS implementation work is approved or scheduled.
- The architecture must not become harder to multi-tenant over time.
- Existing single-tenant code must not be extended in ways that deepen single-tenant assumptions.

When any proposal — new model, new route, new feature, new workflow — is reviewed, it must
answer the three questions in Section 19 before being approved.

---

## 3. Current Architecture Assessment

The ERP is a Next.js App Router monolith backed by Neon PostgreSQL via Prisma 7.8.

**Auth:** JWT-in-cookie (8h). Token payload: `{ id, name, role, permissions, preferredLanguage }`.
No tenantId in the token. No tenant concept in the codebase.

**Permission model:** JSON blob in `Employee.permissions`. Module access (`none`/`view`/`edit`)
plus sub-privileges per module. All permissions are user-scoped, not tenant-scoped.
`ALL_MODULES` is a compile-time constant in `src/lib/auth-shared.ts`.

**Database:** All operational tables are unscoped. No `tenantId` column exists anywhere.
All queries return data from all rows with no tenant filter.

**Config:** `SystemConfig` uses `@id @default("singleton")` — a hardcoded single row.
This is the most visible structural SaaS blocker. It cannot support per-tenant settings
without a schema change.

**Rate limiting:** `LoginAttempt` table (login/PIN/reset throttling) and `RateLimit` table (API usage throttling for translate and public cupping routes), both using HMAC-SHA256 hashed keys. Both are global (not tenant-scoped). A high-volume tenant could exhaust rate limit budget for all others.

**Module routing:** `ALL_MODULES` is hardcoded. Per-tenant module licensing is not possible
without a tenant model and a subscription/entitlement layer.

---

## 4. SaaS Readiness Score

| Dimension | Score | Notes |
|---|---|---|
| Data isolation | 0 / 10 | No tenantId anywhere |
| Auth/identity | 1 / 10 | JWT exists; no tenant claim |
| Config isolation | 0 / 10 | SystemConfig is a hard singleton |
| Module/feature gating | 2 / 10 | Permission model exists; not tenant-scoped |
| Rate limiting | 1 / 10 | Global, not per-tenant |
| API guards | 2 / 10 | Module guards exist; no tenant enforcement |
| Migration readiness | 8 / 10 | Baseline established 2026-05-22; `migrate deploy` is production build command; schema drift resolved |
| Schema design | 3 / 10 | No tenantId; otherwise clean relational model |

**Overall readiness: 1.9 / 10 — Not multi-tenant. Not SaaS-hostile either. Migration baseline resolved; all other dimensions unchanged.**

The codebase is clean enough to extend. The schema has no features that make
tenantId retrofitting technically impossible. The main risk is time: every new
model added without tenantId is one more table to migrate later.

---

## 5. Current Single-Tenant Assumptions

The following assumptions are currently baked into the system. Each must be resolved
before any tenant can be onboarded:

1. **No Tenant model.** There is no `Tenant` table, no tenant identifier, and no concept
   of tenant context anywhere in the codebase.

2. **No tenantId on any operational table.** `Employee`, `Order`, `RoastingBatch`,
   `GreenBean`, `CoffeeProduct`, `Customer`, `InventoryMovement`, `FinishedGoodsLot`,
   `PurchaseRecord`, `QcRecord`, `Delivery`, `Label`, `CuppingSession`,
   `ProductionOrder` — none have a `tenantId` column.

3. **SystemConfig is a singleton.** `@id @default("singleton")` means only one row
   can ever exist. Logo, settings, and any future config are global.

4. **JWT has no tenant claim.** `UserPayload` has no `tenantId`. Every auth guard
   in `src/lib/auth-server.ts` enforces user identity and module access, not
   tenant membership.

5. **ALL_MODULES is a constant.** Module availability is compile-time, not per-tenant
   runtime configuration.

6. **Rate limiting is global.** `LoginAttempt` rows are not scoped to a tenant.

7. **Analytics aggregates all data.** `GET /api/analytics` returns totals across
   all rows with no filter. In a multi-tenant system, this would leak cross-tenant
   data.

8. **Admin reset deletes globally.** `POST /api/admin/reset` would wipe all tenants'
   data, not just the calling tenant's data.

9. **Employee usernames are globally unique.** The unique constraint on `username`
   is not tenant-scoped. Two tenants could not have an employee named "admin".

---

## 6. Future Tenancy Model Recommendation

When SaaS implementation begins (not now), the recommended approach is:

**Shared database with tenantId — not database-per-tenant.**

Rationale:
- The schema is clean enough for shared-DB; no BLOB-heavy or RLS-hostile patterns.
- Database-per-tenant on Neon adds provisioning complexity and cost at low tenant counts.
- Row-level tenantId is the lowest-risk migration path from the current schema.
- Prisma's query layer makes consistent `where: { tenantId }` enforcement straightforward.

The alternative (separate schema or separate DB per tenant) is not ruled out permanently,
but requires a much larger operational investment and should not be the default choice
until tenant count and isolation requirements justify it.

---

## 7. Tenant Naming Convention

When the Tenant model is created (not now), use these conventions:

- Table: `Tenant`
- Primary key: `id String @id @default(cuid())`
- Foreign key on all tenant-owned tables: `tenantId String` (non-nullable for new tables)
- Index: `@@index([tenantId])` on every tenant-owned table
- Do not use `organizationId`, `companyId`, `workspaceId`, or `accountId`. Use `tenantId`.

---

## 8. Future Tenant-Scoped Model Classification

The following models are tenant-owned. When tenantId is eventually added, every one
of these tables must receive a `tenantId` column with a non-nullable foreign key:

| Model | Notes |
|---|---|
| `Employee` | Users belong to one tenant |
| `Order` | All sales data is tenant-owned |
| `OrderItem` | Owned via Order |
| `Customer` | Customer list is tenant-specific |
| `GreenBean` | Inventory is tenant-specific |
| `CoffeeProduct` | Product catalog is tenant-specific |
| `ProductSKU` | Owned via CoffeeProduct |
| `PurchaseRecord` | Purchasing is tenant-specific |
| `RoastingBatch` | Production is tenant-specific |
| `BlendIngredient` | Owned via RoastingBatch |
| `FinishedGoodsLot` | Packaged inventory is tenant-specific |
| `QcRecord` | QC records are tenant-specific |
| `Delivery` | Deliveries are tenant-specific |
| `InventoryMovement` | Ledger is tenant-specific |
| `ProductionOrder` | Owned by tenant |
| `Label` | Labels are tenant-specific |
| `CuppingSession` | Cupping sessions are tenant-specific |
| `SystemConfig` | Must become per-tenant (currently singleton) |

---

## 9. Future Platform/Global Model Classification

The following models are platform-owned (not tenant-scoped). They do not need tenantId:

| Model | Notes |
|---|---|
| `Tenant` | (to be created) Platform-level entity |
| `LoginAttempt` | Rate limiting table; per-IP, not per-tenant |
| `RateLimit` | API usage throttling table; per-user or per-IP, not per-tenant |

---

## 10. RBAC Implications

The current permission model is a JSON blob on `Employee.permissions`. It works for a
single tenant but has structural weaknesses at SaaS scale:

**Current model strengths:**
- Deny-by-default sub-privileges
- `getUserWithPermissions()` re-reads from DB on every request — no stale cache risk
- Module-level + sub-privilege separation is a sound pattern

**Current model weaknesses:**
- No role table — roles are free-form strings (`"admin"`, `"employee"`, etc.)
- `buildDefaultPermissions(role)` is a hardcoded mapping — not per-tenant customizable
- `ALL_MODULES` is compile-time — tenant-specific module licensing is impossible
- No audit log for permission changes

**Future RBAC design constraints (design-first, not implementation now):**
- Any new Role model must be tenant-scoped from day one (`tenantId` required)
- Per-tenant module entitlements require a subscription/feature-flag layer (not in scope now)
- Audit log for permission changes must be tenant-scoped from day one

Do not add a Role model, audit log, or subscription model until the Tenant model exists
and the migration strategy is approved.

---

## 11. Backend/API Tenant Enforcement Implications

When tenant enforcement is eventually added to `src/lib/auth-server.ts`:

1. `requireAuth()` must validate `user.tenantId` against the request context.
2. `requireModule()` and `requireSub()` must pass tenant context to the DB read.
3. Every Prisma query must include `where: { tenantId: user.tenantId }`.
4. The `getUserWithPermissions()` function must scope its Employee lookup to `tenantId`.

Until the Tenant model exists and `Employee.tenantId` is populated, none of these
changes can be made safely. Do not add partial tenant enforcement.

---

## 12. Security Risks If SaaS Is Ignored

If multi-tenancy is added without addressing current assumptions:

| Risk | Severity | Description |
|---|---|---|
| Cross-tenant data read | Critical | All queries return all-tenant data with no filter |
| Cross-tenant data write | Critical | No tenant check on writes; any authenticated user modifies any row |
| Cross-tenant reset | Critical | Admin reset deletes all data across all tenants |
| Analytics data leak | High | Analytics endpoint aggregates all tenants' operational data |
| Rate limit exhaustion | Medium | One high-volume tenant can rate-limit all users globally |
| Username collision | Medium | Global unique constraint on username blocks same username across tenants |
| Config overwrite | Medium | SystemConfig singleton means one tenant's logo/settings affect all |

---

## 13. Risks If SaaS Is Implemented Too Early

Implementing SaaS before the remaining gates are cleared introduces its own risks. The migration baseline gate is now met (2026-05-22). The risks below remain relevant for the Tenant model design, Employee.tenantId migration, and backfill gates:

| Risk | Description |
|---|---|
| Schema drift deepens | ~~Adding tenantId before baseline makes it impossible to safely run migrate deploy~~ — Baseline complete. Still applies if tenantId is added before the migration strategy is approved. |
| Incomplete backfill | Backfilling tenantId on 18+ tables without a migration plan creates partial state |
| Auth regression | Adding tenantId to JWT before Employee.tenantId exists breaks login |
| Performance regression | Adding tenantId indexes on tables with large datasets requires careful migration timing |
| Scope creep | Tenant isolation pulls in billing, subscription, platform admin, and onboarding — none of which are designed |

The minimum gate for beginning SaaS implementation:
1. ~~Migration baseline established~~ — **Complete (2026-05-22)**
2. Tenant model designed and approved
3. Employee.tenantId migration strategy approved
4. Backfill plan for existing data (single "Hiqbah Coffee Roasters" tenant) written

---

## 14. Migration Strategy — Future Only

This section is directional. No migration work is approved now.

**Phase 0 (prerequisite):** ~~Establish migration baseline~~ — **Complete (2026-05-22).** All future schema changes flow through `migrate dev` → `migrate deploy`.

**Phase 1:** Create Tenant model. No data changes yet.

**Phase 2:** Add `tenantId` to `Employee`. Add login resolution: `employee.tenantId → JWT`.
Backfill all existing employees to "Hiqbah Coffee Roasters" tenant.

**Phase 3:** Add `tenantId` to remaining tenant-owned models (Section 8), one migration per
logical group. Backfill all existing rows.

**Phase 4:** Add tenant enforcement to `src/lib/auth-server.ts`. Add `where: { tenantId }`
to all Prisma queries.

**Phase 5:** Replace `SystemConfig` singleton with per-tenant config.

**Phase 6:** Scope rate limiting per tenant.

Each phase is a separate approved task. Phases must be sequential. No phase may begin
until the previous phase is fully deployed and verified.

---

## 15. Interaction With Current Architecture Work

The following active remediation tracks intersect with future SaaS work:

| Current track | SaaS interaction |
|---|---|
| Migration baseline (migration-drift doc) | **Complete (2026-05-22).** Baseline established; `migrate deploy` is the production command. All future schema changes flow through `migrate dev` → `migrate deploy`. |
| InventoryMovement ledger gaps (inventory-ledger-coverage doc) | All new IM events will eventually need tenantId. Design new events with this in mind. |
| Blend InventoryMovement (deferred) | When designed, include tenantId in the schema design — even if not implemented yet. |
| QC sub-privilege enforcement | No SaaS interaction. Safe to proceed independently. |
| Translate endpoint auth (P1 security gap) | **Fixed 2026-05-22.** `requireAuth` added. No SaaS interaction. |
| Delivery concurrency bug | **Fixed 2026-05-22.** Atomic `updateMany WHERE` and `{ increment }` operator applied. No SaaS interaction. |
| RBAC Role model (design-first) | Must be tenant-scoped from day one. Do not design without tenantId. |
| Audit log (design-first) | Must be tenant-scoped from day one. Do not design without tenantId. |

---

## 16. What Current Remediation Should Consider

When working on any current remediation task, apply the following check before proposing
a schema change, new model, new column, or new route:

1. **Is this data tenant-owned?** (See Section 8.)
2. **If yes, does the proposed schema include tenantId?** (Not to implement now — to note
   the eventual requirement.)
3. **Does this change make future tenant isolation easier or harder?**

If a proposed change makes future tenant isolation harder (e.g., deepening a singleton
assumption, adding a global unique constraint without tenant scope, adding cross-table
joins that would be broken by tenantId filters), flag it explicitly before proceeding.

---

## 17. What Current Remediation Must Not Change

The following must not be changed as part of current remediation work, because they
intersect directly with future SaaS implementation and must be changed as part of a
coordinated tenant migration:

- Do not add tenantId columns.
- Do not add a Tenant model.
- Do not change JWT payload structure.
- Do not change login flow.
- Do not change `requireAuth`, `requireModule`, `requireSub` guard signatures.
- Do not change `UserPayload` type.
- Do not change `buildDefaultPermissions`.
- Do not change `ALL_MODULES`.
- Do not add subscriptions, billing, or entitlement logic.
- Do not add a platform admin UI or platform admin role.
- Do not refactor routes to accommodate tenant context prematurely.

---

## 18. Explicit "Do Not Implement Now" List

The following items are explicitly **not approved** and must not be implemented until
the gates in Section 13 are met:

| Item | Status |
|---|---|
| Add `tenantId` column to any table | **Do not implement now** |
| Create `Tenant` model in Prisma schema | **Do not implement now** |
| Add `tenantId` to JWT / `UserPayload` | **Do not implement now** |
| Change login flow to resolve tenant context | **Do not implement now** |
| Add tenant enforcement to auth guards | **Do not implement now** |
| Add subscriptions or billing model | **Do not implement now** |
| Add platform admin UI | **Do not implement now** |
| Add platform admin role to `buildDefaultPermissions` | **Do not implement now** |
| Add Row-Level Security (RLS) in PostgreSQL | **Do not implement now** |
| Rename or restructure modules for tenant routing | **Do not implement now** |
| Add tenant-scoped rate limiting | **Do not implement now** |
| Run any migration introducing a tenantId column | **Do not implement now** |
| Run `migrate dev` or `db push` for SaaS-related changes | **Do not implement now** |

**UserPayload note:** Future `UserPayload` should include `tenantId` only after `Tenant`
and `Employee.tenantId` exist and the login route can resolve tenant context from the
database. Do not add an unused optional `tenantId?: string` field to `UserPayload` now.

**New model note:** Every future tenant-owned operational model should be designed with
`tenantId` from day one, but no `tenantId` columns should be implemented until the
migration baseline, Tenant model design, and tenant migration strategy are approved.

---

## 19. Future Review Checklist

Every proposal for a new model, new route, new workflow, or schema change must answer
the following three questions before being approved:

1. **Is this tenant-owned data?**
   - If yes: note the future tenantId requirement in the design doc, even if not
     implemented now.
   - If no: confirm it belongs in the platform/global classification (Section 9).

2. **If tenant-owned, how will it be tenant-scoped in the future?**
   - Which column carries tenantId?
   - Does it get tenantId directly, or is it owned transitively via a parent model?
   - What index is needed?
   - What backfill is required for existing rows?

3. **Does this decision make future tenant isolation easier or harder?**
   - Does it introduce a new global unique constraint that should be tenant-scoped?
   - Does it deepen a singleton pattern?
   - Does it add cross-tenant joins or aggregations?
   - Does it add a hardcoded constant that should be per-tenant runtime config?

If any answer is "harder," explicitly document why the tradeoff is acceptable and what
mitigation is planned before the change is approved.

---

## 20. Final Recommendation

**Do not implement SaaS now. Treat SaaS as a binding architecture constraint from this
point forward.**

The migration baseline is complete (see docs/migration-drift-and-db-constraints.md).
The immediate SaaS priority is now the Tenant model design gate — designing and approving
the `Tenant` model and `Employee.tenantId` migration strategy. No tenantId columns have
been implemented. All other SaaS gates (Sections 2, 17, 18) remain in effect.

While the baseline is being established, the following constraint applies to all new work:

> Any new model or schema change that is tenant-owned must note the future tenantId
> requirement in its design. No tenantId columns may be added until the migration
> baseline and Tenant model design are approved.

The current single-tenant ERP is functional and internally consistent. The architecture
is clean enough to extend. The work required to reach a safe multi-tenant state is
substantial but bounded. The risk of acting too early (deepening single-tenant assumptions,
breaking auth, creating partial tenant state) is higher than the risk of waiting.
