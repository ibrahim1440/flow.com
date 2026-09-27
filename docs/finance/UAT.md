# Finance + Sales — local UAT candidate (2026-09-26)

Local integration and UAT preparation only. **Not a release.** Nothing pushed, merged or
deployed; no production or shared Neon database touched.

## Candidate

| | |
|---|---|
| Branch | `uat/finance-sales-20260926` (local) |
| Starting point | `9351e74710343259767e460f3f5cf6629e30c266` (integration candidate r2: Sales `aa9ef8c` + Finance `87d7f02`, Sales navigation included) |
| Added on top | the resolved decisions D2–D6 (DECISIONS.md), the Sales-collection link in the review panel, UAT fixture additions, rehearsal tooling, local shell-suite config, docs |
| Deferred | `feature/ui-ux-alignment` (separate navigation rewrite, `4255637`): outside this Finance review, not integrated, not a prerequisite |
| Source branches, `main` | unchanged |
| Database | `erp_finance_integration_dev` on the local portable PostgreSQL (127.0.0.1:54329), marked disposable |

## Running it

Server: `npx next start -p 3080` in the candidate worktree (build from the same commit).
URL: **http://localhost:3080/login**. Reset the data at any time (server may keep running):

    npx tsx --env-file=.env scripts/finance/seed-local-fixture.ts --reset

Logins (password: `FIN_FIXTURE_PASSWORD` in the worktree's gitignored `.env`):

| Login | Use it as | Duties |
|---|---|---|
| `fin.manager` | **preparer** (browser profile 1) | enter/classify, reconcile, prepare, allocate, settings, all branches |
| `fin.approver` | **approver** (browser profile 2) | approve budgets, transfers, overrides; close periods; all branches |
| `fin.admin` | administrator (branch access) | finance settings, all branches, may edit employees |
| `fin.viewer`, `no.finance` | read-only / no Finance | — |

Fixture Sales records (created through the Sales services, not by hand): customer **مقهى القصر
(Al Qasr Café)**, deal "house blend", accepted quotation Q-2026-0417 (5,000.00 + VAT 750.00 =
5,750.00); collection submitted by `sales.rep` and **approved in Sales by `sales.verifier`**,
reference IN-2301. The bank statement imported on 26 Sep contains the matching receipt
"TRANSFER AL QASR CAFE" 5,750.00 (unreviewed).

## Walkthrough (two browser profiles)

| # | Who | Where | Do | Expect |
|---|---|---|---|---|
| 1 | Preparer | Transactions | Open **TRANSFER AL QASR CAFE** | Status "بحاجة لمراجعة" and the Save buttons visible; four sections closed; box "تحصيل مبيعات مقترح" naming مقهى القصر · 5,750.00 (VAT 750.00) · IN-2301 · by reference |
| 2 | Preparer | same panel | **ربط التحصيل** (Link collection) | Green "Linked to an approved Sales collection"; pool unchanged (eligible 142,932.25, allocated 99,300.75) |
| 3 | Preparer | same panel | Classification "تحصيل من عميل", category "تحصيلات عملاء الجملة", **Save and mark reviewed**, then **Allocate by approved rules** | Allocated 99,300.75 → **102,800.75** (+3,500.00: VAT 750.00 from the collection + 55% of 5,000.00); eligible still 142,932.25; the Allocate button disappears (a retry changes nothing) |
| 4 | Preparer | Transactions | **INCOMING TRANSFER 88213** → "مقبوضات تشغيلية أخرى" → review → allocate | Allocated → 104,065.75; unallocated from that receipt 1,035.00 |
| 5 | Preparer | Monthly budget | Month selector → "+ New budget…" (2026-11, empty) → add Rent 12,000.00 → Submit | "أُرسلت للاعتماد"; the preparer has no Approve |
| 6 | Approver | Approvals | Approve "ميزانية 2026-11" | Leaves the queue |
| 7 | Preparer | Cash allocation | Payment request: green coffee, Colombia bill 31,200.00 | Held for the named approver (above limit and balance) |
| 8 | Approver | Approvals | Approve "دفع 31,200.00" with a note | Reserved; allocated → 115,028.45 |
| 9 | Preparer | Transactions | Manual entry: SNB-CUR, −31,200.00, **Pending**, ref TRF-AC771; classify as supplier payment / green coffee | Eligible → **111,732.25** (committed pending outflow deducted once); allocated 83,828.45 |
| 10 | Preparer | Cash allocation | Open request → **تسجيل الدفع المنفّذ** → pick the AC-771 line | "The app sends no money"; balances unchanged (111,732.25 / 83,828.45 / 27,903.80) |
| 11 | Preparer | Transactions | Import CSV: `2026-09-26,-31200.00,TRF-AC771,OUTWARD TRANSFER ANDES` | Preview "confirms a recorded line: 1", import inserts 0; the line shows "Confirmed by the bank statement"; balances unchanged |
| 12 | Either | Monthly budget (Sep) | Comparison table | Green coffee actual **57,700.00** (not 88,900.00); wholesale **54,050.00**; other receipts **2,300.00**; total receipts 108,120.00, payments 80,387.75; zero rows say which indicator is outstanding |
| 13 | Either | Reports & settings → Audit log | Latest entries | collection linked, review, allocation runs, budget created/submitted/approved, request, override approved, payment recorded, statement confirmation — each with user and time |

Decision checks on the same data: Cash allocation shows "+ فئة جديدة" and the explanation
under "حصة أرباح المالك" only; Obligations → **إلغاء** opens a dialog that shows the effects and
cannot be confirmed without a reason (press "رجوع" to leave data unchanged); Settings shows
branch-access controls only to `fin.admin`.

### Company pool after each step (SAR; automated run of the same flow)

| Step | Eligible cash | Allocated | Unallocated |
|---|---:|---:|---:|
| Fixture as seeded | 142,932.25 | 99,300.75 | 43,631.50 |
| Collection linked (receipt not yet reviewed) | 142,932.25 | 99,300.75 | 43,631.50 |
| Receipt reviewed as a customer receipt | 142,932.25 | 99,300.75 | 43,631.50 |
| Allocated by approved rules | 142,932.25 | 102,800.75 | 40,131.50 |
| Allocation retried | 142,932.25 | 102,800.75 | 40,131.50 |
| Unknown deposit reviewed and allocated | 142,932.25 | 104,065.75 | 38,866.50 |
| Payment request 31,200.00 approved (reserved) | 142,932.25 | 115,028.45 | 27,903.80 |
| Pending payment line recorded and classified | 111,732.25 | 83,828.45 | 27,903.80 |
| Payment recorded against the pending line | 111,732.25 | 83,828.45 | 27,903.80 |
| Statement confirmed the payment line | 111,732.25 | 83,828.45 | 27,903.80 |

The 5,750.00 receipt is in eligible cash from the moment the statement was imported (it is
confirmed bank money); linking the Sales collection and reviewing the line add nothing — the
receipt is counted once. The VAT reserve rises 6,300.00 → 7,050.00 (the collection's VAT).
Green-coffee category balance ends at −10,962.70: the approved override spent beyond the
category's balance, and the shortfall is shown, not hidden.
