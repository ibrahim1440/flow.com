# Accounting policies — decided, implemented, and still open

## Owner decisions (2026-09-27, recorded verbatim in substance)
| # | Question | Decision | How it is implemented |
|---|---|---|---|
| D-1 | Are the spec's Phase-1 costing defaults binding (weighted average; COGS on delivery B2B / on sale POS; normal roasting loss absorbed, abnormal expensed; separate waste accounts)? | **Needs accountant review.** | No costing, COGS or waste posting exists in this increment. When built, those events will be governed by a `inventory.costing` policy that must be APPROVED before posting (same gate as ADR-05). |
| D-2 | Treatment of cash collected before an invoice exists | Customer advances only for genuine prepayments received before performance; revenue when the performance obligation is satisfied; advances applied to the final invoice without duplicating cash, VAT or revenue; **legacy collections not classified as advances just because an invoice is missing** — check delivery and records, flag ambiguous cases. | **Not yet implemented** (needs sales invoicing/AR). `SalesCollection` produces no journal in this increment. The chart template includes 2410 Customer advances (control). |
| D-3 | Commission journals from PROVISIONAL rules | Full integration now; test postings only in the isolated environment, labelled provisional; production posting blocked server-side until plans are approved; preserve calculation rules; record plan version and source event; no duplicates; enable by configuration later; flag existing contractual obligations for review. | Implemented: outbox trigger, policy `commissions.recognition`, per-plan-version accounting approval (four-eyes), provisional only in a marked test DB, `policyKey/policyVersion/originEventId` on every entry, unique origin event. Existing movements before the cutover are SKIPPED, not posted — **the accountant must bring any existing commission obligation in through the opening balance.** |
| D-4 | Opening-balance cutover date and source | Decide later. | Cutover is a setting; no automatic event posts until it is set. Opening balances enter as an OPENING journal (four-eyes). A bulk trial-balance import is not built yet. |

## Policy `commissions.recognition` (default text, bilingual; must be approved by a second person)
Commission expense and the liability are recognised when a finance-verified collection produces a
commission ledger movement, on that movement's date, for the amount the approved plan version
computes. Reversals/adjustments are recognised when recorded. A payout settles the liability
against *commission payments clearing*; the bank payment clears that account when matched, so the
payment is not expensed twice. Only plan versions approved for accounting post.

## Chart of accounts
`src/lib/accounting/coa-template.ts` is a **template for the accountant to review**, not the
company's approved chart. Control accounts for receivables, payables, inventory, commissions payable
and customer advances refuse manual journals. VAT accounts currently accept manual journals because
POS/sales summaries are journalised by hand until invoicing exists — switch that off when it does.

## Still needed from the business / accountant
1. Approve (or rewrite) policy `commissions.recognition`; approve commission plan versions for accounting.
2. Ledger cutover date and a Qoyod trial balance at that date (with AR/AP/stock detail).
3. Review and adapt the chart-of-accounts template; confirm fiscal year = calendar year.
4. Costing policy (D-1): method, normal-loss bands per product, COGS timing per channel.
5. Existing contractual commission obligations at cutover (D-3).
6. Company VAT registration details and ZATCA onboarding decisions (see `ZATCA_REQUIREMENTS.md`).
