# Hiqbah Coffee ERP — Module Map

> **Note:** This document is descriptive, not prescriptive. It documents the current system
> boundaries and known gaps. It must not be used as approval to rename modules, move files,
> or refactor code.

## Last Validated

Generated from code audit on 2026-05-20. Last updated 2026-05-28 to reflect R01 purchase receive guard alignment, R02 QC view_records enforcement, R04/R05 translate and public cupping rate limiting, R09 dashboard/analytics API route documentation correction, delivery FGL enforcement, admin reset full operational reset, R07 MVP safe limits, and cupping Known gaps correction. Updated 2026-05-29 (Final Verification Closure Pass): corrected stale route names in modules 4 (production-orders removed), 5 (guest-qc added), 6 (packaging routes corrected), 10 (labels routes corrected), 11 (employees guard accuracy); production.view_history sub-privilege corrected to No in permission table; employees guard notes clarified. Updated 2026-05-29 (Training Reset): added `POST /api/admin/training-reset` and `settings.training_reset` sub-privilege; module 13 settings updated to document both reset routes.
Must be revalidated after any major route, permission, schema, or workflow change.

---

## Overview

The ERP is a Next.js App Router monolith. All API routes live under `src/app/api/`. All pages live under `src/app/dashboard/`. Auth is JWT-in-cookie, enforced per-route via helpers in `src/lib/auth-server.ts`.

---

## Module Reference

### 1. `dashboard`

| | |
|---|---|
| **Page** | `src/app/dashboard/page.tsx` |
| **API routes** | `GET /api/analytics` (KPI overview: production, QC, inventory alerts, order pipeline, weekly chart — serves the dashboard landing page only); `GET /api/dashboard/stats` (summary stats with timeframe filter) |
| **Guard** | Page: `requireAuth` (any authenticated user). API routes: `requireModule("dashboard")` for both. |
| **Sub-privileges** | None |
| **Description** | Landing page. Shows summary KPI tiles, weekly production chart, inventory alerts, QC alerts, and order pipeline. `GET /api/analytics` and `GET /api/dashboard/stats` are dashboard endpoints — they do not serve `src/app/dashboard/analytics/page.tsx`. |
| **Known gaps** | `GET /api/analytics`: most queries are aggregate/count/time-bounded and are safe at any scale. `openQcBatches` query has MVP safe limit: `take: 50`. Full pagination not applicable for this aggregate endpoint. |

---

### 2. `inventory`

| | |
|---|---|
| **Page** | `src/app/dashboard/inventory/page.tsx` |
| **API routes** | `GET/POST /api/green-beans`, `GET/PATCH/DELETE /api/green-beans/[id]`, `GET/POST /api/coffee-products`, `GET/PATCH/DELETE /api/coffee-products/[id]`, `GET/POST /api/purchases`, `GET/POST /api/inventory-movements`, `GET /api/finished-goods-lots` |
| **Guard** | `requireModule("inventory")` |
| **Sub-privileges** | `receive` (purchases), `adjust` (manual adjustments), `override` (price override) |
| **Known gaps** | None for write paths. `GET /api/inventory-movements` has MVP safe limit: `take: 300` (pre-existing; not changed in R07 pass). |
| **Shelf allocation (2026-08-26)** | `GET /api/finished-goods-lots` now also returns `reservedQty`. The Finished Goods tab shows Available / Reserved / Free per lot, and free-to-promise (`availableQty - reservedQty`) in the header. Still read-only — there is no manual finished-goods adjustment route. |

---

### 3. `orders`

| | |
|---|---|
| **Page** | `src/app/dashboard/orders/page.tsx` |
| **API routes** | `GET/POST /api/orders`, `GET/PATCH/DELETE /api/orders/[id]` |
| **Guard** | `requireModule("orders")` |
| **Sub-privileges** | `create`, `edit`, `delete` |
| **Known gaps** | `approvalStatus` and `paymentStatus` exist on the Order model and are shown in the UI edit form but are never written by any API route. All live orders have default values (`"Pending"` / `"Not Paid"`). Dedicated transition routes do not exist. The UI `updateOrder()` function is dead code. `GET /api/orders` has MVP safe limit: `take: 500`. Full cursor pagination deferred to Phase 2. |
| **Shelf allocation (2026-08-26)** | `POST /api/orders` and `PUT /api/orders/[id]` no longer check green-bean stock alone. `checkOrderAvailability()` lets free shelf stock absorb each line first and charges only the remainder against green beans, so an order is no longer refused for want of raw coffee that is already roasted and packaged. `POST /api/orders/[id]/status` with `action: "cancel"` releases every shelf reservation the order held. |

