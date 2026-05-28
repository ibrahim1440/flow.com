# Hiqbah Coffee ERP — Integration & Device Readiness

> **Note:** This document is an architecture constraint document, not an implementation approval.
> It defines the rules that must govern all future third-party and device integration work.
> It must not be used as approval to implement integrations, add schema models, add routes,
> connect devices, or build webhook infrastructure. Those activities require separate review
> and approval after the gates in Section 20 are met.

## Last Validated

Generated from architecture review on 2026-05-22.
Must be revalidated after any new integration is proposed, any schema change to integration-adjacent models, or any change to the ERP's source-of-truth models.

---

## Related Documents

- [docs/module-map.md](module-map.md) — Module boundaries, guards, sub-privileges, known gaps
- [docs/inventory-ledger-coverage.md](inventory-ledger-coverage.md) — InventoryMovement ledger events and gaps
- [docs/saas-readiness.md](saas-readiness.md) — SaaS/multi-tenant architecture constraints
- [docs/migration-drift-and-db-constraints.md](migration-drift-and-db-constraints.md) — Migration baseline status and DB constraints

---

## 1. Purpose

This document exists to prevent ad-hoc direct integrations into the ERP's core production, inventory, QC, delivery, accounting, and ledger routes.

Without a documented architecture constraint, the natural shortcut when connecting a roasting machine, scale, POS system, or payment gateway is to call an existing ERP API route directly from the device or external system. That shortcut produces:

- fake inventory entries from misconfigured or compromised devices
- inflated production records from unvalidated machine data
- broken traceability when external data enters the ledger without a validated ERP operation
- duplicate records when devices retry submissions after network failures
- cross-tenant data exposure in a future multi-tenant deployment
- vendor lock-in when device-specific field formats are baked into production routes

This document defines the only approved pattern for how external systems and devices may communicate with this ERP, and explicitly prohibits all direct alternatives.

---

## 2. Current Readiness Assessment

### Architecture: Partially Integration-Ready

The following current design decisions are integration-compatible:

- **API-first modular monolith.** All business logic lives in API routes. Every workflow has an API surface. An integration adapter can call the same endpoints a browser uses.
- **Transactional inventory writes.** Every stock-impacting operation uses `prisma.$transaction`. Stock deductions are atomic. A device submission cannot create partial state inside an existing transaction boundary.
- **Atomic conditional updates.** The `updateMany WHERE quantity >= amount` pattern in roasting-batches and deliveries is race-condition-safe. A retrying device cannot over-deduct stock if it reaches the existing ERP route through the approved path.
- **InventoryMovement ledger.** The `sourceDocType` and `sourceDocId` fields can carry integration references. The `BLEND` source doc type demonstrates the enum is extensible. A future `DEVICE_READING` or `EXTERNAL_EVENT` type fits the existing pattern.
- **`CoffeeProduct.expectedRoastLoss`.** A per-product expected roasting loss percentage already exists in the schema. This is the validation anchor for machine-reported roasting output.
- **`QcRecord.colorWhole` / `colorGround`.** Color meter measurement fields already exist. The gap is device metadata (serial number, calibration), not measurement storage.
- **Modular permission system.** `requireModule` and `requireSub` are parameterized. A future `integrations` module can be gated using the same pattern as every other ERP module.

### Implementation: Not Integration-Ready

The following are missing and must be built before any integration can go live:

- **No Integration Layer.** There is no separation between inbound external data and committed ERP data. Currently, every POST route commits immediately. A device reading has nowhere to go except directly into production state.
- **No staging area.** There is no model for data that has been received but not yet validated. A roasting machine reading cannot be held in a review queue.
- **No idempotency keys.** No route accepts an external reference ID. A device that retries a submission after a timeout creates a duplicate record.
- **No tenant isolation.** Every integration would touch all tenants' data in a future multi-tenant deployment.
- **No credentials model.** There is no model for storing API keys, OAuth tokens, or webhook signing secrets. Credentials would have to be environment variables — not scalable across tenants.
- **No webhook infrastructure.** No inbound webhook routes exist. No signature verification. No replay protection.
- **No audit trail for external submissions.** If a device sends bad data, there is no record of what it sent, when, or what happened.

---

## 3. Core Source-of-Truth Rule

> **External systems and devices submit raw data, suggested data, imported data, or event data only.**
> **They do not write ERP state directly.**
> **External data is not treated as final truth until the ERP validates and accepts it.**

The following are ERP-authoritative values. No external system or device may set, overwrite, or increment these values directly:

