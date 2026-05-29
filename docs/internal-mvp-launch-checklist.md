# Internal MVP Launch Checklist — Hiqbah Coffee ERP

**Scope:** Internal MVP soft launch — single-tenant, Hiqbah Coffee roastery only
**Status at creation:** PASS WITH WARNINGS — technically ready for internal soft launch review
**Scope freeze reference:** `docs/final-mvp-scope-freeze.md` (2026-05-29)

> Complete each section in order before the Go/No-Go decision in Section 10.
> Mark each item `[x]` when confirmed. Leave `[ ]` for items not yet verified.
> Do not mark items complete unless actually verified.

---

## 1. Launch Status

This checklist covers the internal MVP launch of the Hiqbah Coffee ERP only.

- This is an **internal MVP only** — single-tenant, Hiqbah Coffee roastery use only.
- This is **not a SaaS launch**, not a multi-tenant deployment, and not a public-facing product.
- MVP scope is frozen as of 2026-05-29 per `docs/final-mvp-scope-freeze.md`.
- **No new features enter MVP scope unless classified as a P0 or P1 launch blocker** and approved by the decision owner named in Section 10.
- All other feature requests move to the Phase 2 backlog.
- MVP readiness status: **PASS WITH WARNINGS** — P3/P4 accepted gaps are documented in `docs/final-mvp-scope-freeze.md`. No P0/P1 security gaps were found.

---

## 2. Pre-Launch Technical Checks

Run these checks on launch day, against the production environment, before opening access to users.

**Environment confirmation**
- [ ] Confirm active `DATABASE_URL` endpoint ID is: `ep-icy-field-aq4upc3z` — do not print credentials
- [ ] Confirm host: `ep-icy-field-aq4upc3z.c-8.us-east-1.aws.neon.tech`
- [ ] Confirm database: `neondb`

**Migration status**
- [ ] Run: `npx prisma migrate status`
      Expected: `Database schema is up to date.` — 3 migrations applied
- [ ] Confirm all three migrations are present and applied:
  - [ ] `20260522000000_baseline`
  - [ ] `20260526115344_add_qc_final_decision_reason`
  - [ ] `20260528084853_add_rate_limit`

**Schema drift**
- [ ] Run: `npx prisma migrate diff --from-schema prisma/schema.prisma --to-config-datasource --script`
      Expected output: `-- This is an empty migration.`

**TypeScript**
- [ ] Run: `npx tsc --noEmit`
      Expected: exit 0, no errors, no output

**Production build**
- [ ] Run: `npm run build`
      Expected: `prisma generate` succeeds + `No pending migrations to apply.` + Next.js build succeeds + TypeScript 0 errors
- [ ] Confirm build script is: `prisma generate && prisma migrate deploy && next build`
- [ ] Confirm build script does **not** contain: `db push` or `--accept-data-loss`

**Environment variables**
- [ ] `JWT_SECRET` is set to a strong value (≥ 32 characters) in production `.env`
- [ ] `RATE_LIMIT_SECRET` is set to a real HMAC key in production `.env` (not left as empty fallback)
- [ ] `TRANSLATION_API_KEY` is set if Google Translate is required, or MyMemory fallback is confirmed acceptable
- [ ] `DATABASE_URL` points to the production Neon endpoint (verified above)

---

## 3. Production Data Readiness

Verify via the application UI or Prisma Studio. No code or schema changes required.

**Admin account**
- [ ] Admin user exists in the Employee table with `role: admin`
- [ ] Admin PIN is known, verified to be ≥ 4 digits, unique, and stored securely offline
- [ ] Admin can log in and reach `/dashboard/settings`
- [ ] Admin has all sub-privileges enabled (default for `admin` role)

**Employee accounts**
- [ ] All operational staff accounts created
- [ ] Each employee has the correct role (`inventory`, `roasting`, `qc`, `dispatch`) or a verified custom permission set
- [ ] Each employee has a working PIN (≥ 4 digits, unique across all employees)
- [ ] Each employee's `defaultRoute` is set to their primary workflow page
- [ ] No test or placeholder accounts left active from development

**Suppliers**
- [ ] All active green bean suppliers created in `/dashboard/inventory`
- [ ] Supplier names verified for accuracy (Arabic and English as needed)

