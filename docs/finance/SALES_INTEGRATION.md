# Finance ↔ Sales/CRM collections — inventory, conflicts and integration plan

Inspected **read-only** on 2026-09-26 after `git fetch` (remote refs only). No branch, worktree
or stash other than this branch was changed; nothing was merged or cherry-picked.

| Ref | Commit | Notes |
|---|---|---|
| `origin/main` (base of this branch) | `4640cbe` | |
| `feature/sales-crm-commissions` (local) | `aa9ef8c` | one commit ahead of its remote (`46f713c`): browser-suite setup/teardown only, no schema/source change; worktree `C:\Projects\ERP-sales-crm` is clean |
| `feature/ui-ux-alignment` | `fdc5e4d` | navigation registry + design tokens; no migrations |
| local `main` (main checkout) | `d52f83d` | **51 commits behind `origin/main`** — stale, not an integration target |

## 1. What the sales branch has

**`SalesCollection`** (`prisma/schema.prisma` @ sales, L2132) — a salesperson's claim that a
customer paid, verified by Finance:

- `id`, `opportunityId` (required), `quoteId?`, `orderId?`, `customerId?`
- `idempotencyKey` — `@@unique([submittedById, idempotencyKey])`
- `referenceNumber?` — the payer's transfer/cheque number, deliberately **not unique**
- `amountGross`, `amountTax`, `amountNet` — **`Decimal(18,2)` SAR** (finance uses integer
  halalas in memory and `Decimal(18,2)` in the database — convert exactly, never round)
- `currency` (default `SAR`)
- `paymentMethod`: `BANK_TRANSFER | CASH | CHEQUE | POS_CARD | OTHER`
- `collectedAt` — `TIMESTAMP(3)` UTC instant (finance uses Riyadh calendar dates)
- `status`: `PENDING_VERIFICATION | APPROVED | REJECTED | REVERSED`
- submitter / decider / reverser ids and timestamps, `decisionReason`, `reversalReason`
- `collectionEventId @unique` → `CollectionEvent`
- evidence files (`CollectionEvidence`, PDF/JPEG/PNG ≤ 5 MB, stored in the database)
- CHECKs: positive amounts, `net = gross − tax`, APPROVED/REVERSED ⇔ event present,
  rejection/reversal need a reason
- **no receiving bank account and no link to any bank line**

**Lifecycle** (`src/lib/services/sales/collections.ts` @ sales):

| Action | Route / permission | Effects |
|---|---|---|
| submit | `POST /api/sales/collections` — `sales.collection_submit` | idempotent; no overpayment against the accepted quote; no commission |
| approve | `POST /api/sales/collections/[id]/actions {action:"approve"}` — `commissions` + `collection_verify`; submitter cannot approve | creates `CollectionEvent` (`sourceSystem = MANUAL_FINANCE_VERIFICATION`, `externalRef = collection.id`) and commission accruals |
| reject | same route — `collection_reject`; submitter cannot reject | status only |
| reverse | same route — `collection_reverse`; from APPROVED only | event REVERSED, negative commission delta. **The self-check is UI-only on reverse** (not enforced in the service) — reported to the sales owner, not changed here |

No journal entries, no customer balance, no audit-log rows. `CollectionEvent` is commission
input only and is **not cash**.

Other routes: `GET /api/sales/collections` (scoped), evidence `GET/POST
/api/sales/collections/[id]/evidence[/evidenceId]`, `POST /api/commissions/sandbox-collections`
(env-gated). UI: `/dashboard/sales/collections`, deal `CollectionsPanel`,
`/dashboard/commissions/review`.

**Permissions added** (`src/lib/auth-shared.ts` @ sales): modules `sales`, `commissions`
(appended after `accounting` in `ALL_MODULES`); `sales.*` 12 keys incl. `collection_submit`,
`collection_view_team`; `commissions.*` 9 keys incl. `collection_verify`, `collection_reject`,
`collection_reverse`. `buildDefaultPermissions` unchanged — as with Finance, existing
employees (admins included) must be granted the new modules explicitly.

## 2. Real conflicts (trial merge, not assumed)

Method: a dangling commit of this branch's working tree (not on any ref) was merged with
`--no-commit` into each target inside a temporary **detached** worktree, the conflicts listed,
the merge aborted and the worktree removed. No branch moved.

