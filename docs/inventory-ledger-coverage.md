# Hiqbah Coffee ERP — Inventory Ledger Coverage Map

> **Note:** This document is descriptive, not prescriptive. It documents the current state
> of InventoryMovement coverage for every stock-impacting event in the ERP. It must not be
> used as approval to change routes, schema, or business workflows without separate review.

## Last Validated

Generated from code audit on 2026-05-20. Last updated 2026-05-28 to reflect Gap 2 delivery FGL enforcement and Gap 6 admin reset full operational reset.
Must be revalidated after any change to: inventory routes, roasting-batch routes,
delivery routes, packaging route, blend route, admin reset route, or Prisma schema.

---

## 1. Purpose of InventoryMovement

`InventoryMovement` is the ERP's stock movement ledger. Every time a stock quantity
changes — or should change — a record should be created capturing what happened, to what
entity, how much, and who did it.

It serves three functions:

1. **Audit trail** — who changed what, when, and why.
2. **Reconciliation** — `previousQuantity + quantityChanged = newQuantity` for every row.
3. **Reporting** — the inventory movement screen (`GET /api/inventory-movements`) reads
   this table to display enriched stock history.

---

## 2. InventoryMovement Model

```prisma
model InventoryMovement {
  id                String            @id @default(cuid())
  type              MovementType
  category          InventoryCategory
  referenceEntityId String?
  quantityChanged   Float
  previousQuantity  Float
  newQuantity       Float
  sourceDocType     SourceDocType
  sourceDocId       String?
  userId            String?
  timestamp         DateTime          @default(now())
  notes             String?
}
```

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | String (cuid) | No | Primary key |
| `type` | MovementType | No | Direction of movement |
| `category` | InventoryCategory | No | Which stock layer was affected |
| `referenceEntityId` | String | Yes | ID of the affected entity (GreenBean or FinishedGoodsLot). Plain string — no FK enforced. |
| `quantityChanged` | Float | No | Delta in kg. Negative for OUT/LOSS. |
| `previousQuantity` | Float | No | Quantity before this movement |
| `newQuantity` | Float | No | Quantity after this movement |
| `sourceDocType` | SourceDocType | No | Type of document that triggered this movement |
| `sourceDocId` | String | Yes | ID of the source document. Plain string — no FK enforced. |
| `userId` | String | Yes | Employee who triggered the movement. Plain string — no FK enforced. Nullable. |
| `timestamp` | DateTime | No | Auto-set to `now()` on create |
| `notes` | String | Yes | Free-text context |

**Important:** `referenceEntityId`, `sourceDocId`, and `userId` are all plain strings with
no foreign key constraints. If the referenced entity is deleted (e.g. admin reset), the
InventoryMovement row survives as an orphan with a dangling ID.

---

## 3. Current Enums

### MovementType

| Value | Used? | Meaning |
|---|---|---|
| `IN` | Yes | Stock received or added |
| `OUT` | Yes | Stock consumed or shipped |
| `ADJUSTMENT` | Yes | Manual stock correction (can be positive or negative) |
| `LOSS` | **No** | Defined in schema; never written by any route |

### InventoryCategory

| Value | Used? | Meaning |
|---|---|---|
| `RAW_MATERIAL` | Yes | Green bean stock |
| `FINISHED_GOODS` | Yes | Packaged lots (FinishedGoodsLot) |

**Gap:** No category for roasted/WIP beans between roasting and packaging. The intermediate
stock layer is tracked implicitly via `RoastingBatch.roastedBeanQuantity` and
`RoastingBatch.status`, not via the InventoryMovement ledger.

### SourceDocType