**Green beans**
- [ ] All active green bean entries created with correct: bean type, country, process, serial number
- [ ] Opening inventory quantity (kg) recorded for each green bean that has stock on hand
- [ ] Inactive or placeholder beans deactivated (`isActive: false`)

**Coffee products and SKUs**
- [ ] All `CoffeeProduct` entries created with correct `productNameEn` and `productNameAr`
- [ ] All `ProductSKU` entries created and linked to the correct products
- [ ] No test or placeholder products remaining in the catalog

**Initial inventory balances**
- [ ] Opening inventory movements recorded for any green beans that have physical stock on hand
- [ ] All `quantityKg` values verified against a physical stock count
- [ ] `FinishedGoodsLot` records verified if any packaged stock exists on hand at launch

**System settings**
- [ ] Company logo uploaded or confirmed as default (ح glyph)
- [ ] `SystemConfig` singleton record confirmed to exist (auto-created on first logo request)

**Demo / Training Data Cleanup (complete this block only if a demo or training session was run before entering real production data)**

> Skip this block if no demo or training session was conducted on the production database.
> If training was run, all demo records should have used the `DEMO` prefix in their names (e.g., DEMO Supplier, DEMO Product, DEMO Customer). This naming policy must have been enforced by SOP during the training phase — the system does not enforce it automatically.

- [ ] All demo/training records were created with the `DEMO` prefix — or Training Reset has been run to wipe them before real production data is entered.
- [ ] If using Training Reset to clean up: **Training Reset (`POST /api/admin/training-reset`) is irreversible.** It deletes all operational data AND all catalog data (Supplier, CoffeeProduct, ProductSKU). A current backup must exist before it is triggered. Training Reset must not be run after real production data has been entered.
- [ ] After Training Reset (if run): verify the database contains only Employee accounts and SystemConfig. No suppliers, green beans, products, orders, or batches should remain.
- [ ] Real production catalog (Suppliers, Green Beans, CoffeeProducts, ProductSKUs) is ready to be entered fresh per Section 3 above.

---

## 4. Backup and Rollback

Complete this section before any smoke testing or user access is opened.

- [ ] Neon production database snapshot taken immediately before launch
- [ ] Snapshot / restore point name recorded: _______________________
- [ ] Snapshot creation date and time recorded: _______________________
- [ ] Backup owner assigned — name: _______________________
- [ ] Restore procedure documented and verified by a test restore to a **non-production** Neon branch (not production)
      Steps:
      1. Identify the last known-good snapshot name
      2. Restore to that snapshot on Neon (dev or shadow branch — not production)
      3. Verify restored data is intact
      4. Redeploy the last known-good build against the restored branch
      5. Notify affected users

- [ ] Rollback triggers defined (see Section 9 for full list)
- [ ] Emergency contact assigned — name and reachability: _______________________

> **Warning:** The Admin Reset (`POST /api/admin/reset`) is **irreversible** and deletes all operational data.
> A current, verified backup **must** exist before admin reset is ever triggered on production.
> Admin reset is not part of the launch procedure and must not be run on launch-day production data.

---

## 5. Smoke Test Checklist

Run one pass per workflow path in the production environment before opening access to all staff.
Record: **Pass** / **Fail** / **Skip** for each item.
Do not mark any item complete unless the test was actually performed.

**Auth**
- [ ] Login — log in with admin PIN → reaches `/dashboard`; JWT cookie set
- [ ] Wrong PIN — enter incorrect PIN → error shown; access denied; rate limiting activates after repeated failures
- [ ] Logout — log out → redirected to `/login`; cookie cleared; no access to protected pages

**Employee management**
- [ ] Create employee — create a test employee with `roasting` role and a PIN → employee appears in list
- [ ] Edit employee — change the test employee's `defaultRoute` → change persists on reload
- [ ] Login as test employee — log in with the new employee's PIN → reaches correct default route

**Supplier and inventory setup**
- [ ] Create supplier — add a supplier → supplier appears in list
- [ ] Create green bean — add a green bean entry with initial quantity → appears in inventory
- [ ] Record purchase — record a purchase against the new green bean → `quantityKg` increases; `PurchaseRecord` created