| Target | Textual conflicts | Auto-merged, both sides changed |
|---|---|---|
| `feature/sales-crm-commissions` (`aa9ef8c`) and its remote (`46f713c`) | `.gitignore`, `package.json`, `prisma/schema.prisma`, `src/app/dashboard/layout.tsx`, `src/lib/auth-shared.ts` | `src/lib/i18n/translations.ts` |
| `feature/ui-ux-alignment` (`fdc5e4d`) | `src/app/dashboard/layout.tsx` | — |

Semantic overlaps that a clean text merge would **not** catch:

- **Navigation is rewritten on both branches** into a typed registry
  (`src/lib/nav/registry.ts`). The sales registry already has a `finance` group (Landmark icon)
  containing collections, commissions, "mine" and accounting, whose visibility (`anyOf`) is only
  commission sub-privileges — so an accounting-only user loses the Accounting entry there.
  This branch's `NAV_ITEMS` entry must be dropped in favour of a registry child
  `{ id: "finance.cash", ar: "الخزينة والميزانية", en: "Cash & budget", href: "/dashboard/finance", anyOf: [{ module: "finance" }] }`
  **and** the group's `anyOf` extended with `{ module: "finance" }` (and `{ module: "accounting" }`).
  Without a node, the registry's `routeAllowed` treats `/dashboard/finance` as unclaimed.
- The `finance` translation key becomes unused (labels are inline in the registry) — harmless.
- **Digits:** the sales shell renders the header date with Latin digits
  (`ar-SA-u-nu-latn-ca-gregory`) — consistent with Finance; `ui-ux-alignment` uses plain
  `ar-SA` (Arabic-Indic). The two navigation branches disagree with each other.
- **Migrations:** sales adds `20260924090000_*`, `20260925130833_*`, `20260925131140_*` — all
  sort before this branch's two; no table/enum name clashes; none touch finance tables.
- Sub-key names `period_close` and `settings_manage` exist under both `accounting` and
  `finance` — different modules, no functional clash.
- The whitespace-only `prisma format` realignments this branch previously had in
  `ProductSKU`/`Delivery` were removed, so `schema.prisma` now differs from `origin/main` only by
  one appended block (fewer hunks for the sales merge).

## 3. Integration plan — one approved collection ↔ one bank receipt

Principle: **the bank line is the cash.** A collection never creates a `BankTransaction`, an
allocation or a budget actual; linking adds exactly one `BankTransactionMatch`
(`targetType = SALES_COLLECTION`, `targetId = SalesCollection.id`).

1. Merge order: sales branch first (it owns the models), then finance on top.
2. Resolve the five conflicts as above (keep both schema blocks; `"finance"` after
   `"commissions"` in `ALL_MODULES`; nav registry node instead of `NAV_ITEMS`).
3. In `server/transactions.ts` replace the `SALES_COLLECTION` refusal with: load the collection
   `FOR UPDATE`; require `status = APPROVED`, `currency = SAR`; amount in halalas via
   `collectionMinor()`; **one live link per collection** — add a partial unique index
   `BankTransactionMatch (targetType, targetId) WHERE active AND targetType = 'SALES_COLLECTION'`
   (the existing index is per line+document only); and at most one collection per bank line.
4. Take VAT for the tax reserve from `amountTax` (not typed by the reviewer).
5. Suggestions: `decideCollectionMatch()` (`src/lib/finance/collections-match.ts`, pure, tested)
   — exact amount, BANK_TRANSFER/CHEQUE only, same reference or within −3/+7 days, pending →
   "awaiting verification", ambiguous → a person chooses.
6. Reversal in Sales after linking: flag the match for review in Finance (alert), change no
   cash; a refund is recorded as its own outgoing line.
7. Permissions: matching stays `finance.txn_enter`; verifying stays
   `commissions.collection_verify` — two different people by default.

## 4. Tests

| Test | Where | State |
|---|---|---|
| Decision rule: exact halalas, Riyadh date, reference normalisation, window, one-to-one, status and method gates, ambiguity | `tests/finance/unit/collections-match.test.ts` | **8/8 pass** now |
| Approve moves no finance cash/allocation/actual; statement receipt counted once; one link each way (409); reversal flags only; re-import inserts nothing | `tests/finance/integration/sales-collection.planned.test.ts` | **5 skipped** until `SalesCollection` exists on the merged branch — they document the contract and must be implemented, not deleted, at merge time |