| Value | Used? | Route |
|---|---|---|
| `PURCHASE` | Yes | `POST /api/purchases` |
| `ROASTING_BATCH` | Yes | `POST /api/roasting-batches`, `DELETE /api/roasting-batches/[id]` |
| `DELIVERY` | Yes | `POST /api/deliveries` |
| `BLEND` | **No** | Defined in schema; never written by any route |
| `MANUAL_ADJUSTMENT` | Yes | `POST /api/inventory/adjust`, `POST /api/green-beans` (opening balance) |
| `PACKING` | Yes | `PUT /api/roasting-batches/[id]/package` |

**Gap:** `BLEND` is defined as a SourceDocType but is never used. The roasting-batch blend
route (`POST /api/roasting-batches/blend`) creates no InventoryMovement. This enum value
was likely intended for future use and is not wired up.

---

## 4. Stock-Impacting Event Coverage Table

### Legend
- ✅ Covered — InventoryMovement is created
- ❌ Gap — stock changes but no InventoryMovement is created
- ➖ Not applicable — event does not change stock quantities
- 🔮 Future — not yet implemented

| # | Event | Changes Stock? | Layer | IM Created? | sourceDocType | sourceDocId | referenceEntityId | userId | Tx-safe? | Notes / Gap |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Green bean opening balance (new bean, qty > 0) | Yes | RAW_MATERIAL | ✅ | `MANUAL_ADJUSTMENT` | `null` | `greenBean.id` | `user.id` | Yes | `sourceDocType` is `MANUAL_ADJUSTMENT` with `notes: "Opening balance"` — opening balances are indistinguishable from adjustments in the ledger unless the `notes` field is filtered; `sourceDocId` is null |
| 2 | Purchase receipt | Yes | RAW_MATERIAL | ✅ | `PURCHASE` | `purchaseRecord.id` | `greenBean.id` | `user.id` | Yes | None |
| 3 | Manual inventory adjustment | Yes | RAW_MATERIAL | ✅ | `MANUAL_ADJUSTMENT` | `null` | `greenBean.id` | `user.id` | Yes | `sourceDocId` is null — no document link for traceability |
| 4 | Roasting batch start (with greenBeanId) | Yes | RAW_MATERIAL | ✅ | `ROASTING_BATCH` | `roastingBatch.id` | `greenBean.id` | `user.id` | Yes | None |
| 5 | Roasting batch start (no greenBeanId) | Yes | RAW_MATERIAL | ❌ | — | — | — | — | — | No RAW_MATERIAL OUT movement is created. This must be treated as an explicit exception path, not a normal production path. |
| 6 | Roasting batch cancellation with restock | Yes | RAW_MATERIAL | ✅ (only when `restock=true`) | `ROASTING_BATCH` | `roastingBatch.id` | `greenBean.id` | `user.id` | Yes | If `restock=false`, no IM created — intentional; beans were physically consumed by roasting |
| 7 | QC rejection (batch status → Rejected) | Yes (implicit) | WIP | ❌ | — | — | — | — | — | Rejected roasted beans are a write-off with no ledger entry; `LOSS` MovementType exists but is never used |
| 8 | Roasting-batch-level blend | Yes | WIP | ❌ | — | — | — | — | — | Source batches marked "Blended"; new blend batch created with combined weights; no InventoryMovement written; `BLEND` SourceDocType exists but is never used |
| 9 | Packaging into FinishedGoodsLot | Yes | FINISHED_GOODS | ✅ | `PACKING` | `roastingBatch.id` | `finishedGoodsLot.id` | `user.id` | Yes | Delta-based: each partial packaging run creates one IM for that run's kg only; guard is module-level only (no sub-privilege) |
| 10 | Delivery with FinishedGoodsLot | Yes | FINISHED_GOODS | ✅ | `DELIVERY` | `delivery.id` | `finishedGoodsLot.id` | `user.id` | Yes | `userId` was `null` before 2026-05-22 fix — historical rows may have null userId |
| 11 | Delivery without FinishedGoodsLot | N/A — Blocked | FINISHED_GOODS | N/A | — | — | — | — | — | `POST /api/deliveries` rejects missing `finishedGoodsLotId` with 400 (enforced 2026-05-28). No delivery write occurs without an FGL. Historical deliveries without FGL are not backfilled. `Delivery` model has no FK to `FinishedGoodsLot` — see Gap 4. |
| 12 | FinishedGoodsLot status change (AVAILABLE → SHIPPED) | No (status only) | FINISHED_GOODS | ➖ | — | — | — | — | — | Status transitions are side effects of delivery; not independent stock events |
| 13 | Green bean metadata edit | No | — | ➖ | — | — | — | — | — | `PUT /api/green-beans/[id]` explicitly blocks `quantityKg` changes; returns 400 if attempted |
| 14 | Green bean delete (no roasting history) | Yes | RAW_MATERIAL | ❌ | — | — | — | — | — | Stock held by the bean disappears silently; no LOSS IM entry; P2003/P2014 prevents delete if roasting history exists |
| 15 | Product/SKU creation or edit | No | — | ➖ | — | — | — | — | — | Catalog management only; no quantity |
| 16 | Order creation or edit | No | — | ➖ | — | — | — | — | — | Orders record demand, not stock |
| 17 | Admin reset | Yes | ALL | ✅ | — | — | — | — | — | Full operational data reset (enforced 2026-05-28). Deletes all transactional records including InventoryMovement. Preserves Employee, Supplier, CoffeeProduct, ProductSKU, SystemConfig, LoginAttempt, RateLimit. |
| 18 | Bar calibration waste (future) | Yes | FINISHED_GOODS or WIP | ❌ | — | — | — | — | — | No route exists; stock category and workflow not designed; blocked by policy decision and Product/Inventory Transformation architecture review |
| 19 | Warehouse issue / transfer (future) | Yes | RAW_MATERIAL or FINISHED_GOODS | ❌ | — | — | — | — | — | No route exists; workflow not designed |
| 20 | Repack (e.g. 1kg bag → 4 × 250g bags) | Yes | FINISHED_GOODS | 🔮 Not implemented | — | — | — | — | — | Future: requires TransformationEvent; input lot deducted before output lot created; must calculate by grams |
| 21 | Partial withdrawal / split (open lot, withdraw partial qty) | Yes | FINISHED_GOODS | 🔮 Not implemented | — | — | — | — | — | Future: gram-level precision required; lot status must reflect partial use (e.g. OPENED, PARTIALLY_USED) |
| 22 | Finished-goods-level blend (Lot A + Lot B → new blend lot) | Yes | FINISHED_GOODS | 🔮 Not implemented | — | — | — | — | — | Future: distinct from roasting-batch-level blend; must not be treated as new production; inputs deducted before output lot created |
| 23 | Sample withdrawal (customer, QC, or testing) | Yes | FINISHED_GOODS | 🔮 Not implemented | — | — | — | — | — | Future: small quantities; gram-level; must not inflate production metrics |
| 24 | Internal use (café, bar, calibration) | Yes | FINISHED_GOODS | 🔮 Not implemented | — | — | — | — | — | Future: deducts from finished goods; must be categorized separately from customer delivery |
| 25 | Waste / loss adjustment on finished goods | Yes | FINISHED_GOODS | 🔮 Not implemented | — | — | — | — | — | Future: `LOSS` MovementType already exists in schema; workflow not designed |
| 26 | Relabel / reclassify (no weight change) | No (qty only) | FINISHED_GOODS | ➖ (future — IM for audit only) | — | — | — | — | — | Future: classification change only; may still need IM entry for audit trail even if quantity is unchanged |