| ERP Model / Field | Authority |
|---|---|
| `GreenBean.quantityKg` | ERP only — via purchase, adjustment, and roasting batch routes |
| `RoastingBatch` (any field) | ERP only — created and mutated by authorized ERP operations |
| `RoastingBatch.status` | ERP only — transitions enforced by `isValidTransition` |
| `FinishedGoodsLot.availableQty` | ERP only — protected by DB-level CHECK constraint; only packaging and delivery routes may change it |
| `InventoryMovement` | ERP only — append-only; created in the same transaction as the stock balance change |
| `QcRecord.decision` | ERP only — set by authorized QC personnel after review |
| `Delivery` records | ERP only — directly affects `OrderItem.deliveredQty` and fulfillment status |
| `OrderItem.deliveredQty` | ERP only — atomic increment via ERP delivery route |
| `OrderItem.productionStatus` | ERP only — computed by `recalcOrderItemStatus` |
| `Order.approvalStatus` | ERP only — controlled state machine (not yet implemented) |
| `Order.paymentStatus` | ERP only — must be validated against expected amount before transition |
| Future accounting/payment state | ERP only — no external system sets financial state without ERP validation |

---

## 4. Do Not Connect Devices Directly to Core ERP Routes

The following routes must never be called directly by a device, external system, or integration adapter acting on behalf of an external system without going through the approved staging and validation pattern in Section 5:

| Route | Reason |
|---|---|
| `POST /api/roasting-batches` | Directly decrements `GreenBean.quantityKg` and creates an `InventoryMovement` |
| `PUT /api/roasting-batches/[id]/package` | Directly creates `FinishedGoodsLot` and an `InventoryMovement` |
| `POST /api/deliveries` | Directly increments `OrderItem.deliveredQty` and decrements `FinishedGoodsLot.availableQty` |
| QC finalize route | Directly sets `RoastingBatch.status` and triggers `recalcOrderItemStatus` |
| Inventory adjustment routes | Directly mutate `GreenBean.quantityKg` and create an `InventoryMovement` |
| Any future accounting/payment transition route | Directly mutates financial state on `Order` |

No device API key, no external system token, and no webhook handler may call these routes directly. They are ERP-internal endpoints, callable only by authenticated ERP users with the required sub-privilege. A human operator (or validated automation confirmed by a human) must be the proximate actor that calls these routes.

---

## 5. Approved Future Pattern

All future integrations and device connections must follow this pattern:

```
External System / Device
        │
        ↓
[Integration Adapter]
— normalize external field names and units to ERP terminology
— authenticate request (device API key or webhook signature)
— reject invalid signatures, expired timestamps, oversized payloads
— reject unregistered devices
        │
        ↓
[DeviceReading or ExternalEvent — staging record]
— raw payload stored as JSON (permanent record of what was received)
— not yet ERP state
— status: PENDING
        │
        ↓
[Validation Layer]
— compare against ERP business rules
— check quantities against available stock
— check roasting loss against CoffeeProduct.expectedRoastLoss
— check unit conversions and range plausibility
— check idempotency (externalEventId already processed?)
        │
        ├─── Within thresholds ─────────────────────→ [Auto-promote with audit flag]
        │
        └─── Outside thresholds / suspicious ──────→ [ManualReviewItem queue]
                                                              │
                                                              ↓
                                                     [Human reviewer approves or rejects]
        │
        ↓
[ERP Core Route — called as if by an operator]
— existing production / inventory / QC / delivery routes
— standard permission guards enforced
— standard transaction safety enforced
        │
        ↓
[InventoryMovement / IntegrationLog]
— sourceDocType includes integration reference
— IntegrationLog records the full chain: received → validated → accepted → ERP op committed
```

This pattern guarantees:

- The ERP's transactional safety and inventory guards are never bypassed
- Every external data point has a permanent staged record regardless of whether it was accepted
- Every ERP state change triggered by an integration is traceable back to the original device reading or external event
- Human review is enforced whenever data falls outside expected thresholds

---

## 6. Roasting Machine Integration Principles

### Data a Roasting Machine May Submit

A roasting machine may submit the following data fields as a `DeviceReading`:

| Field | Maps to ERP | Notes |
|---|---|---|
| Roasting batch ID / reference | `RoastingBatch.batchNumber` | Must be matched against existing batch, not auto-generated by machine |
| Bean name / SKU | `greenBeanId` / `productId` | Machine must send an ID that resolves to an ERP `GreenBean` or `CoffeeProduct` |
| Green weight input (kg) | `RoastingBatch.greenBeanQuantity` | Must validate against `GreenBean.quantityKg` availability |
| Roasted weight output (kg) | `RoastingBatch.roastedBeanQuantity` | Must validate against `CoffeeProduct.expectedRoastLoss` |
| Waste quantity (kg) | `RoastingBatch.wasteQuantity` | Must satisfy: roasted + waste ≤ green input |
| Roast profile name | `RoastingBatch.roastProfile` | Currently stored as free-text string |
| Batch status | `RoastingBatch.status` | Machine cannot set directly — must go through `isValidTransition` |
| Roasting loss % | Derived from input and output weights | `CoffeeProduct.expectedRoastLoss` is the validation anchor |
| Temperature curve | Raw JSON on `DeviceReading` | No structured field on `RoastingBatch` yet — store as raw payload |
| Development time | Raw JSON on `DeviceReading` | Future field on `RoastingBatch` |
| First crack time | Raw JSON on `DeviceReading` | Future field on `RoastingBatch` |
| Roasting duration | Raw JSON on `DeviceReading` | Future field on `RoastingBatch` |
| Start / end timestamp | Raw JSON on `DeviceReading` | `RoastingBatch.date` is a single DateTime; start/end are future fields |
| Operator identifier | Raw JSON on `DeviceReading` | No `operatorId` field on `RoastingBatch` yet |
| Machine name / serial number | `ConnectedDevice.serialNumber` | Resolved via device registration, not stored on `RoastingBatch` |