---

### 4. `production`

| | |
|---|---|
| **Page** | `src/app/dashboard/production/page.tsx` |
| **API routes** | `GET/POST /api/roasting-batches`, `GET/DELETE /api/roasting-batches/[id]`, `POST /api/roasting-batches/blend`, `PATCH /api/roasting-batches/[id]/date`, `GET/POST /api/roasting-batches/[id]/package` |
| **Guard** | `requireModule("production")` |
| **Sub-privileges** | `start_batch`, `roast_to_stock`, `blend`, `view_history`, `cancel_batch`, `edit_date` |
| **Known gaps** | Most batches have no `productionOrderId` — the production page UI sends none. `ProductionOrder` exists in the Prisma schema but has no dedicated API routes in MVP; batches are created through `/api/roasting-batches`. No approval/payment gate before production start. `GET /api/roasting-batches` has MVP safe limit: `take: 500`. Full cursor pagination deferred to Phase 2. |
| **Roast to stock (2026-08-27)** | `RoastingBatch.orderItemId` is nullable. `POST /api/roasting-batches` with no `orderItemId` creates a **stock batch**: it requires `productId`, skips the per-order surplus gate (there is no order to exceed) and skips `recalcOrderItemStatus`. Packaging finds no owner, so the whole lot lands free-to-promise on the shelf. Gated on the sub-privilege `production.roast_to_stock`, separate from `start_batch`. Blending stock inputs produces a stock blend. |

---

### 5. `qc`

| | |
|---|---|
| **Page** | `src/app/dashboard/qc/page.tsx` |
| **API routes** | `GET /api/qc-records`, `POST /api/qc-records`, `POST /api/qc/[batchId]/records`, `POST /api/qc/[batchId]/finalize`, `POST /api/qc-records/bulk-finalize`, `POST /api/qc/[batchId]/invite` |
| **External QC route** | `GET/POST /api/guest-qc/[batchId]/[token]` — token-based external QC submission for off-site testers. No auth cookie required; validated by matching `batchId` + `qcToken` stored on the batch record (token generated by `POST /api/qc/[batchId]/invite`, which requires `qc.manage`). POST creates a `QcRecord` with `isExternal: true`. Only accepts submissions when batch status is `"Pending QC"`. |
| **Guard** | `requireSub("qc", "view_records")` for `GET /api/qc-records`; `requireSub("qc", "create_record")` for QC record creation; `requireSub("qc", "manage")` for finalize/invite routes; `GET/POST /api/guest-qc/[batchId]/[token]` is token-authenticated (no auth cookie) |
| **Sub-privileges** | `create_record`, `view_records`, `manage`, `edit_record` (defined; no edit route exists yet) |
| **Known gaps** | `edit_record` sub-privilege is defined in `auth-shared.ts` but no QC route calls `requireSub("qc", "edit_record")` because no QC record edit route exists yet. `GET /api/qc-records` has MVP safe limit: `take: 500`. Full cursor pagination deferred to Phase 2. `POST /api/guest-qc/[batchId]/[token]` has no rate limiting — P3/deferred to Phase 2; practical exposure is limited because the token is issued only by an authenticated `qc.manage` user. |

---

### 6. `packaging`

| | |
|---|---|
| **Page** | `src/app/dashboard/packaging/page.tsx` |
| **API routes** | `GET /api/roasting-batches/[id]/package`, `POST /api/roasting-batches/[id]/package` |
| **Guard** | `requireModule("packaging")` |
| **Sub-privileges** | None defined |
| **Known gaps** | InventoryMovement ledger entry for packaging is created. Blend transformation (`isBlend: true` batches) has no InventoryMovement entry. `GET /api/finished-goods-lots` is inventory-guarded (`requireModule("inventory")`) and GET-only in MVP; it is not a packaging write endpoint. `/api/packaging` as a standalone route does not exist. |

