# Accounting module — handover index

## Which implementation this is

| | |
|---|---|
| Repository | `ibrahim1440/flow.com` — **not** `ibrahim1440/hiqbah_share2`, which is a sanitised public export that contains none of this work |
| Branch | `feature/accounting-ledger-core`, based on `main` @ `fc64c05` |
| Where it is | **not pushed** (GitHub App not installed on `flow.com`): it exists in the working clone and in the incremental git bundle described in `RECOVERY_BUNDLE.md` |
| Tested commit | the SHA named at the top of `TEST_RESULTS.md`; later commits change documentation only |

Links in these documents are relative paths inside this branch. A GitHub link to `hiqbah_share2`
does not identify this implementation.

## Status

Implemented and tested **locally on synthetic data**:
- stage 1: ledger core, commissions;
- stage 2: payables, bank-to-ledger, posted-line corrections, transaction-aware cash-flow statement;
- stage 3: sales invoices, credit notes, customer receipts and advances, AR aging and statements;
- stage 4: inventory valuation, materials-only manufacturing costing, COGS; D-1 is configurable
  and posting is refused until it is decided.

Stages 2 and 3 are **not accepted**; they await the owner's review. The historical-reporting defects
raised in that review (17–19 in `DEFECTS_AND_LIMITATIONS.md`) are fixed and covered by regression
tests that failed before the fix.

Stages 5–6 (fixed assets and year-end, ZATCA sandbox) are **not implemented**. This is not the
complete accounting system the brief describes, and it is not ZATCA-compliant.
`REQUIREMENTS_MATRIX.md` says exactly what exists, what is partial and what is missing. Nothing has
been deployed or run against production.

| Document | What it holds |
|---|---|
| [CURRENT_STATE.md](CURRENT_STATE.md) | Discovery: repositories, environments, production identity, what existed before this work |
| [REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md) | Every requirement area of the brief → implemented & verified / partial / missing / blocked |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Decisions (ADR-01…ADR-10) and why |
| [POLICIES.md](POLICIES.md) | Owner decisions recorded, accounting policies, decisions still needed |
| [EVENT_JOURNAL_MAP.md](EVENT_JOURNAL_MAP.md) | Which source event produces which journal, exactly once |
| [SOURCES_AND_LICENSES.md](SOURCES_AND_LICENSES.md) | Open-source candidates, SHAs, licences; nothing was copied |
| [MIGRATION_AND_CUTOVER.md](MIGRATION_AND_CUTOVER.md) | Migration, rehearsal on a production copy, cutover, rollback/roll-forward |
| [TEST_RESULTS.md](TEST_RESULTS.md) | Commands, environment, commit, results — and what each kind of test does and does not prove |
| [FIGMA_PARITY.md](FIGMA_PARITY.md) | Figma file/frames, frame → route/component map, side-by-side status, deviations |
| [ZATCA_REQUIREMENTS.md](ZATCA_REQUIREMENTS.md) | Saudi e-invoicing / VAT / zakat requirements matrix — **not implemented** |
| [OPERATIONS_GUIDE.md](OPERATIONS_GUIDE.md) | Set-up and month-end procedure for the accountant |
| [UAT_AR.md](UAT_AR.md) | قائمة اختبار القبول للمحاسب (بالعربية) |
| [DEFECTS_AND_LIMITATIONS.md](DEFECTS_AND_LIMITATIONS.md) | Defects found and fixed, pre-existing failures, known limitations |
| [STAGE_2_DESIGN.md](STAGE_2_DESIGN.md) | Payables, bank-to-ledger, posted-line corrections |
| [STAGE_3_DESIGN.md](STAGE_3_DESIGN.md) | Sales invoices, receivables, advances, receipts, AR reports; status and limitations |
| [STAGE_4_DESIGN.md](STAGE_4_DESIGN.md) | Inventory valuation, production costing and loss, COGS, D-1 settings; limitations |
| [DECISION_PACK.md](DECISION_PACK.md) | Decisions the accountant must take (D-1 costing, D-2 advances VAT, cash-flow classes, cutover) |
| [RECOVERY_BUNDLE.md](RECOVERY_BUNDLE.md) | How to restore the unpushed branch from the incremental bundle (needs `fc64c05`) |
| [RELEASE_PROPOSAL.md](RELEASE_PROPOSAL.md) | What would be released, gates, approvals needed, recovery plan |

Evidence: `evidence/app/` (running application, synthetic fixture), `evidence/figma/` (Figma frames),
`evidence/side/` (Figma | app side by side, Stage 2 corrections, Stage 3 and Stage 4), `evidence/test-runs/`.