### Rules

1. **Machine data must create a `DeviceReading` first, not a `RoastingBatch` directly.** The machine never calls `POST /api/roasting-batches`. It calls the future device reading submission route. The ERP creates the `RoastingBatch` after validation and confirmation.

2. **Out-of-range roasting loss must trigger a warning and route to manual review.** The validation threshold is `(greenInput - roastedOutput) / greenInput × 100` compared against `CoffeeProduct.expectedRoastLoss ± configurable tolerance`. If outside tolerance, the reading is held in the `ManualReviewItem` queue and must not auto-promote.

3. **`CoffeeProduct.expectedRoastLoss` is the validation anchor.** This field already exists in the schema (`@default(15.0)`). It must not be removed or repurposed. Future integration validation will use it to determine whether a machine-reported roasting loss is plausible for the given product.

4. Machine-reported data that passes validation may be auto-promoted to a `RoastingBatch` only if it is within thresholds and an audit flag is set indicating the batch was machine-originated.

---

## 7. Scale / Weight Device Principles

**Scale readings must never directly update inventory.** A scale reading is a physical measurement. It is not an ERP commitment.

Scale `DeviceReading` records must include: device serial number, reading timestamp, measured weight in grams (raw), unit, calibration certificate reference, and intended ERP event type. The ERP event type signals which existing route will be called upon confirmation.

Confirmation (human or validated-automation) is required before a scale reading may affect any of the following:

| ERP Event | Route called after confirmation |
|---|---|
| Goods receipt | `POST /api/purchases` |
| Roasting input weight | `POST /api/roasting-batches` |
| Roasted output weight | Batch update route |
| Packaging run | `PUT /api/roasting-batches/[id]/package` |
| Delivery quantity | `POST /api/deliveries` |
| Future transformation input/output | Future transformation route |

Tolerance and calibration:

- The ERP should store a tolerance range per device and per event type in the `ConnectedDevice` model.
- A reading outside calibration tolerance must require manual review even if within business range.
- Calibration certificate references should be stored on `ConnectedDevice` as metadata links, not as documents inside the ERP database.

---

## 8. Color Meter / QC Device Principles

`QcRecord.colorWhole` and `QcRecord.colorGround` already exist in the schema. Color meter measurement values have a home. The gap is device metadata.

### Rules

1. **Color meter readings are suggestions, not official QC values.** A device reading must be stored as a `DeviceReading` with `readingType: COLOR`. It must not write to `QcRecord` directly.

2. **Operator confirmation is required.** A QC operator reviews the reading and decides whether to create or update a `QcRecord` with the suggested values. The operator's confirmation calls the existing QC record creation route.

3. **`CustomerRoastPreference` targets can assist review.** `CustomerRoastPreference.targetColorWhole`, `targetToleranceWhole`, `targetColorGround`, and `targetToleranceGround` exist in the schema. The validation layer can automatically compare the device reading against these targets and annotate the `DeviceReading` as in-range or out-of-range before the operator review, reducing the operator's cognitive load.

4. **Device serial number and calibration metadata** must be stored on a future `ConnectedDevice` record, not on `QcRecord`. The `DeviceReading` references the `ConnectedDevice` that produced the measurement.

---

## 9. Barcode / QR Scanner Principles

**Scanners are lookup devices, not write devices.** A scanner resolves an identifier to an ERP record. It does not trigger any write operation directly.

### What Scanners May Resolve

| Scanned code | Resolves to |
|---|---|
| Lot barcode / QR | `FinishedGoodsLot` |
| Batch barcode / QR | `RoastingBatch` |
| Order / order item QR | `OrderItem` |
| SKU barcode | `ProductSKU` |
| Green bean serial | `GreenBean` |

### Rules

1. Scan resolution must include a tenant filter (`WHERE tenantId = currentTenant` when multi-tenancy is implemented). A lot ID that exists in another tenant's data silently resolves as not-found.

2. Invalid scans (code not found, code from wrong tenant, code for a deleted record) must return a not-found response. They must not reveal whether the record exists in another tenant.

3. Scanner events should be logged (device ID, scanned value hash, resolved entity type and ID, timestamp, tenant) for audit purposes and anomaly detection.

4. A scan does not constitute authorization to perform any operation. The operator must still confirm any action (pick, deliver, package) through the ERP workflow after the scan resolves the record.

---

## 10. POS / Accounting / Payment / Shipping / Messaging Principles

### POS Orders