---

## 5. Stock Layers

### Layer 1: Raw Material / Green Beans
- **Model:** `GreenBean.quantityKg`
- **IM category:** `RAW_MATERIAL`
- **referenceEntityId:** `GreenBean.id`
- **Tracked by:** purchase receipts, opening balances, manual adjustments, batch starts,
  batch cancellation restocks
- **Not tracked:** green bean deletions (no history = no protection against silent loss),
  batches without a bean link

### Layer 2: Roasted Beans / WIP (Semi-Finished)
- **Model:** `RoastingBatch.roastedBeanQuantity` + `RoastingBatch.status`
- **IM category:** None — this layer has no `InventoryCategory` value
- **Tracked by:** RoastingBatch records only (not by InventoryMovement)
- **Gaps:** QC rejections, roasting-batch-level blend transformations, and the quantity
  of roasted-but-not-packaged coffee are entirely invisible to the ledger
- **Design note:** The WIP layer is the largest untracked gap in the ledger. Knowing how
  much roasted coffee exists but is not yet packaged requires querying `RoastingBatch`
  directly, not `InventoryMovement`.

### Layer 3: Finished Goods Lots
- **Model:** `FinishedGoodsLot.availableQty` + `FinishedGoodsLot.status`
- **IM category:** `FINISHED_GOODS`
- **referenceEntityId:** `FinishedGoodsLot.id`
- **Tracked by:** packaging runs, deliveries with FGL link
- **Not tracked:** deliveries without FGL link; finished-goods-level transformations
  (repacks, splits, sample withdrawals, internal use, waste) — see Section 10

