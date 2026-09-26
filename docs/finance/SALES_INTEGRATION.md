# Finance ↔ Sales/CRM collections — inventory, conflicts and integration plan

Inspected **read-only** on 2026-09-26 after `git fetch` (remote refs only). No branch, worktree
or stash other than this branch was changed; nothing was merged or cherry-picked.

| Ref | Commit | Notes |
|---|---|---|
| `origin/main` (base of this branch) | `4640cbe` | |
| `feature/sales-crm-commissions` (local) | `aa9ef8c` | one commit ahead of its remote (`46f713c`): browser-suite setup/teardown only, no schema/source change; worktree `C:\Projects\ERP-sales-crm` is clean |
| `feature/ui-ux-alignment` | `fdc5e4d` → `901a50a` | navigation registry + design tokens; no migrations. **Actively moving:** another session committed dashboard/orders/preparation rework during this review (reflog 12:44–13:08 +03:00) |
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
| re-check with the committed branch head `597dd9c`: `feature/ui-ux-alignment` `901a50a` / sales `aa9ef8c` | unchanged: `layout.tsx` / the same five files | — |

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

## 4. Approval status and the integration run

**No approved sales/navigation integration commit exists.** The GitHub repository has one pull
request ever (#1, Accounting S0, merged); none for `feature/sales-crm-commissions` or
`feature/ui-ux-alignment`, and no integration branch on the remote. `feature/ui-ux-alignment`
is not pushed and was being committed to by another session during this work
(`fdc5e4d` → `901a50a`). Dependency: **someone must approve a sales (and navigation) commit to
integrate against.** Until then the finance branch keeps the five tests skipped, with their
exact assertions (`tests/finance/integration/sales-collection.planned.test.ts`).

To prove the behaviour now, the combination was run on a **disposable, local-only** branch:

| | |
|---|---|
| Trial branch | `trial/finance-sales-integration-20260926` (not pushed; worktree in the session scratchpad) |
| Merge commit | `71b3043` — parents `aa9ef8c` (sales) and `4bb76bb` (finance) |
| Follow-ups | `bf1aec9` schema rebuilt as sales schema + finance-appended block (the text merge had split a model); `bbf8008` sales-collection links + the five tests implemented; `04419a7` trial-only guard change for its database |
| Database | `erp_finance_integration` on the local server (marked disposable; guard allow-listed only on the trial branch) |
| Conflicts resolved | `.gitignore`, `package.json`, `prisma/schema.prisma` (keep both); `auth-shared.ts` (`sales`, `commissions`, `finance`); `layout.tsx` (sales registry) + `finance.cash` node in `src/lib/nav/registry.ts`, group opened to `finance` and `accounting` holders |
| Results | typecheck clean; `npm run build` compiles; finance unit 36/36; finance DB **33/33 with 0 skipped** (the five sales-collection tests run and pass); Playwright `permissions`/`responsive`/`ui-resilience`/`critical-path` 32 passed, 2 failed — **the same two fail on the sales head `aa9ef8c` alone** (a dispatch test also failing on `origin/main`, and `permissions` expecting a top-level Orders link the sales registry moved), so the integration adds no failure |
| Kept as patches | `docs/finance/integration/sales-collection-integration.patch` (links, suggestion, reversal alert, unique indexes, tests) and `nav-registry-finance-node.patch` — apply with `git apply --ignore-whitespace` on the approved integration commit |

Source branches (`feature/sales-crm-commissions`, `feature/ui-ux-alignment`, `main`) were not
changed.

## 5. What the implemented tests prove (trial branch)

One approved collection matched to one bank receipt is exactly one economic cash receipt and
cannot be allocated twice:

| Test | Proves |
|---|---|
| approving a collection moves no finance cash, allocation or actual | `approveCollection` creates the CollectionEvent only; bank lines, eligible cash, allocation entries/runs and budget receipts unchanged |
| statement receipt is the only cash; allocation and actual counted once, even when retried or raced | one bank line; `decideCollectionMatch` → MATCH by reference; the same link twice returns the same match (retry); VAT 1,050.00 from the collection; three concurrent `runAllocation` → one AllocationRun, a later retry changes nothing; eligible 8,050.00 once; actual 8,050.00 once |
| one collection ↔ one bank line: a second link either way is refused | service 409 both ways; direct INSERT of a duplicate active link violates the partial unique index; two concurrent identical links resolve to one |
| a reversed collection flags the link and changes no cash | after `reverseCollection`: cash, allocations and runs unchanged; overview raises `COLLECTION_REVERSED`; the reversed collection cannot be re-linked elsewhere |
| re-import after linking inserts nothing and keeps the link | fingerprint duplicate; link unchanged |

## 6. Commit `aeb384a`

`aeb384a` is an ordinary single-parent commit on `feature/finance-cash-budget` (parent
`597dd9c`; also reachable from the trial branch below only as an ancestor of its merge). It changes one documentation file: it **records** the re-run of the trial merges
against the moving `ui-ux-alignment` head. It is **not** a merge commit, and no trial branch
existed then: those trial merges were done with `--no-commit` in detached, temporary worktrees
that were removed afterwards. The only trial branch is `trial/finance-sales-integration-20260926`
above, created in the closure pass.