- **Inbound.** POS sends order data; ERP creates `Order` and `OrderItem` records.
- **Must be idempotent.** POS systems retry on timeout. The POS system's own order ID must be stored as an `externalRefId` on the `Order` record. A duplicate submission with the same `externalRefId` returns the existing record without creating a duplicate.
- **Must be validated.** Product IDs must resolve to live `CoffeeProduct` / `ProductSKU` records. Customer data must resolve or create a `Customer`. Quantities must be positive finite numbers.
- **Must not set ERP status fields.** The ERP controls `approvalStatus`, `paymentStatus`, and `productionStatus`. POS data populates order content only.
- **Manual review required for:** unknown products, quantities above configured thresholds, customers that cannot be matched.

### Accounting Integration

- **Primarily outbound.** ERP exports `Order`, `Delivery`, and `PurchaseRecord` data to the accounting system.
- **Inbound:** accounting confirmation numbers and journal entry IDs may be stored as metadata on ERP documents. They do not alter ERP business state.
- **Event-driven.** Accounting export events must be triggered by ERP state transitions (delivery completed, purchase received), not by polling.
- **Auditable.** Every export and import action must be logged in `IntegrationLog`.

### Payment Gateway

- **Inbound webhooks only.** Gateway sends payment events (charge succeeded, charge failed, refund processed).
- **Requires webhook signature verification.** Every inbound payment webhook must verify the provider's HMAC or RSA signature before reading the payload.
- **Must be idempotent.** Payment events are deduplicated by the gateway's own event ID stored in `ExternalEvent.externalEventId`. The same event processed twice must produce no additional state change.
- **Must not set `Order.paymentStatus` directly.** The ERP validation layer must confirm that the payment amount matches the expected order amount and that the event has not been seen before, before calling the internal payment status transition.
- **Replay protection.** Reject webhook payloads with timestamps older than a configured window (default 10 minutes).

### Shipping Provider

- **Inbound tracking events only.** Carrier scan events (picked up, in transit, delivered) update a future `ShipmentTracking` record.
- **Must not mutate ERP `Delivery` records.** `Delivery` records represent physical goods dispatched from the roastery. Carrier logistics events are external to the ERP's delivery model and must not be conflated with it.

### WhatsApp / Email / SMS Notifications

- **Outbound only.** Triggered by ERP events (order confirmed, delivery scheduled, cupping session invited, payment received).
- **Must be asynchronous.** Notification sends must never block an ERP API response. They run as background jobs via the future `IntegrationJob` model.
- **Must log send attempts and delivery receipts** in `IntegrationLog`.
- **No inbound message parsing** into ERP records. Inbound WhatsApp messages are not parsed into ERP state without a separate business decision and NLP design review.

---

## 11. Suggested Future Models

> **Status: Not approved for implementation. Design sketches only.**
> No Prisma schema code. No migration. No implementation.
> The migration baseline gate is met (2026-05-22). These models still require the SaaS
> tenant model design approval (see docs/saas-readiness.md) before any implementation begins.
> All tenant-owned models must include `tenantId` when designed — but tenantId must not be
> added to any model until the Tenant model exists and the migration strategy is approved.

---

### `IntegrationProvider` — Platform-global

Represents a supported external system or device type. Managed by platform admin, not tenant admin.

Fields (indicative): `id`, `name`, `providerType` (enum: ROASTING_MACHINE, SCALE, COLOR_METER, BARCODE_SCANNER, POS, ACCOUNTING, PAYMENT_GATEWAY, SHIPPING, MESSAGING), `webhookSigningAlgorithm`, `isActive`, `configSchema` (JSON schema for TenantIntegration config)

No credentials stored here. No tenant-specific data here.

---

### `TenantIntegration` — Tenant-scoped

Represents a tenant's active connection to one `IntegrationProvider`.

Fields (indicative): `id`, `tenantId`, `providerId`, `config` (JSON, non-sensitive settings only), `credentialId` (FK to IntegrationCredential), `isActive`, `createdAt`, `updatedAt`

One row per tenant + provider pair. Config contains non-sensitive settings (base URLs, module IDs, feature flags). Secrets are in `IntegrationCredential`.

---

### `IntegrationCredential` — Tenant-scoped

Stores encrypted API keys, OAuth tokens, and webhook signing secrets.

Fields (indicative): `id`, `tenantId`, `integrationId`, `encryptedPayload`, `algorithm`, `keyVersion`, `expiresAt`, `rotatedAt`

**Encrypted at rest. Never logged. Never returned in API responses. Separate from config to support credential rotation without changing integration settings.**

---

### `ConnectedDevice` — Tenant-scoped

Represents a registered physical device.

Fields (indicative): `id`, `tenantId`, `integrationId`, `deviceType` (enum: SCALE, COLOR_METER, BARCODE_SCANNER, ROASTING_MACHINE, IOT_SENSOR), `serialNumber`, `name`, `locationId` (nullable, for multi-location), `calibrationDate`, `isActive`, `lastSeenAt`, `createdAt`

Every `DeviceReading` must reference a registered `ConnectedDevice`. Unregistered devices are rejected at the adapter layer.

---

### `DeviceReading` — Tenant-scoped

Staging record for a raw device measurement. Not yet ERP state.