### Layer 4: Bar Calibration Waste (Future)
- **Model:** Not yet designed
- **IM category:** Would require either `FINISHED_GOODS` (if deducting from a lot)
  or a new category
- **Blocked by:** Policy decision on which stock layer waste deducts from (question 5)
  and Product/Inventory Transformation architecture review (question 9)

### Layer 5: Warehouse Issues / Transfers (Future)
- **Model:** Not yet designed
- **IM category:** Would depend on the stock layer being issued or transferred
- **Blocked by:** Policy decision on workflow design (question 4)

---

## 6. Ledger Gaps (Detail)

### Gap 1 — Roasting-batch-level blend has no ledger entry
- **File:** `src/app/api/roasting-batches/blend/route.ts`
- **What happens:** Source batches are marked "Blended"; a new blend batch is created
  with combined weights. No InventoryMovement is written.
- **`BLEND` SourceDocType exists** in the schema but is never used by any route.
- **Impact:** The ledger shows the raw material OUT from batch starts, but the
  transformation of multiple roasted batches into one blend batch is invisible.
- **Blocked by:** Requires a new `InventoryCategory` value for WIP/roasted beans before
  it can be modeled properly. Schema change requires a reviewed migration via `prisma migrate dev`.

### Gap 2 — Delivery without FinishedGoodsLot — Resolved 2026-05-28
- **Status: Resolved.** `POST /api/deliveries` now rejects missing `finishedGoodsLotId` with 400 before any write occurs.
- **File:** `src/app/api/deliveries/route.ts`
- **Policy decided:** All new deliveries must reference a `FinishedGoodsLot`. Submissions without `finishedGoodsLotId` are rejected at the API layer. Samples, corrections, and exceptional withdrawals require future dedicated workflows.
- **Historical records:** Delivery records created before 2026-05-28 without an FGL link are not backfilled. They remain in the database and are visible in delivery history but have no corresponding InventoryMovement.
- **Remaining gap:** The `Delivery` model has no FK to `FinishedGoodsLot` — the FGL reference is stored only in `InventoryMovement.referenceEntityId`. This is tracked separately in Gap 4 (plain-string references).

### Gap 3 — Roasted/WIP layer is not a first-class InventoryCategory
- **Impact:** QC rejections (a form of write-off), roasting-batch-level blend merges,
  and the quantity of roasted-but-not-packaged coffee are not representable in the
  InventoryMovement ledger.
- **Blocked by:** Requires adding `ROASTED_BEANS` or `SEMI_FINISHED` to the
  `InventoryCategory` enum. Requires a reviewed schema migration via `prisma migrate dev`.