**Inventory movements**
- [ ] View inventory movements — `/dashboard/inventory` → movements list loads; no error; within `take: 300` limit
- [ ] Manual adjustment — record a manual inventory adjustment → quantity updates; movement recorded in ledger

**Customer and order**
- [ ] Create customer — add a customer with at least one roast preference → customer appears in list
- [ ] Create order — create an order linked to the customer and a green bean → order appears with correct status

**Production / roasting**
- [ ] Start roasting batch — create a batch against the order item → batch appears with correct status; green bean `quantityKg` decreases
- [ ] Blend batch *(if blend workflow will be used at launch)* — create a blend batch → blend batch created; source batches updated

**QC**
- [ ] Submit QC record — submit a QC record for the batch → record created; batch status updates
- [ ] Finalize QC (Accept) — finalize the batch → status updates to QC-passed state
- [ ] Bulk finalize *(if applicable)* — run bulk finalize on multiple batches → all statuses update correctly
- [ ] Generate guest QC invite — generate a guest QC link for a batch → link contains `batchId` and `token`
- [ ] Guest QC submission — submit a QC record via the guest link → `QcRecord` created with `isExternal: true`; no auth cookie required

**Packaging**
- [ ] Package batch — package a QC-passed batch → `FinishedGoodsLot` created; `InventoryMovement` (FINISHED_GOODS) recorded
- [ ] View finished goods lots — `GET /api/finished-goods-lots` → new lot appears; `availableQty` is correct

**Delivery / dispatch**
- [ ] Delivery with FGL — create a delivery with a valid `finishedGoodsLotId` → delivery recorded; FGL `availableQty` decreases; `OrderItem` delivery status updates
- [ ] Delivery without FGL — attempt delivery with no `finishedGoodsLotId` → 400 returned; no delivery created; error message shown

**History / export**
- [ ] Export orders — `GET /api/export?type=orders` → returns records up to `take: 1000`; no error
- [ ] Export production — `GET /api/export?type=production` → returns records; no error
- [ ] Export QC — `GET /api/export?type=qc` → returns records; no error

**Dashboard**
- [ ] Dashboard load — `/dashboard` → KPI tiles render; no JS errors; `openQcBatches` section loads correctly

**Translate**
- [ ] Translate endpoint — submit a short text string → translated result returned; no 429 on first call

**Public cupping** *(only if cupping sessions will be used at launch)*
- [ ] Create cupping session — create a session with at least one batch → session created with a valid token
- [ ] Access public cupping link — open the session link without an auth cookie → session data returned (blind projection — no bean names exposed)
- [ ] Submit cupping score — POST a score as an external tester → score created; no auth error

---

**⚠ Admin Reset — SPECIAL HANDLING REQUIRED**

- [ ] **Admin reset smoke test**

  > **This item MUST remain unchecked on production launch day.**
  >
  > Admin reset is **irreversible** and deletes all operational data (orders, batches, QC records, deliveries, inventory movements, customers, green beans, and more). Catalog and config data are preserved (employees, suppliers, products, system settings).
  >
  > This test is permitted **only** in a safe, non-production, throwaway dataset — for example, a Neon dev branch with no real operational data.
  >
  > Before checking this item, the following must all be true:
  > - You are **not** on the production database
  > - A current backup of the production database exists and has been verified
  > - The decision owner has explicitly approved running this test
  >
  > What to verify if this test is run in a safe environment:
  > Confirmation phrase + admin PIN accepted → operational data deleted → catalog data (Employee, Supplier, CoffeeProduct, ProductSKU, SystemConfig) preserved → redirect to `/dashboard`

---

**⚠ Training Reset — SPECIAL HANDLING REQUIRED**