---

### 7. `dispatch`

| | |
|---|---|
| **Page** | `src/app/dashboard/dispatch/page.tsx` |
| **API routes** | `GET/POST /api/deliveries`, `GET /api/deliveries/[id]` |
| **Guard** | `requireModule("dispatch")` (GET), `requireSub("dispatch", "mark_delivered")` (POST) |
| **Sub-privileges** | `mark_delivered` |
| **Known gaps** | None for write paths. `finishedGoodsLotId` is required for all new deliveries as of 2026-05-28; `POST /api/deliveries` rejects missing FGL with 400. `GET /api/deliveries` has MVP safe limit: `take: 500`. Full cursor pagination deferred to Phase 2. |
| **Shelf allocation (2026-08-26)** | The eligibility rule changed. It previously measured packaged bags of roasting batches belonging to *this order item* and then deducted from whichever lot the operator picked — two guards about different kilograms, so a new order could never draw on a full shelf. It now caps the shipment at the item's undelivered quantity and consumes the lot through `consumeShelfStock()`, which draws down this item's own reservation first and only touches free stock for the remainder. A lot reserved for another order is refused with 409. The dispatch screen lists lots by free quantity, not gross available. |

---

### 8. `history`

| | |
|---|---|
| **Page** | `src/app/dashboard/history/page.tsx` |
| **API routes** | Reads from production, delivery, and QC APIs; exports via `GET /api/export?type=<type>` |
| **Guard** | `requireModule("history")` |
| **Sub-privileges** | None |
| **Known gaps** | `GET /api/export` (orders, production, qc, deliveries variants) has MVP safe limit: `take: 1000` per export type — returns the most recent 1,000 records. Date-range filtering and full export pagination deferred to Phase 2. |

---

### 9. `analytics`

| | |
|---|---|
| **Page** | `src/app/dashboard/analytics/page.tsx` |
| **API routes** | `GET /api/dashboard/predictions` |
| **Guard** | `requireModule("analytics")` |
| **Sub-privileges** | None |
| **Known gaps** | `GET /api/dashboard/predictions`: no pagination; large datasets will slow down or fail. This route was not included in the R07 MVP safe limits pass. Full pagination deferred to Phase 2. |

---

### 10. `labels`

| | |
|---|---|
| **Page** | `src/app/dashboard/labels/page.tsx` |
| **API routes** | `GET /api/coffee-products`, `POST /api/coffee-products`, `GET /api/coffee-products/summary`, `GET /api/product-skus`, `POST /api/product-skus` |
| **Guard** | `GET /api/coffee-products`: `requireModule("labels")`. `POST /api/coffee-products`, `GET/POST /api/product-skus`: `requireEdit("labels")`. `GET /api/coffee-products/summary`: `requireModule("orders")` (serves the order-creation UI). Note: `/api/labels` and `/api/labels/[id]` as standalone routes do not exist. |
| **Sub-privileges** | `print` (defined; no route enforces it) |
| **Known gaps** | `print` sub-privilege is defined in `auth-shared.ts` but no route calls `requireSub("labels", "print")`; module-level access is the only enforcement. P3/accepted for MVP. `GET /api/product-skus` uses `requireEdit("labels")` even for reads — users with `labels.view` access cannot list SKUs. |

---

### 11. `employees`

| | |
|---|---|
| **Page** | `src/app/dashboard/employees/page.tsx` |
| **API routes** | `GET/POST /api/employees`, `PUT/DELETE /api/employees/[id]` |
| **Guard** | `GET /api/employees`: `requireAuth()` (any authenticated user — intentional; employee names and roles are needed cross-module for workflow UI). `POST /api/employees`: `requireSub("employees", "create")`. `PUT /api/employees/[id]`: `requireSub("employees", "edit")`. `DELETE /api/employees/[id]`: `requireAuth()` + inline `user.role === "admin"` check (bypasses module permission system — P3/accepted for MVP). Note: `GET/PATCH /api/employees/[id]` are not implemented; `PUT` is the update method. |
| **Sub-privileges** | `create`, `edit` |
| **Notes** | All 3 write paths (`POST /api/employees`, `PUT /api/employees/[id]`, `PUT /api/profile`) correctly write `pinHash` alongside `pin`. 7 legacy employees (seeded before pinHash was introduced) have `pinHash = null` and will self-heal on next login. `GET /api/employees` response includes `permissions` JSON but excludes `pin`, `pinHash`, and `password`. |