### Gap 4 — InventoryMovement references are plain strings, not foreign keys
- **Fields:** `referenceEntityId`, `sourceDocId`, `userId`
- **Impact:** If a GreenBean or FinishedGoodsLot is deleted, the InventoryMovement row
  survives with a dangling ID. The inventory movement screen resolves names via
  batch-enrichment lookups (`GET /api/inventory-movements`, lines 14–46) — deleted
  entities silently show as `null` labels.
- **Blocked by:** Requires adding actual FK relations in Prisma schema. Requires
  a reviewed schema migration via `prisma migrate dev`.

### Gap 5 — Historical delivery InventoryMovements have userId = null
- **Cause:** Before 2026-05-22, `POST /api/deliveries` used `requireSub` but did not
  destructure `user`, so `userId: null` was written.
- **Fixed:** The route now writes `userId: user.id` for all new deliveries.
- **Historical rows:** All delivery InventoryMovements created before this fix have
  `userId = null`. These rows cannot be retroactively attributed without a manual
  data migration that cross-references `Delivery.createdAt` with employee login records
  (which do not exist in this system).

### Gap 6 — Admin reset orphans InventoryMovement rows — Resolved 2026-05-28
- **Status: Resolved.** Admin reset is now a full operational data reset.
- **File:** `src/app/api/admin/reset/route.ts`
- **What happens now:** Reset deletes all transactional and operational records in FK-safe
  order: CuppingScore, CuppingSessionBatch, CuppingSession, InventoryMovement,
  FinishedGoodsLot, ProductionOrder, PurchaseRecord, QcRecord, Delivery, BlendIngredient,
  RoastingBatch, OrderItem, Order, Customer, GreenBean.
- **Preserved:** Employee, Supplier, CoffeeProduct, ProductSKU, SystemConfig, LoginAttempt,
  RateLimit. LoginAttempt and RateLimit are preserved as security/rate-limit metadata —
  they are not roastery operational data.
- **Impact:** Post-reset, the system is in a clean operational state. No orphaned
  InventoryMovement rows remain. The inventory movement screen will show an empty history.
- **Historical note:** InventoryMovement rows created before a reset are not backfilled or
  recoverable without a database restore.

### Gap 7 — Green bean opening balance uses wrong SourceDocType
- **File:** `src/app/api/green-beans/route.ts`
- **What happens:** When a new GreenBean is created with `quantityKg > 0`, an
  InventoryMovement is created with `sourceDocType: "MANUAL_ADJUSTMENT"` and
  `notes: "Opening balance"`.
- **Impact:** Opening balances are indistinguishable from manual adjustments in the
  ledger unless the `notes` field is filtered. The `sourceDocId` is `null`.
- **Fix options:** Either use a new `OPENING_BALANCE` SourceDocType (requires a reviewed
  schema migration via `prisma migrate dev`) or accept the current convention and document it.

### Gap 8 — QC rejection creates no LOSS entry
- **File:** `src/app/api/qc/[batchId]/finalize/route.ts`
- **What happens:** Setting a batch to "Rejected" updates `RoastingBatch.status` only.
  No InventoryMovement LOSS entry is created.
- **Impact:** Rejected roasted coffee is invisible to the ledger. The `LOSS` MovementType
  exists in the schema but is never used by any route.
- **Policy decision required:** Should rejected batches trigger a LOSS InventoryMovement
  for the roasted quantity? Requires a WIP/roasted InventoryCategory first (Gap 3).

---

## 7. Policy Decisions Required

These questions must be answered before implementing fixes. They are business decisions,
not engineering ones.