Fields (indicative): `id`, `tenantId`, `deviceId`, `readingType` (enum: WEIGHT, COLOR, TEMPERATURE, BARCODE, TELEMETRY), `rawPayload` (JSON — permanent record of everything the device sent), `measuredAt`, `unit`, `status` (enum: PENDING, VALIDATED, ACCEPTED, REJECTED, IN_REVIEW), `reviewedBy`, `reviewedAt`, `promotedToEntityType`, `promotedToEntityId`, `correlationId`, `createdAt`

`rawPayload` is written once and never altered — it is the permanent record of what the device claimed. ERP promotion is tracked via `promotedToEntityType` and `promotedToEntityId`.

---

### `ExternalEvent` — Tenant-scoped

Staging record for a webhook or API event from an external system.

Fields (indicative): `id`, `tenantId`, `integrationId`, `eventType`, `externalEventId` (provider's own event ID — unique constraint with `integrationId` for deduplication), `rawPayload` (JSON), `payloadHash`, `receivedAt`, `status` (enum: PENDING, PROCESSED, FAILED, DUPLICATE, IN_REVIEW), `processedAt`, `failedReason`, `retryCount`, `correlationId`

`externalEventId` + `integrationId` unique constraint is the deduplication mechanism.

---

### `IntegrationMapping` — Tenant-scoped

Maps external field names/values to ERP field names/values for a specific provider.

Fields (indicative): `id`, `tenantId`, `integrationId`, `externalField`, `erpModel`, `erpField`, `transformFn` (optional expression or lookup table reference)

Allows different POS systems to use different product ID formats mapped to ERP `ProductSKU.skuCode` without changing ERP routes.

---

### `IntegrationLog` — Tenant-scoped

Immutable append-only audit trail of every integration action.

Fields (indicative): `id`, `tenantId`, `integrationId`, `deviceId` (nullable), `sourceType` (DEVICE_READING, EXTERNAL_EVENT, OUTBOUND_JOB), `sourceId`, `action`, `result` (enum: SUCCESS, FAILURE, REVIEW_REQUIRED, DUPLICATE, REJECTED), `entityType`, `entityId`, `userId` (nullable — the ERP user who confirmed, or null if automated), `correlationId`, `notes`, `timestamp`

**Never delete rows from this table. It is append-only.**

---

### `IntegrationJob` — Tenant-scoped

Background job record for async integration operations (outbound notifications, accounting exports, polling).

Fields (indicative): `id`, `tenantId`, `integrationId`, `jobType`, `payload`, `status` (enum: QUEUED, RUNNING, COMPLETED, FAILED, DEAD_LETTER), `scheduledAt`, `startedAt`, `completedAt`, `retryCount`, `maxRetries`, `lastError`, `correlationId`

---

### `FailedIntegrationJob` / Dead-Letter Concept — Tenant-scoped

Jobs that have exhausted all retry attempts move to dead-letter status. A separate dead-letter view or model allows operations teams to inspect, manually retry, or permanently discard jobs that have repeatedly failed.

`IntegrationJob.status = DEAD_LETTER` is the minimum implementation. A dedicated model may be warranted if dead-letter jobs require different retention or visibility policies.

---

### `ManualReviewItem` — Tenant-scoped

Queue of device readings or external events that require human review before being accepted into ERP state.

Fields (indicative): `id`, `tenantId`, `sourceType` (DEVICE_READING, EXTERNAL_EVENT), `sourceId`, `reason` (enum: OUT_OF_RANGE, UNKNOWN_PRODUCT, DUPLICATE_SUSPECTED, VALIDATION_FAILED, THRESHOLD_EXCEEDED, CALIBRATION_ALERT), `assignedTo` (employeeId, nullable), `status` (enum: PENDING, APPROVED, REJECTED), `reviewedBy`, `reviewedAt`, `notes`, `createdAt`

---

### `WebhookEndpoint` — Tenant-scoped

Registers an inbound webhook path per integration per tenant.

Fields (indicative): `id`, `tenantId`, `integrationId`, `path`, `signingKeyRef` (reference into IntegrationCredential), `isActive`, `lastReceivedAt`, `createdAt`

---

### `WebhookDelivery` — Tenant-scoped

Records each inbound webhook delivery attempt for a `WebhookEndpoint`.

Fields (indicative): `id`, `tenantId`, `endpointId`, `externalEventId`, `receivedAt`, `signatureValid`, `payloadHash`, `httpStatus`, `processingStatus`, `processingError`

Distinct from `ExternalEvent`: `WebhookDelivery` records the transport-level receipt; `ExternalEvent` records the business-level event content.

---

## 12. Suggested Future API Structure

### Public Webhook Routes (No Employee Session — Signature-Verified)

| Route | Purpose |
|---|---|
| `POST /api/integrations/webhooks/[provider]` | Inbound webhook intake for any registered provider. Verifies signature, writes `ExternalEvent`, responds 200 immediately. No employee JWT required. Provider identified by path segment matched to `IntegrationProvider`. |

These routes must verify the provider's webhook signature before touching the payload. If signature verification fails, return 400 and log the failure. Do not return 401 (which would confirm the endpoint exists).

### Device API Key Routes (Device Authentication — Not Employee JWT)

| Route | Purpose |
|---|---|
| `POST /api/device/readings` | Submit a device measurement. Authenticated by device API key tied to a registered `ConnectedDevice`. Not a browser route. |

Device API keys authenticate as a device, not as an employee. A device may only submit `DeviceReading` records. It has no access to ERP read or write routes.

### Internal Authenticated Routes (Employee Session — Standard Guards)

| Route | Guard | Purpose |
|---|---|---|
| `GET/POST /api/integrations/providers` | Platform admin | Manage `IntegrationProvider` records |
| `GET/POST/PATCH/DELETE /api/integrations/tenant-integrations` | `requireModule("integrations")` | Tenant manages their own provider connections |
| `GET/POST/PATCH/DELETE /api/integrations/devices` | `requireSub("integrations", "manage_devices")` | Register and manage `ConnectedDevice` |
| `GET /api/integrations/device-readings` | `requireModule("integrations")` | View incoming device readings |
| `POST /api/integrations/device-readings/[id]/approve` | `requireSub("integrations", "review")` | Promote staged reading to ERP operation |
| `POST /api/integrations/device-readings/[id]/reject` | `requireSub("integrations", "review")` | Reject staged device reading |
| `GET /api/integrations/review-queue` | `requireModule("integrations")` | View `ManualReviewItem` queue |
| `POST /api/integrations/review-queue/[id]/approve` | `requireSub("integrations", "review")` | Approve a queued review item |
| `POST /api/integrations/review-queue/[id]/reject` | `requireSub("integrations", "review")` | Reject a queued review item |
| `GET /api/integrations/jobs` | `requireModule("integrations")` | View `IntegrationJob` status |
| `GET /api/integrations/logs` | `requireModule("integrations")` | View `IntegrationLog` (read-only) |

All internal routes are scoped to the current tenant. No route may return or modify data from another tenant.

---

## 13. Security Requirements

All future integration implementation must satisfy the following requirements. These are constraints, not suggestions.

| Requirement | Detail |
|---|---|
| Webhook signature verification | Verify HMAC-SHA256 (or provider algorithm) on every inbound webhook before reading the payload. Reject if missing or invalid. |
| Replay protection | Reject webhook payloads with timestamps outside a configurable window (default 10 minutes). Log rejected replays. |
| Idempotency keys | Store `externalEventId` per integration. Duplicate event returns 200 without reprocessing. No state change on duplicate. |
| Encrypted secrets | All API keys, OAuth tokens, and signing secrets encrypted at rest. KMS or envelope encryption. Key version tracked for rotation. |
| No plaintext credentials | Secrets must never appear in logs, API responses, error messages, or environment variables committed to version control. |
| Device authentication | Each `ConnectedDevice` has a device-specific API key. Device keys authenticate as devices, not employees. Separate auth path from employee JWT. |
| Least privilege | Device API keys may only submit readings of their registered device type. Integration API keys may only perform their declared operation. No integration token has admin access. |
| Tenant isolation | Every integration route query includes `WHERE tenantId = currentTenant`. A device from Tenant A cannot read or mutate Tenant B's data under any circumstance. |
| Rate limiting | Integration intake routes must enforce per-device and per-tenant rate limits. A misbehaving device cannot flood the staging table. |
| Payload size limits | Inbound webhooks and device submissions must enforce payload size limits (default 1MB). Reject oversized payloads before parsing. |
| Input validation | Map external fields to ERP fields explicitly. Validate types, ranges, and required fields before any ERP operation. Reject unknowns. |
| Mass assignment prevention | Never spread external payloads directly into Prisma `create` or `update` calls. Destructure and whitelist every field explicitly. |
| Audit logs | Every integration action (received, validated, accepted, rejected, reviewed, promoted) written to `IntegrationLog`. Immutable. Never deleted. |
| Monitoring and alerts | Alert on: dead-letter queue growth, repeated signature failures from one source, repeated validation failures from one device, abnormal event volume spikes. |
| Manual review for suspicious data | Any reading or event outside configured thresholds must be held in `ManualReviewItem`. Must not auto-accept anomalous data. |

---

## 14. SaaS / Multi-Tenant Constraints

This section is consistent with the constraints in `docs/saas-readiness.md`. Both documents govern the same design space.

> **Every integration model and device model must be designed with `tenantId` from day one.**
> **No tenantId columns may be implemented until the Tenant model design is approved.** (Migration baseline is met — 2026-05-22. Tenant model design remains pending.)

| Model | Tenant scope |
|---|---|
| `IntegrationProvider` | Platform-global — not tenant-scoped |
| `TenantIntegration` | Tenant-owned |
| `IntegrationCredential` | Tenant-owned |
| `ConnectedDevice` | Tenant-owned |
| `DeviceReading` | Tenant-owned |
| `ExternalEvent` | Tenant-owned |
| `IntegrationMapping` | Tenant-owned |
| `IntegrationLog` | Tenant-owned |
| `IntegrationJob` | Tenant-owned |
| `ManualReviewItem` | Tenant-owned |
| `WebhookEndpoint` | Tenant-owned |
| `WebhookDelivery` | Tenant-owned |

**Cross-tenant isolation rules:**

- `IntegrationProvider` is managed by the platform. Tenant admins can select from available providers but cannot create or modify provider definitions.
- No tenant admin may view, modify, or trigger actions against another tenant's `TenantIntegration`, `ConnectedDevice`, `DeviceReading`, `ExternalEvent`, `IntegrationLog`, or `ManualReviewItem`.
- A device registered to Tenant A cannot submit readings that affect Tenant B's inventory.
- A webhook intended for Tenant A's payment gateway cannot be processed by Tenant B's integration handler, even if the signing secret were exposed.
- Barcode scan resolution must include `WHERE tenantId = currentTenant`. A lot ID from Tenant B resolves as not-found for Tenant A's scanner.
- Platform admin can view all tenant integrations for support purposes but cannot perform tenant operations on behalf of a tenant without explicit design approval.

---

## 15. Event / Queue Strategy

### Inbound Direction (Device / External System → ERP)

| Event type | Strategy |
|---|---|
| Webhook intake | Synchronous receipt + async processing. Intake route verifies signature and writes `ExternalEvent`. Returns 200 immediately. Background job processes the event. |
| Device reading submission | Synchronous receipt (writes `DeviceReading`, responds with reading ID). Async validation and promotion. |
| Barcode scan resolution | Fully synchronous. Scanner needs an immediate response. No staging required for read-only lookups. |

### Outbound Direction (ERP → External System)

| Event type | Strategy |
|---|---|
| Notifications (WhatsApp/Email/SMS) | Always async. ERP writes `IntegrationJob`. Background processor sends. Never blocks ERP API response. |
| Accounting export | Async. Triggered by ERP state transitions. Background processor runs export. |
| Shipping API calls | Async. Background job polls or pushes. ERP is not blocked by carrier API availability. |

### Retry Strategy

- Exponential backoff: attempt 1 (immediate) → attempt 2 (1s) → attempt 3 (5s) → attempt 4 (30s) → attempt 5 (5min)
- After 5 failed attempts: mark `IntegrationJob.status = DEAD_LETTER`. Trigger operational alert.
- Dead-letter jobs are visible in `GET /api/integrations/jobs` with status filter. Operators can manually retry or permanently discard.

### Idempotency and Deduplication

- `ExternalEvent.externalEventId` + `integrationId` unique constraint prevents duplicate event processing.
- `IntegrationJob` status must be checked before processing begins. A job with `status = COMPLETED` is skipped.
- Correlation IDs: every external event receives a correlation ID at intake. All `IntegrationLog` entries for that event carry the same ID for end-to-end debugging.

### Deduplication Window

Reject inbound webhook payloads with timestamps older than 10 minutes. Return 400 with an explicit error code. Log the rejection. This limits replay attack window without being so tight that legitimate provider retries fail.

---

## 16. Testing Strategy

When integration implementation begins, all of the following tests are required before any integration goes to production:

- **Webhook signature validation:** valid signature accepted; tampered payload rejected with 400; missing signature rejected; expired timestamp rejected; replayed valid payload rejected after window expires
- **Duplicate event handling:** same `externalEventId` submitted twice — second returns 200, no duplicate `ExternalEvent` or state change, duplication flag set in log
- **Tenant isolation:** device from Tenant A cannot submit readings against Tenant B's integration ID; webhook for Tenant A cannot be processed by Tenant B's handler; cross-tenant scan returns not-found
- **Malformed payload rejection:** missing required fields, wrong types, values outside safe ranges — all rejected with 400 before any ERP state change; rejection logged
- **Device authorization:** unregistered serial number rejected; deactivated device rejected; valid device from wrong tenant rejected
- **Roasting loss validation:** reading within expected loss range → accepted or auto-promoted; reading outside range → held in `ManualReviewItem`, no `RoastingBatch` created
- **Scale tolerance:** reading within calibration tolerance → proceeds to confirmation; outside tolerance → manual review queue regardless of business range
- **Color meter value validation:** Agtron value within plausible range (0–100) → accepted for operator review; outside range → flagged before reaching operator
- **Retry and dead-letter behavior:** background job fails 5 times → moves to DEAD_LETTER; alert triggered; subsequent manual retry attempt via review route works correctly
- **Manual review approval:** `ManualReviewItem` approved by authorized reviewer → ERP operation created; approved by unauthorized user → 403; item already approved cannot be approved again; item already rejected cannot be approved
- **No direct inventory mutation from device input:** submitting a device API key to `POST /api/roasting-batches` returns 401/403; only authenticated employee sessions with `requireSub("production", "start_batch")` may call that route; no exception

---

## 17. What Is Deferred

The following must not be implemented until the gates in Section 20 are met:

- All integration database models (`IntegrationProvider`, `TenantIntegration`, `IntegrationCredential`, `ConnectedDevice`, `DeviceReading`, `ExternalEvent`, `IntegrationMapping`, `IntegrationLog`, `IntegrationJob`, `ManualReviewItem`, `WebhookEndpoint`, `WebhookDelivery`)
- Inbound webhook routes (`/api/integrations/webhooks/[provider]`)
- Device registration and device API key authentication system
- Device reading submission route (`/api/device/readings`)
- `DeviceReading` validation and promotion logic
- `ExternalEvent` processing jobs
- `ManualReviewItem` queue and review routes
- `IntegrationLog` model and write logic
- `IntegrationJob` model and background job processor
- Retry and dead-letter queue infrastructure
- Credential storage and encryption at rest
- Webhook signature verification middleware
- Idempotency key tracking
- Any vendor-specific adapter (Cropster, Ikawa, Giesen, Loring, Foodics, Lightspeed, QuickBooks, Xero, Stripe, Tap Payments, Aramex, FedEx, Twilio, WhatsApp Business API)
- SaaS tenant integration management UI
- IoT production monitoring dashboards
- Platform admin integration panel
- Device location management
- Integration analytics or reporting

---

## 18. What Must Not Be Done

The following are explicitly prohibited. They are not deferred — they are never acceptable outside of the approved pattern in Section 5.

1. **Do not call production, inventory, QC, or delivery routes directly from devices or external systems.** `POST /api/roasting-batches`, `POST /api/deliveries`, `PUT /api/roasting-batches/[id]/package`, QC finalize, and inventory adjustment routes are ERP-internal. They must not be exposed to device or external system tokens.

2. **Do not spread external payloads into Prisma `create` or `update` calls.** Every external field must be destructured and whitelisted explicitly before reaching any database operation.

3. **Do not let devices write `InventoryMovement` directly.** The ledger is written only by the same transaction that changes the stock balance in the authoritative ERP model. No integration adapter, no device, and no webhook handler may call `prisma.inventoryMovement.create` directly.

4. **Do not store credentials in plaintext.** No API keys, OAuth tokens, webhook signing secrets, or device API keys may be stored in plain text in the database, in logs, in environment variable files committed to version control, or in API responses.

5. **~~Migration baseline gate~~ — Met (2026-05-22).** Do not implement integrations before the SaaS Tenant model design is approved (see Section 20, Gate 2). All integration models are tenant-owned and require `tenantId`. Adding new models without the Tenant model design approved creates the same cross-tenant data isolation risk.

6. **Do not implement integrations before the SaaS tenant model design is approved.** Integration models without `tenantId` create the same cross-tenant data isolation risk as all other tenant-unscoped tables.

7. **Do not bypass ERP validation or the manual review queue.** A device reading that falls outside the expected roasting loss range, a payment event that does not match the expected amount, or a scale reading outside calibration tolerance must always route through manual review. Auto-accept must never be the only path for out-of-range data.

8. **Do not treat device or external system data as final truth.** See Section 3. ERP models are authoritative. External inputs are always suggestions until the ERP validates and commits them.

---

## 19. Cross References

| Document | Relevance |
|---|---|
| [docs/module-map.md](module-map.md) | Module boundaries and permission guards. Future `integrations` module follows the same guard pattern. |
| [docs/inventory-ledger-coverage.md](inventory-ledger-coverage.md) | `InventoryMovement` ledger gaps and coverage. Integration-originated movements must satisfy the same ledger requirements as all other movements. |
| [docs/saas-readiness.md](saas-readiness.md) | SaaS/multi-tenant architecture constraints. All integration models are tenant-owned and subject to the same `tenantId` design constraint. The migration baseline gate applies to both SaaS and integration implementation. |
| [docs/migration-drift-and-db-constraints.md](migration-drift-and-db-constraints.md) | Migration baseline status — **Complete (2026-05-22)**. Future schema changes via `prisma migrate dev` / `prisma migrate deploy`. |

---

## 20. Final Recommendation

**Add integration readiness as an architecture constraint now. Do not implement integrations now.**

This decision mirrors the SaaS decision in `docs/saas-readiness.md`:

- The architecture is clean enough to extend. Nothing in the current design makes integrations impossible.
- The risk of ad-hoc integration — connecting a device directly to `POST /api/roasting-batches` — is concrete and would produce exactly the fake inventory, broken traceability, and duplicate record problems described in Section 1.
- This document as an architecture constraint prevents that risk at near-zero cost.
- All integration models are tenant-owned. They require `tenantId` in their design. That requires the Tenant model (migration baseline is met; Tenant model design is the remaining gate).

**Gates that must be cleared before integration implementation begins:**

1. ~~Migration baseline established~~ — **Complete (2026-05-22)**
2. SaaS Tenant model designed and approved (see docs/saas-readiness.md)
3. Integration model designs reviewed and approved against the pattern in this document
4. Security requirements in Section 13 reviewed and approved for the target integration

**No code changes. No schema changes. No database changes. No migrations. This document is the action.**
