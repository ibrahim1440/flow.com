# Sales & Commissions — Implementation Plan

**Branch:** `feature/sales-crm-commissions` · **Base:** `4640cbe` (released Unified Packaging V2)
**Status:** in progress — see `VERIFICATION_REPORT.md` for what is actually proven.

---

## 1. What the inspection found

Read before designing anything. Every statement here was checked against the source, not assumed.

| Question | Finding |
|---|---|
| Framework | Next.js **16.2.4** (App Router), React 19.2.4, TypeScript 5, Tailwind 4 |
| ORM / DB | Prisma **7.8.0**, PostgreSQL (Neon) |
| Existing CRM models | **None.** No Lead, Opportunity, Deal, Quote, Activity, Pipeline, Commission or SalesTarget model exists. |
| Existing customer model | `Customer` — deliberately minimal: `name`, `nameAr`, `phone`, `email`, `address`. No contacts, no industry, no owner. |
| Existing order model | `Order` + `OrderItem`, with a mature lifecycle (approval, preparation review, allocation, dispatch). |
| Existing invoicing | **None.** No `Invoice`, `Payment`, `Receipt`, `CreditNote` or collection model exists anywhere. |
| Accounting | `Account`, `JournalEntry`, `JournalEntryLine`, `TaxCategory`, `FiscalPeriod`, `AccountingEvent` exist — a general ledger, not a receivables ledger. |
| Money convention | `Decimal @db.Decimal(18,2)`, with an explicit schema comment that money must not be `Float`. |
| Auth | `Employee` with `role` + a JSON `permissions` blob; helpers `hasModuleAccess`, `canEdit`, `hasSubPrivilege`. |
| Multi-tenancy | **None.** There is no company/tenant/organisation model. The system is single-company. |

### Two findings that shape the whole design

**1. There is no source of collection truth.** The commission base specified in the brief is
*net qualified collections*. Nothing in this system records an invoice, a payment, or a
receipt. The general ledger exists but is an accounting-event sink, not a receivables
subledger. Building a receivables system is explicitly out of scope for this task.

→ Commission input is therefore an **adapter** (`CollectionSource`) with one implementation
in this branch: a clearly-labelled sandbox that records collection events entered for
testing. The financial cycle is **not** integrated, and the UI says so rather than
implying it is. See §6.

**2. The system is single-company.** Per the brief, this must not be dressed up as tenant
isolation. Ownership scoping is implemented (`ownerId` on Lead/Opportunity, team scoping
for managers), and the code is written so a `companyId` could be added later, but nothing
here claims SaaS isolation and no test asserts it.

---

## 2. Reuse decision — NextCRM

Reviewed at a pinned commit (see `UPSTREAM_SOURCES.md`). **Outcome: reference only, no code
copied.** Reasons, each verified rather than assumed:

- NextCRM targets a different data layer and its Prisma models carry their own id/auth
  conventions. Importing its schema would create a second customer and user system —
  exactly what the brief forbids.
- Its build step ran `migrate deploy`, which this project separates deliberately.
- Its opportunity status enum did not model WON/LOST as distinct terminal states, which is
  a core requirement here.
- Its conversion-rate metric divided opportunity count by lead count over a period with no
  link proving conversion. That metric is not reproduced; ours is computed from explicit
  `LeadConversion` rows.
- No commission engine exists in it at all — the largest single piece of this task.

What *was* taken: the shape of the pipeline UX (Kanban with stage columns, deal detail with
an activity timeline) as an interaction reference. No files, no dependencies, no licence
obligations incurred. Documented honestly rather than claiming reuse that did not happen.

---

## 3. Data model

New models only. Nothing existing is redefined.