| # | Question | Impact |
|---|---|---|
| 1 | **Decided 2026-05-28.** All new deliveries must reference a `finishedGoodsLotId`. `POST /api/deliveries` rejects missing `finishedGoodsLotId` with 400. | Resolved. No-FGL path blocked at API layer. Samples and corrections require future dedicated workflows. |
| 2 | Should roasting-batch-level blend transformation create ledger entries? | If yes: need `ROASTED_BEANS` or `SEMI_FINISHED` InventoryCategory (schema migration), then wire up `BLEND` SourceDocType. |
| 3 | Should we add a `ROASTED_BEANS` or `SEMI_FINISHED` InventoryCategory? | Prerequisite for Gaps 1, 3, and 8. Requires a reviewed schema migration via `prisma migrate dev`. |
| 4 | Should warehouse issue/transfer be a new route, a source doc type, or manual adjustment? | Determines whether a new model is needed or existing MANUAL_ADJUSTMENT suffices. |
| 5 | Should calibration waste deduct from finished goods (FinishedGoodsLot) or from WIP (roasted batch)? | Determines which InventoryCategory and referenceEntityId to use. |
| 6 | **Decided 2026-05-28.** Admin reset now deletes InventoryMovement as part of a full operational data reset. See Gap 6. | Resolved. Clean reset state enforced. |
| 7 | Should opening balances have a distinct SourceDocType (`OPENING_BALANCE`)? | Low impact; cosmetic. Improves ledger readability. Requires a reviewed schema migration via `prisma migrate dev`. |
| 8 | Should QC rejection trigger a LOSS InventoryMovement for roasted quantity? | Requires WIP InventoryCategory (question 3) first. |
| 9 | Should Product/Inventory Transformation be a first-class model (`TransformationEvent`, `TransformationInput`, `TransformationOutput`)? | Determines whether transformations are auditable, reversible, and reportable separately from production and delivery. |
| 10 | Should transformed output lots inherit genealogy from their source lots? | If yes: lot-to-lot traceability links are required in schema; if no: output lots are treated as new with no history. |
| 11 | Should lot statuses (`SEALED`, `OPENED`, `PARTIALLY_USED`, `CONSUMED`, `REPACKED`, `BLENDED`, `WASTED`) be added to the `LotStatus` enum? | Determines whether lot lifecycle is tracked beyond AVAILABLE/RESERVED/SHIPPED. |
| 12 | Should transformation metrics be excluded from roasting production dashboard totals? | Must be enforced at the reporting layer; transformation outputs must not inflate roasted-kg or batch-count metrics. |
| 13 | Should gram-level precision be enforced for transformation inputs and outputs (not only bag counts)? | Affects rounding, variance calculation, and ledger reconciliation design. |

---

## 8. Impact on Future Operational Live Screens

### Production Live Screen
- Needs: real-time batch status, roasted quantity, QC state per batch
- Ledger gap: WIP layer not in InventoryMovement — must query RoastingBatch directly
- Recommendation: source this screen from `RoastingBatch` + `QcRecord`, not from
  InventoryMovement

### Warehouse / Inventory Live Screen
- Needs: current green bean stock per bean type, current FGL quantities, lot lifecycle
  status
- Ledger gap: green bean stock is in `GreenBean.quantityKg`; FGL stock is in
  `FinishedGoodsLot.availableQty`; InventoryMovement is the history, not the live balance
- Future: must also surface OPENED, PARTIALLY_USED, and CONSUMED lot statuses once
  Product/Inventory Transformation is implemented
- Recommendation: read live balances from the source models; use InventoryMovement for
  the history/audit panel only

### Packaging Screen
- Needs: which batches are ready to package, packaging progress per batch
- Covered: packaging creates InventoryMovement (FINISHED_GOODS IN); packaging status
  tracked on `RoastingBatch.status`
- Future: repack and split operations (Layer 3 transformations) originate here; will
  require Product/Inventory Transformation architecture

### Dispatch Screen
- Needs: deliverable quantity per order item, delivery history
- Gap: deliveries without FGL link leave no ledger trace (Gap 2)
- Future: partially-used or split lots must be linkable to deliveries once
  Product/Inventory Transformation is implemented
