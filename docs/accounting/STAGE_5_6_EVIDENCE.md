# Stages 5 and 6 — requirement → evidence

Repository [https://github.com/ibrahim1440/flow.com](https://github.com/ibrahim1440/flow.com), branch
`feature/accounting-ledger-core` (**unpushed**). The commit the tests ran on and their counts are in
[`TEST_RESULTS.md`](TEST_RESULTS.md). Local results on synthetic data, produced and reported by the
implementer; not an independent review, not accountant acceptance, not production readiness, and —
for stage 6 — **not ZATCA validation**.

Categories: **V** implemented and verified locally (named test) · **I** implemented, not verified ·
**X** incomplete · **D** awaiting an accounting decision (approval-gated) · **C** blocked only by
cloud / network access.

| # | Requirement (brief) | Cat. | Evidence / what is missing |
|---|---|---|---|
| 5.1 | Fixed-asset register | V | `fixed-assets.test.ts`; register and reconciliation screen (`fa-forms.mjs`, ACC-60) |
| 5.2 | Acquisition and capitalisation (four-eyes) | V | from a posted bill line (no journal when already on the asset account), a counter account (Dr cost / Cr counter), or an opening balance; preparer cannot approve (service + DB trigger); a bill line funds one asset; threshold enforced — `fixed-assets.test.ts`, `fa-forms.mjs` steps 1–2 |
| 5.3 | Configurable, approval-gated depreciation policies | V (mechanism) / D (values) | class policy versions approved by someone else, immutable once approved (trigger); asset departures need a reason; policy statement `fixed_assets.depreciation` gates every journal (BLOCKED until approved, posts once on retry) — `fixed-assets.test.ts` |
| 5.4 | Depreciation runs | V | straight line (cumulative target, no drift, last month exact), declining balance, catch-up — `fa-depreciation.test.ts` (6); runs computed, recomputed at approval, posted once — `fixed-assets.test.ts`, `fixed-assets.test.mjs`, `fa-forms.mjs` step 4 |
| 5.5 | Disposal | V | gain and loss, bank accounts refused as proceeds accounts, depreciation must be up to date — `fixed-assets.test.ts`, `fa-forms.mjs` step 3 |
| 5.6 | Reversals | V | run reversal latest-first with four-eyes, then re-run; disposal reversal; capitalisation cancelled only before depreciation — `fixed-assets.test.ts`, `fa-forms.mjs` step 5 |
| 5.7 | Reconciliation to the ledger | V | register vs GL per cost and accumulated account, differences itemised (unregistered bill line, other journals, balances already in the ledger, journals not yet posted) with an unexplained remainder — `fixed-assets.test.ts`, `fa-forms.mjs` (unexplained 0.00 on the fixture) |
| 5.8 | Year-end closing entries and retained earnings | V / D (statement) | `year-end.test.ts` (2): CLOSING entry into the locked period 12, per account/branch/cost centre, net to 3200; income statement unchanged; balance sheet current earnings 0 |
| 5.9 | Next-year opening balances | V | perpetual ledger: `openingBalancesAfter` shows P&L zero and balance-sheet balances carried; `year-end.test.ts` |
| 5.10 | Retry tests | V | event re-processing posts once (capitalisation, run, close) — `fixed-assets.test.ts`, `year-end.test.ts` |
| 5.11 | Concurrency tests | V | two runs for one period at once → one; two approvals of a run → one post (HTTP); two approvals of a close → one — `fixed-assets.test.ts`, `fixed-assets.test.mjs`, `year-end.test.ts` |
| 5.12 | Closed-period tests | V | run refused for a locked period; nothing else posts into a closed year; a CLOSING entry never posts into an open period; the close is final once period 12 is CLOSED — `fixed-assets.test.ts`, `year-end.test.ts` |
| 5.13 | Year-end close exercised in the browser | V | `year-end-forms.mjs` via `scripts/accounting/local-year-end-browser.sh`: isolated disposable database `erp_finance_yearend` with a synthetic prior year and next year, server as the runtime role; conditions all met in the page; prepared by the preparer (their approval refused: no button, 403); approved and posted by a second person; closing entry, retained earnings, statements and next-year opening balances equal hand-calculated amounts (net income 80,000.00); screens `ACC-65-ye-*` |
| 6.1 | Verify requirements against official ZATCA documentation | C (partial) | titles, versions, dates and URLs confirmed by search on zatca.gov.sa; the documents themselves are blocked by the egress policy — `STAGE_6_DESIGN.md` §1 |
| 6.2 | E-invoice document (standard, simplified, credit, debit) | V (local) | `einvoice.test.ts`, `tax-forms.mjs`; structure unverified against the standard |
| 6.3 | Document validation | V (local rules) / C (SDK) | 20+ `LOCAL-*` checks — `einvoice-pure.test.ts`, `einvoice.test.ts`; **official SDK validation blocked**: download refused (403), evidence `evidence/zatca/access-attempts-2026-09-29.txt` |
| 6.4 | Calculations | V | line and document arithmetic, per-category VAT, totals — `einvoice-pure.test.ts`; VAT return boxes — `einvoice.test.ts` |
| 6.5 | Credit/debit-note references | V | billing reference and reason required; debit notes as invoices raising a posted invoice (same customer, no goods) — `einvoice.test.ts`, `tax-forms.mjs` step 3 |
| 6.6 | Chain (ICV, previous hash), concurrency, immutability | V | gapless under six concurrent postings; DB refuses change, delete and out-of-chain inserts — `einvoice.test.ts`, `tax.test.mjs` |
| 6.7 | Retries | V (against a local stub) | invalid documents do not consume the chain and are retried after fixing (`einvoice.test.ts`, `tax-forms.mjs` step 2); submission back-off, due processing, accepted is final — `einvoice.test.ts` |
| 6.8 | Audit evidence | V | immutable e-invoices, append-only attempts (trigger), audit entries per generation and attempt — `einvoice.test.ts`, `tax.test.mjs` |
| 6.9 | Separation of local validation from sandbox clearance/reporting | V | LOCAL_ONLY records "not sent"; production path refused (unit, DB, HTTP); screens carry the banner |
| 6.10 | Sandbox clearance / reporting | C | not done: needs network access to gw-fatoora.zatca.gov.sa, developer-portal onboarding and a test CSID |
| 6.11 | Signature / cryptographic stamp | X | local test key on secp256k1 (enforced), DER, over the hash bytes; not XAdES, not a CSID; tag 9 absent and shown on screen as a gap |
| 6.14 | QR tags 6–9 checked independently of the implementation | V (local, both layouts) | `einvoice-qr-independent.test.ts`: TLV bytes written by hand; tag 8 = X‖Y of d·G from the SEC 2 constants; tag 7 = r‖s from DER parsed by hand; the QR's own tags verify under a BigInt verifier; P1363 padding on hand-made DER; FIPS 180-2 vector; rules catch the other layout and a mismatched stamp. These encode implementation assumptions, not official conformance |
| 6.15 | QR tag 6–8 encodings as the official documents specify | V (local, as cited) / C (SDK) | default `OFFICIAL_DOCS` follows the owner-cited Security Features §4.1 (32-byte hash) and Developer Portal Manual (P1363 signature, 64-byte key); the cited lines could not be re-read here (egress blocked); **official SDK validation still required**; curve/profile to confirm |
| 6.16 | Standards gaps visible to users | V | e-invoice detail lists the gaps (not SDK-validated; local key; QR encodings unconfirmed, curve/profile to confirm; tag 9 absent) — `tax-forms.mjs` steps 4–4b |
| 6.17 | Application-generated six-document matrix (standard and simplified invoice, credit note, debit note) | V (local rules) / C (SDK) | `zatca-matrix.sh` → `evidence/zatca/matrix-19f3639/` (commit 19f3639, the gate-tested commit): all six pass the local rules; hashes in `SHA256SUMS`; SDK not run — `ZATCA_SDK_VALIDATION.md` |
| 6.18 | Strict QR parsing | V | truncated, duplicated or non-base64 TLV refused (was read as shorter values); malformed DER refused — `einvoice-qr-independent.test.ts` |
| 6.12 | VAT reporting | V (local) / D (box mapping) | boxes and reconciliation with unexplained remainder — `einvoice.test.ts`, `tax-forms.mjs` step 5; items not modelled listed on the page |
| 6.13 | No invoices to customers or ZATCA production | V | nothing sends to customers; the production path is refused by code and not selectable (DB check) |
| 7.1 | Figma first for new work, compared with the screens | V | pages 22 (ACC-60..65) and 23 (ACC-70..72) drawn before the code; comparison and differences in `FIGMA_PARITY.md` |
| 7.2 | Migrations rehearsed on a production copy | X | the three stage 5–6 migrations are local only (`REQUIREMENTS_MATRIX.md`) |