```
Lead ──1:N── LeadActivity
 │
 └─1:1─ LeadConversion ──► Customer (existing)
                      └──► Opportunity

Opportunity ──N:1── PipelineStage        (configurable)
 │         ──1:N── OpportunityStageEvent (audit of every stage move)
 │         ──1:N── SampleShipment
 │         ──1:N── Quote ──1:N── QuoteLine ──► ProductSKU (existing)
 │         ──1:N── OpportunityOwner       (split attribution)
 └────────────────► Order (existing, via quote acceptance, idempotent)

CommissionPlan ──1:N── CommissionPlanVersion ──1:N── CommissionTier
      │
      └─1:N── CommissionAssignment ──► Employee (existing)

CollectionEvent (sandbox adapter) ──1:N── CommissionAccrual ──► CommissionLedgerEntry
SalesTarget ──► Employee
```

Key constraints:

- Stage identity is a **stable code** (`NEW`, `CONTACTED`, …), never a translated label.
- `WON` and `LOST` are `OpportunityOutcome` values on a separate column from `stageId`, so a
  terminal outcome can never be confused with a workflow stage.
- `LeadConversion` is `@@unique([leadId])` — double-clicking convert cannot produce two
  customers or two opportunities.
- `Quote` gets an immutable snapshot on issue; revisions create a new version row.
- `CommissionAccrual` is `@@unique([collectionEventId, employeeId, planVersionId])` — the
  same collection event can never accrue twice for the same person on the same plan.
- All money: `Decimal @db.Decimal(18,2)`. All rates: `Decimal @db.Decimal(9,6)`.

---

## 4. Commission engine

A domain service (`src/lib/services/commissions/`), callable without any HTTP or React, so
the numeric cases in the brief can be asserted directly.

**Base:** net qualified collection = collected amount, less VAT, less refunds, less lines
marked non-qualifying. Tax is excluded by computing the collection's qualifying net
proportionally to the invoice's net/tax split supplied by the adapter.

**Accrual is cumulative-then-difference.** For each (employee, period) the engine computes
the *target cumulative* commission from all qualifying collections to date, then writes only
the difference against what is already accrued. This is what makes partial payments,
re-delivered collection events and rounding safe: a duplicate event changes nothing, and
halves never drift.

**Tiers:** `INCREMENTAL` only in this version. `RETROACTIVE` is present in the enum and is
**refused at validation** with an explicit message, because shipping it silently half-done
is worse than not shipping it. Documented in `COMMISSION_RULES.md`.

**Currency:** SAR only. A collection in any other currency is refused with a clear error
rather than summed at an invented rate — there is no FX policy in this system to honour.

**Periods:** monthly, `Asia/Riyadh`. Boundaries are computed in that zone and stored as UTC
instants; month-edge tests assert both directions.

**Approved accruals are immutable.** A plan edit never rewrites an approved or paid accrual;
corrections are new `ADJUSTMENT` / `REVERSAL` entries carrying actor, reason and a reference
to what they correct.

---

## 5. Permissions

Two new modules in the existing permission system, with sub-privileges:

| Module | Sub-privileges |
|---|---|
| `sales` | `lead_write`, `lead_assign`, `lead_convert`, `lead_import`, `lead_export`, `deal_close`, `deal_reopen`, `quote_write`, `quote_approve_discount`, `stage_manage` |
| `commissions` | `view_own`, `view_team`, `manage_plans`, `approve`, `record_payout` |

`view_own` is the default for a sales employee. Every server handler re-checks module,
sub-privilege **and record ownership** — never the UI alone.

---

## 6. What is deliberately blocked

- **Financial integration.** `CollectionSource` has exactly one implementation here: a
  sandbox that records events entered through a clearly-labelled testing surface. No
  accounting sync, no payment gateway, no payout execution. The commission screens state
  that the collection source is a sandbox.
- **Real messaging.** Activities record that contact happened. No email/WhatsApp/SMS is
  sent; there is no integration to send one.
- **Retroactive tiers.** Enum value exists, validation refuses it.
- **Multi-currency.** Refused, not approximated.

---

## 7. Migration strategy

Additive only. New tables and new enums; no column on an existing table is altered, so the
currently released build keeps working against the new schema. Generated with the installed
Prisma 7.8.0 against a disposable local database, reviewed as SQL, then applied to an
isolated preview branch — never to production, and never from a build step.
