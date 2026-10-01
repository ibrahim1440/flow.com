# Stage 5 — fixed assets, depreciation, disposal, year-end close

Repository [https://github.com/ibrahim1440/flow.com](https://github.com/ibrahim1440/flow.com), branch
`feature/accounting-ledger-core` (unpushed). Designed in Figma first (page 22, `FIGMA_PARITY.md`),
then implemented. Every accounting choice below that is the company's to make is a setting or an
approvable policy; tests use labelled **synthetic** values. Nothing here is accepted.

## 1. What is decided by whom

| Choice | Where it lives | Default | Until decided |
|---|---|---|---|
| Recognition and depreciation policy statement | policy `fixed_assets.depreciation` (four-eyes approval) | none | capitalisation, depreciation and disposal journals are BLOCKED ("waiting for approval"); in the isolated test database they post labelled provisional |
| Per class: accounts, method, useful life, residual rate, declining-balance factor, start and disposal-month conventions, capitalisation threshold | `FaClass` + versioned `FaClassPolicy` (DRAFT → APPROVED by someone else; approved versions are immutable, a change is a new version) | none | an asset of a class without an approved version cannot be capitalised; it is listed with the reason |
| Year-end close statement (retained earnings account, timing) | policy `closing.year_end` | none | the closing journal is BLOCKED |
| Where disposal proceeds are recorded | chosen per disposal (any posting account except party controls and bank/cash accounts) | none | a disposal with proceeds cannot be submitted without it |

## 2. Fixed-asset register

`FaAsset`: number, name, class, branch / cost centre, in-service date, cost, residual value,
method, useful life (months), declining factor, start convention — copied from the class's approved
policy when the asset is drafted and editable in DRAFT (a departure from the class needs a reason,
shown to the approver).

Cost comes from **sources** (`FaAssetSource`):
- **Bill line** — a posted supplier-bill line. Its net amount is the cost. If the line was posted to
  the class's cost account there is nothing to post; otherwise capitalisation reclassifies it
  (Dr cost account / Cr the line's account). A bill line funds at most one asset (unique), and not
  more than its net amount.
- **Account** — an amount against a named counter account (e.g. payables for fixed assets, or
  opening-balance equity for an asset brought in at cutover). Dr cost / Cr counter.
- **Already in the ledger** — the cost is already in the class's cost account (e.g. from the
  opening trial balance). No journal.

An asset brought in at cutover may carry **opening accumulated depreciation** and the number of
months already depreciated, with its own counter (or "already in the ledger").

Lifecycle: DRAFT → SUBMITTED → CAPITALISED (approved by someone other than the preparer; database
trigger) → DISPOSED; CAPITALISED → CANCELLED only while no depreciation has posted (the
capitalisation journal is reversed). Capitalisation posts through the event pipeline
(`fa.asset.capitalised`, exactly once).

## 3. Depreciation

Monthly, by run (`FaDepRun`, one live run per fiscal period):

- **Straight line, cumulative target.** For an asset with depreciable base
  `B = cost − residual − opening accumulated` over `L` remaining months, the accumulated amount after
  `k` depreciable months is `round2(B × k / L)`; the month's charge is the target less what has
  posted. Rounding never drifts and the last month lands exactly on the residual value. Months
  missed (an asset capitalised late with an earlier in-service date) are caught up in the first run
  that includes it, and the line says so.
- **Declining balance.** Monthly charge `round2(NBV × factor / (L_total/12) / 12)`, never below the
  residual value; the last month of the life takes the net book value down to the residual.
- **Conventions (per class, approved):** start in the in-service month or the month after; in the
  disposal month charge a full month or none.
- A run is computed (DRAFT), approved by someone other than its preparer, then posted:
  `Dr depreciation expense / Cr accumulated depreciation`, per class account pair and branch, dated
  the period's last day.
- **Refusals:** the period is not OPEN; a live run already exists for the period; a later period
  has a posted run; the run changed since it was computed (the approver sees a recomputation);
  approving one's own run.
- **Reversal:** only the latest posted run, by request and approval of someone else; the reversing
  journal posts to the run's period (which must be open) and the period can be run again.
- **Concurrency:** creating a run takes a transaction-scoped advisory lock on the period, and a
  partial unique index allows one live run per period; posting is exactly once through the event
  pipeline.

## 4. Disposal

`FaDisposal` (sale, scrap or write-off): date, proceeds (0 for a write-off), proceeds account,
reason. Needs depreciation posted up to the month before the disposal (and the disposal month if the
class charges it); the service states which run is missing. Approved by someone else, then:

```
Dr accumulated depreciation (to date)      Dr proceeds account (proceeds)
Cr asset cost                              Dr loss on disposal / Cr gain on disposal (difference)
```

A disposal can be reversed (request + approval of someone else) while no later depreciation run
exists; the asset returns to CAPITALISED.

## 5. Register ↔ ledger reconciliation

Per cost and accumulated-depreciation account (classes may share an account), as of a date:
register total (capitalised cost of assets not disposed; opening accumulated + posted depreciation −
disposed) against the GL balance. Every difference is itemised: GL lines on those accounts that no
asset explains (for example a bill line posted to the machinery account and never registered, or a
manual journal), and register items whose journal has not posted (blocked, waiting for approval).

## 6. Year-end close and next-year opening balances

The ledger is perpetual: balance-sheet balances carry forward without an entry, so the opening
balances of year Y+1 are the closing balances of year Y. What the close does is move the year's
revenue and expense into retained earnings.

`YearEndClose` for fiscal year Y:
1. **Blockers** (all must be clear): all twelve periods of Y are LOCKED (so nothing else can post);
   no pending journals or waiting events dated in Y; depreciation has posted for every month of Y
   for every asset in service; year Y−1 is closed if it had postings; year Y+1 exists; Y has ended.
2. **Prepare:** computes, per revenue and expense account and per branch / cost centre, the year's
   net (posted entries dated in Y, excluding earlier closing entries) and the one balancing line to
   retained earnings. Stored as a snapshot.
3. **Approve** (someone other than the preparer): the snapshot is recomputed; any difference
   refuses the approval.
4. **Post:** one `CLOSING` journal dated the last day of Y. The database allows a CLOSING entry
   into a LOCKED period (and nothing else); the engine refuses a CLOSING entry into an OPEN period.
5. **Result:** the income statement for Y is unchanged (it excludes CLOSING entries); the balance
   sheet at the end of Y shows current-year earnings 0 and retained earnings increased by the net
   income; the trial balance of Y+1 opens with zero on every revenue and expense account.
6. **Reopen:** while the periods of Y are still LOCKED (not CLOSED), the close can be reversed by
   request and approval; the reversing entry is also CLOSING-typed so the income statement stays
   right. Once any period of Y is CLOSED the close is final.

The period close (LOCKED → CLOSED) is unchanged; for a year with a close, period 12 cannot be
CLOSED until the close has posted.

## 7. Tests (written with the code; synthetic values)

`fixed-assets.test.ts` (DB): policy gating; straight line with rounding to the residual; catch-up;
declining balance; runs refused for locked periods, duplicates, a later posted run and one's own
approval; concurrent runs (one wins); a retried post (exactly one journal); reversal and re-run;
disposal with gain and with loss, and its reversal; reconciliation showing an unregistered bill
line. `year-end.test.ts` (DB): blockers; prepare/approve/post; concurrent approvals; retry;
statements before and after; next-year opening trial balance; posting into the closed year refused;
reopen and re-close. HTTP: authorisation and the runtime role. Browser: register, capitalise, run,
dispose, close, through the forms.