---

### 12. `customers`

| | |
|---|---|
| **Page** | `src/app/dashboard/customers/page.tsx` (if exists) |
| **API routes** | `GET/POST /api/customers`, `GET/PATCH/DELETE /api/customers/[id]` |
| **Guard** | `requireModule("customers")` |
| **Sub-privileges** | `manage` |

---

### 13. `settings`

| | |
|---|---|
| **Page** | `src/app/dashboard/settings/page.tsx` |
| **API routes** | `POST /api/admin/reset`, `POST /api/admin/training-reset` |
| **Guard (reset)** | `requireSub("settings", "reset")` + rate limiting + confirmation phrase (`RESET HIQBAH`) + admin PIN re-verify |
| **Guard (training-reset)** | `requireSub("settings", "training_reset")` + rate limiting + confirmation phrase (`CLEAR DEMO DATA`) + admin PIN re-verify |
| **Sub-privileges** | `reset`, `training_reset` |
| **Known gaps** | None. **Admin Reset** (`POST /api/admin/reset`): full operational data reset. Deletes (in FK-safe order): CuppingScore, CuppingSessionBatch, CuppingSession, InventoryMovement, FinishedGoodsLot, ProductionOrder, PurchaseRecord, QcRecord, Delivery, BlendIngredient, RoastingBatch, OrderItem, Order, Customer, GreenBean. Preserves: Employee, Supplier, CoffeeProduct, ProductSKU, SystemConfig, LoginAttempt, RateLimit. **Training Reset** (`POST /api/admin/training-reset`): extends Admin Reset scope by also deleting ProductSKU, CoffeeProduct, and Supplier (FK-safe order: ProductSKU before CoffeeProduct; PurchaseRecord already deleted in step 7 so Supplier is safe). For demo/training phase cleanup only — must not be used after real production data is entered. Preserves: Employee, SystemConfig, LoginAttempt, RateLimit. |

---

### 14. `cupping`

| | |
|---|---|
| **Page** | `src/app/dashboard/cupping/page.tsx` (if exists) |
| **Internal API routes** | `GET/POST /api/cupping/sessions`, `GET/DELETE /api/cupping/sessions/[id]`, `PUT /api/cupping/sessions/[id]/close`, `GET/POST /api/cupping/sessions/[id]/scores` |
| **Public API routes** | `GET/POST /api/public/cupping/session/[token]`, `GET/POST /api/public/cupping/[id]/score` |
| **Guard (internal reads)** | `requireModule("cupping")` |
| **Guard (internal writes)** | `requireEdit("cupping")` |
| **Guard (public routes)** | Session token in URL path — no auth cookie required (intentional, for external QC panelists) |
| **Sub-privileges** | None defined in `auth-shared.ts` |
| **Known gaps** | None. Admin reset now deletes `CuppingScore`, `CuppingSessionBatch`, and `CuppingSession` as part of the full operational reset (enforced 2026-05-28). |

---

### 15. `translate` (internal utility)

| | |
|---|---|
| **API route** | `POST /api/translate` |
| **Guard** | `requireAuth` (any authenticated user) |
| **Sub-privileges** | N/A |
| **Input validation** | Rejects empty text (400). Rejects text longer than 2000 characters (400). |
| **Known gaps** | None. |

---

### 16. `profile` (user self-service)

| | |
|---|---|
| **API routes** | `GET/PATCH/PUT /api/profile` |
| **Guard** | `requireAuth` (any authenticated user) |
| **Sub-privileges** | N/A |
| **Description** | GET/PATCH: phone number and language preference. PUT: change own PIN (requires current PIN verification + rate limiting). |

---

### 17. `auth`