- [ ] **Training reset smoke test**

  > **This item applies only during the demo/training phase — before any real production data is entered.**
  >
  > Training Reset is **irreversible** and deletes ALL data including catalog data (Supplier, CoffeeProduct, ProductSKU) in addition to all operational data. It is more destructive than Admin Reset — Admin Reset preserves catalog; Training Reset does not.
  >
  > This test must NOT be run on launch-day production data or after any real production data has been entered.
  >
  > Before checking this item, the following must all be true:
  > - You are in the demo/training phase — no real production data has been entered
  > - A current backup exists (or you accept that all data will be wiped to a clean slate)
  > - The decision owner has explicitly approved running this test
  >
  > What to verify if this test is run during demo/training:
  > Confirmation phrase (`CLEAR DEMO DATA`) + admin PIN accepted → all operational and catalog data deleted → Employee accounts and SystemConfig preserved → redirect to `/dashboard`

---

## 6. Role-Based User Acceptance Testing

One block per role. Each assigned tester completes their own section.
The tester confirms they can perform expected actions and cannot perform restricted ones.

**Admin**
- [ ] Can log in and reach `/dashboard`
- [ ] Can access all modules including `/dashboard/settings` and `/dashboard/employees`
- [ ] Can create, edit, and deactivate employees
- [ ] Can trigger admin reset *(confirm only — do NOT trigger on live production data)*
- [ ] Can trigger training reset *(demo/training phase only — not after real production data has been entered)*
- [ ] Tester name: _______________________ | Date completed: _______________________

**Inventory role**
- [ ] Can log in and reach default inventory page
- [ ] Can access: inventory, purchases, suppliers
- [ ] Cannot access: orders create/edit, production, QC, dispatch, settings, employees
- [ ] Can add a green bean, record a purchase, record a manual adjustment
- [ ] Cannot start a roasting batch or mark a delivery
- [ ] Tester name: _______________________ | Date completed: _______________________

**Roasting role**
- [ ] Can log in and reach default production page
- [ ] Can access: production, packaging, cupping, dashboard
- [ ] Can read inventory (view) and orders (view) — cannot write to either
- [ ] Cannot create orders, cannot mark deliveries, cannot access settings or employees
- [ ] Can start a batch, package a batch, and create a cupping session
- [ ] Tester name: _______________________ | Date completed: _______________________

**QC role**
- [ ] Can log in and reach default QC page
- [ ] Can access: QC, cupping, dashboard
- [ ] Cannot access: inventory writes, order writes, dispatch, settings, employees
- [ ] Can submit a QC record, finalize a batch, and generate a guest QC invite link
- [ ] Tester name: _______________________ | Date completed: _______________________

**Dispatch role**
- [ ] Can log in and reach default dispatch page
- [ ] Can access: dispatch, orders (view), labels, dashboard
- [ ] Cannot access: production writes, QC, inventory writes, settings, employees
- [ ] Can mark a delivery against a valid `FinishedGoodsLot`
- [ ] Correctly blocked when attempting delivery without a `finishedGoodsLotId`
- [ ] Tester name: _______________________ | Date completed: _______________________

---

## 7. Operational SOP Readiness

**SOPs to prepare before launch** *(one page per role, Arabic preferred)*
- [ ] Admin SOP — system access, employee management, what to do if something goes wrong, who to call
- [ ] Inventory SOP — daily bean intake, recording purchases, recording manual adjustments
- [ ] Roasting SOP — starting batches, blend process, moving to QC, packaging workflow
- [ ] QC SOP — submitting QC records, finalizing batches, inviting external testers
- [ ] Dispatch SOP — confirming packaged stock, marking deliveries, verifying finished goods lots, exporting history