- Recommendation: resolve Gap 2 (require FGL or accept gap) before building dispatch
  live screen

### Bar Calibration Screen
- Needs: record daily calibration waste; deduct from finished goods or WIP
- Gap: no stock category, no model, no workflow designed
- Blocked by: policy decision on which layer waste deducts from (question 5) and
  Product/Inventory Transformation architecture review (question 9)

### Transformation / Repack Station Screen (Future)
- Needs: operator selects source lot(s), enters transformation type and output
  quantities; system deducts inputs and creates outputs in one atomic transaction
- Blocked by: Product/Inventory Transformation architecture review and schema design
- Must not route through the production (roasting) workflow or affect production
  dashboard metrics
- Requires separate reporting view: transformation output quantity, repacked quantity,
  blended quantity (finished-goods level), internal use, waste/variance

---

## 9. Recommended Next Steps

### Immediate — no schema changes required

| Action | File | Blocks |
|---|---|---|
| Decide and document the FGL-required policy for deliveries (Gap 2) | Business decision | Delivery ledger completeness |
| Document the opening balance SourceDocType convention in code comment | `src/app/api/green-beans/route.ts` | Nothing blocked; cosmetic |

### Requires schema migration (migration baseline resolved 2026-05-22)

These require adding enum values or FK relations to Prisma schema via a reviewed migration
using `prisma migrate dev` → `prisma migrate deploy`. The migration baseline blocker is resolved.

| Action | Schema change | Gap resolved |
|---|---|---|
| Add `ROASTED_BEANS` to `InventoryCategory` | New enum value | Gaps 1, 3, 8 |
| Add `OPENING_BALANCE` to `SourceDocType` | New enum value | Gap 7 |
| Wire up roasting-batch blend InventoryMovement using `BLEND` SourceDocType | Route change only (enum already exists) | Gap 1 (partial — needs WIP category) |
| Add QC rejection LOSS InventoryMovement | Route change only (`LOSS` enum already exists) | Gap 8 (partial — needs WIP category) |
| Add FK relations for `referenceEntityId`, `sourceDocId`, `userId` | Schema FK additions | Gap 4 |

### Blocked by business workflow decision

| Action | Decision required |
|---|---|
| Enforce FGL requirement on deliveries | Question 1 |
| Model calibration waste | Questions 3 and 5 |
| Model warehouse issue/transfer | Question 4 |
| Admin reset + ledger policy — Decided and implemented 2026-05-28 | Question 6 — resolved. See Gap 6. |
| Design Product/Inventory Transformation architecture | Questions 9–13; requires separate architecture review before any implementation; new models require reviewed schema migrations via `prisma migrate dev`; must not be implemented as part of existing delivery, packaging, or production routes |

---

## 10. Future Concept: Product / Inventory Transformation

> **Status: Not implemented. Not approved for implementation.**
> This section documents a future business requirement for planning purposes only.
> It must be reviewed and approved separately before any implementation begins.
> No code, schema, or database changes are implied or authorized by this section.

### Purpose

Product / Inventory Transformation covers cases where existing finished goods or finished
lots are opened, split, repacked, blended at the finished-goods level, partially
withdrawn, sampled, used internally, wasted, relabeled, or reclassified.

**This is not new roasting production. This is not reproduction.**
It is a transformation of already-existing inventory.

### Core Principle

```
Inputs → Transformation Event → Outputs
```

No output lot or finished quantity may be created unless there is a matching source input
deduction. Input deductions and output creations must occur in the same database
transaction.

### Example Transformation Types