| | |
|---|---|
| **API routes** | `POST /api/auth/login`, `POST /api/auth/logout` |
| **Guard** | Public (pre-auth) |
| **Sub-privileges** | N/A |
| **Description** | Supports PIN login and username/password login. DB-backed rate limiting on both methods. JWT issued as httpOnly cookie (8h). |

---

## Permission Sub-Privilege Reference

| Module | Sub-privilege | Enforced by route? |
|---|---|---|
| inventory | receive | Yes |
| inventory | adjust | Yes |
| inventory | override | Yes |
| orders | create | Yes |
| orders | edit | Yes |
| orders | delete | Yes |
| production | start_batch | Yes |
| production | blend | Yes |
| production | view_history | No — no route enforces this sub-privilege; `GET /api/roasting-batches` uses `requireAnyModule("production","qc","packaging")`; P3/accepted gap for MVP |
| production | cancel_batch | Yes |
| production | edit_date | Yes |
| qc | create_record | Yes |
| qc | edit_record | No |
| qc | view_records | Yes |
| qc | manage | Yes |
| dispatch | mark_delivered | Yes |
| labels | print | No |
| employees | create | Yes |
| employees | edit | Yes |
| settings | reset | Yes |
| settings | training_reset | Yes |
| customers | manage | Yes |

---

## InventoryMovement Ledger Coverage

| Event | Category | Covered? | Source route |
|---|---|---|---|
| Green bean purchase | RAW_MATERIAL | Yes | `POST /api/purchases` |
| Manual adjustment | RAW_MATERIAL | Yes | `POST /api/inventory-movements` |
| Opening balance | RAW_MATERIAL | Yes | `POST /api/inventory-movements` |
| Roasting batch start | RAW_MATERIAL | Yes | `POST /api/roasting-batches` |
| Batch cancellation restock | RAW_MATERIAL | Yes | `DELETE /api/roasting-batches/[id]` |
| Packaging (FGL created) | FINISHED_GOODS | Yes | `POST /api/packaging` |
| Delivery with FGL | FINISHED_GOODS | Yes | `POST /api/deliveries` |
| Delivery without FGL | FINISHED_GOODS | **No** | `POST /api/deliveries` (no ledger entry) |
| Blend transformation | RAW_MATERIAL / FINISHED_GOODS | **No** | `POST /api/roasting-batches` (`isBlend: true`) |

---

## Known Security Gaps (Summary)

| Severity | Gap | Location |
|---|---|---|
| P3 | `qc` sub-privilege `edit_record` defined but not enforced — no edit route exists yet | QC API routes |
| P3 | `labels` sub-privilege `print` defined but not enforced | Labels API routes |
| P4 | Deliveries without FGL link create no InventoryMovement entry | `src/app/api/deliveries/route.ts` |
| P4 | Blend transformation creates no InventoryMovement entry | `src/app/api/roasting-batches/route.ts` |
| Info | `approvalStatus` / `paymentStatus` have no write path; all orders have defaults | `src/app/api/orders/[id]/route.ts` |
| Info | `"Order cancelled"` productionStatus is never written by any backend code | No route |
| Info | ~~Admin reset does not delete InventoryMovement / PurchaseRecord / ProductionOrder / CuppingSession~~ — **Resolved 2026-05-28.** Reset is now a full operational data reset. |  `src/app/api/admin/reset/route.ts` |

---

## Module Dependency Graph

```
auth
  └─→ all modules (JWT cookie required)

orders
  └─→ production (OrderItem drives batch creation)
  └─→ dispatch (OrderItem drives delivery)
  └─→ customers (Order references Customer)

inventory
  └─→ production (GreenBean stock consumed by RoastingBatch)
  └─→ purchases (PurchaseRecord adds to GreenBean stock)

production
  └─→ qc (RoastingBatch referenced by QcRecord)
  └─→ packaging (RoastingBatch referenced by packaging / FinishedGoodsLot)

packaging
  └─→ dispatch (FinishedGoodsLot referenced by Delivery)

analytics
  └─→ orders, production, inventory, dispatch (read-only aggregation)

history
  └─→ production, dispatch, qc (read-only)

labels
  └─→ production, packaging (label templates reference batch / lot data)

settings (reset / training-reset)
  └─→ all data models (destructive — Admin Reset deletes operational data; Training Reset also deletes catalog)
```