**Contingency procedures** *(brief answers, in the team's working language)*
- [ ] **Inventory quantity appears wrong** → check inventory movements list for the last adjustment or purchase; if unexplained, contact admin before making further changes
- [ ] **Delivery fails — no FGL available** → confirm packaging is complete first; FGL is created automatically during the packaging step; do not skip packaging
- [ ] **QC finalization is blocked** → confirm at least one QC record exists for the batch; confirm batch status is "Pending QC"; contact admin if stuck
- [ ] **Packaging cannot proceed** → confirm batch status is QC-passed; confirm the batch is not already fully packaged; contact admin if status is unclear
- [ ] **Login or PIN fails** → admin resets the PIN via the employees page (`PUT /api/employees/[id]`); if the admin PIN itself is lost, the backup owner must perform database-level recovery
- [ ] Support contact name: _______________________ | Reachability: _______________________

---

## 8. Launch Window

- [ ] Launch date and time decided: _______________________
- [ ] Launch window avoids peak production hours (not during an active roasting or dispatch shift)
- [ ] All staff informed of the launch date and given their role-specific SOP in advance
- [ ] First 1–3 days: **limited staff only** — admin plus one operator per role before opening to all staff
- [ ] **Feature freeze confirmed**: no code or configuration deployments during the monitoring window
      Exception: P0/P1 hotfixes only, approved by the decision owner
- [ ] Monitoring owner assigned for first 1–3 days: _______________________

---

## 9. Monitoring and Issue Handling

**Issue severity definitions**

| Severity | Definition | Response target |
|---|---|---|
| **P0** | System down or data corruption — users cannot work | Fix immediately; consider rollback |
| **P1** | Critical workflow blocked for a role — no workaround exists | Fix within 24 hours; escalate to decision owner |
| **P2** | Significant issue with a workaround — operational impact | Fix in next patch within the week |
| **P3** | Minor issue or UX problem — low operational impact | Queue for Phase 2 |
| **P4 / Info** | Cosmetic, edge case, or known accepted gap | Queue for Phase 2 |

**Issue reporting**
- [ ] Issue reporting method defined (e.g., WhatsApp group, shared document, email): _______________________
- [ ] All staff know how to report: module name + action taken + expected result + actual result + screenshot if possible
- [ ] Primary triage contact: _______________________
- [ ] Backup triage contact: _______________________

**Rollback triggers** — any of the following warrants immediate consideration of rollback:
- [ ] P0: data loss or corruption confirmed in production
- [ ] P0: authentication broken for all users
- [ ] P0: admin reset triggered accidentally on production data with no backup
- [ ] P1: critical workflow blocked for a role with no workaround and no fix available within 24 hours

**Items that do NOT require rollback:**
- P3/P4 warnings already accepted before launch (see `docs/final-mvp-scope-freeze.md`)
- Features formally deferred to Phase 2
- UI text or translation display issues
- Performance within MVP safe limits (`take: 300–1000`)
- Behaviour that matches a documented accepted gap (W1–W10 in the scope freeze doc)

---

## 10. Go / No-Go Decision

Complete this section on launch day after all preceding sections are verified.

**Technical readiness**
- [ ] Section 2 (pre-launch technical checks) — all items confirmed
- [ ] Section 3 (production data readiness) — all items verified
- [ ] Section 4 (backup and rollback) — snapshot taken; restore tested; rollback procedure documented
- [ ] Section 5 (smoke tests) — all critical workflow paths passed; admin reset item remains unchecked on production
- [ ] Section 6 (role-based UAT) — all five roles signed off by their respective testers

**Operational readiness**
- [ ] Section 7 (SOP readiness) — all role SOPs prepared and distributed
- [ ] Section 8 (launch window) — date confirmed; feature freeze confirmed

**Decision**

```
  ○  Go             — all sections complete; no blocking issues
  ○  Go with warnings  — minor items outstanding; decision owner accepts risk and records rationale below
  ○  No-Go          — one or more blocking items remain open; launch deferred
```

Decision owner: _______________________
Decision date and time: _______________________
Notes / outstanding items: _______________________

---

> **Reminder:** This is a single-tenant internal MVP only.
> Scope is frozen per `docs/final-mvp-scope-freeze.md`.
> No new features enter MVP after this decision unless classified as P0/P1 by the decision owner.
> Phase 2 priorities are decided after the 1–2 week monitoring window closes.

---

## Cross-References

| Document | Purpose |
|---|---|
| `docs/final-mvp-scope-freeze.md` | Scope freeze record, in-scope modules, deferred items, accepted warnings (W1–W10) |
| `docs/mvp-roadmap-checklist.md` | All 12 Go/No-Go criteria with completion status and Phase 2 backlog |
| `docs/module-map.md` | Full route map, guard functions, sub-privilege enforcement table, and known gaps per module |
| `docs/migration-drift-and-db-constraints.md` | P0 CHECK constraints documentation and migration baseline record |
| `docs/inventory-ledger-coverage.md` | InventoryMovement ledger coverage map including known gaps and deferred ledger entries |