| Type | Example |
|---|---|
| `REPACK` | 1kg finished bag → 4 × 250g bags |
| `PARTIAL_WITHDRAWAL` | Open 1kg finished lot, withdraw 150g or 250g |
| `SPLIT` | Divide a lot into two smaller lots |
| `BLEND` | 600g from Finished Lot A + 400g from Finished Lot B → 1kg new blend lot |
| `SAMPLE_WITHDRAWAL` | Take 100g sample for customer, QC, or testing |
| `INTERNAL_USE` | Take coffee from finished goods for café, bar, or station calibration |
| `WASTE` | Record damaged, spilled, or variance quantity |
| `LOSS_ADJUSTMENT` | Reconcile physical count against system quantity |
| `RELABEL` | Change label or classification without weight change |
| `RECLASSIFY` | Reclassify product/SKU without weight change |

### Distinction from Roasting-Batch-Level Blend

There are two separate blend concepts in this ERP. They must not be merged or confused:

| Concept | Current status | Model | Level |
|---|---|---|---|
| Roasting-batch blend | Implemented (no IM entry — Gap 1) | `RoastingBatch` + `BlendIngredient` | Roasted/WIP beans before packaging |
| Finished-goods blend | **Not implemented** | Future: `TransformationEvent` + inputs/outputs | Packaged finished lots after packaging |

The roasting-batch blend combines pre-packaged roasted batches from the WIP layer.
The finished-goods blend combines already-packaged, already-delivered-to-FGL quantities
from the FINISHED_GOODS layer. They operate on different stock layers and must have
separate audit trails.

### Requirements (not yet approved for implementation)

**Ledger integrity:**
- Must create InventoryMovement records for input deductions (OUT), output additions
  (IN), and any loss or variance (LOSS).
- Must use transaction-safe, atomic inventory updates — no partial writes.
- `previousQuantity` and `newQuantity` must be accurate for every affected lot.

**Genealogy / traceability:**
- Must preserve a traceable link from source lot(s) to output lot(s).
- May require new models: `TransformationEvent`, `TransformationInput`,
  `TransformationOutput`.

**Lot lifecycle:**
- May require new `LotStatus` values: `SEALED`, `OPENED`, `PARTIALLY_USED`,
  `CONSUMED`, `REPACKED`, `BLENDED`, `WASTED`.
- Must not reuse the existing `AVAILABLE` / `RESERVED` / `SHIPPED` states for
  partially-consumed or transformed lots without separate schema review.

**Quantity precision:**
- Must calculate by grams, not only by bag count.
- Bag-count convenience fields may remain for display, but the ledger entry must be
  gram-accurate.

**Reporting isolation:**
- Transformation output quantities must not inflate roasting production dashboard
  metrics (batch count, total roasted kg, production throughput).
- Requires separate reporting metrics:
  - Transformation Output Quantity
  - Repacked Quantity
  - Blended Quantity (finished-goods level)
  - Internal Use
  - Waste / Variance

### Screens Affected

| Screen / Workflow | Impact |
|---|---|
| Warehouse / Inventory Live Screen | Must show lot status including OPENED, PARTIALLY_USED, CONSUMED |
| Packaging Screen | Repack and split operations originate here |
| Dispatch Screen | Partially-used or split lots must be linkable to deliveries |
| Bar Calibration Screen | Internal use and calibration waste route through this concept |
| Transformation / Repack Station Screen | New screen required; does not exist yet |
| Analytics / Reporting | Transformation metrics must be separated from production metrics |

### Blockers

1. **Architecture review** — TransformationEvent model design must be reviewed and
   approved before any schema change is proposed.
2. **Migration baseline** — Resolved 2026-05-22. New models and enum values can now
   be added through reviewed migrations via `prisma migrate dev` → `prisma migrate deploy`.
3. **Policy decisions** — Questions 9–13 in Section 7 must be answered first.
4. **LotStatus enum extension** — Requires schema migration after baseline.

### What This Section Is Not

- This is not a sprint ticket.
- This is not an approved feature.
- This is not a request to modify any existing route, model, or enum.
- This is documentation of a future requirement so that current design decisions
  (FGL status values, InventoryCategory values, delivery routes, packaging routes)
  do not accidentally foreclose the option to implement it correctly later.
