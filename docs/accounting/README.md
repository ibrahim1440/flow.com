# Accounting module — handover index

## Which implementation this is

| | |
|---|---|
| Repository | [https://github.com/ibrahim1440/flow.com](https://github.com/ibrahim1440/flow.com) — **not** `hiqbah_share2`, a sanitised public export that contains none of this work |
| Branch | `feature/accounting-ledger-core`, based on `main` @ `fc64c05` — on GitHub it will be [https://github.com/ibrahim1440/flow.com/tree/feature/accounting-ledger-core](https://github.com/ibrahim1440/flow.com/tree/feature/accounting-ledger-core) once pushed |
| Where it is | **not pushed** (GitHub App not installed on `flow.com`): it exists in the working clone and in the incremental git bundle described in `RECOVERY_BUNDLE.md` |
| Tested commit | the SHA named at the top of `TEST_RESULTS.md`; later commits change documentation only |

Links between these documents are relative paths inside this branch. On GitHub a file is at
`https://github.com/ibrahim1440/flow.com/blob/feature/accounting-ledger-core/<path>` — for example
[docs/accounting/README.md](https://github.com/ibrahim1440/flow.com/blob/feature/accounting-ledger-core/docs/accounting/README.md) —
and these links resolve **only after the branch is pushed**; today it is unpushed. A link through
`hiqbah_share2` does not identify this implementation.

## Status

Implemented and tested **locally on synthetic data**:
- stage 1: ledger core, commissions;
- stage 2: payables, bank-to-ledger, posted-line corrections, transaction-aware cash-flow statement;
- stage 3: sales invoices, credit notes, customer receipts and advances, AR aging and statements;
- stage 4: inventory valuation, manufacturing costing, COGS; D-1 is configurable and posting is
  refused until it is decided;
- stage 4b (`STAGE_4B_DESIGN.md`, evidence in `STAGE_4B_EVIDENCE.md`): operational stock events
  become inventory documents, durable cost of sales with an exception queue, customer returns
  separate from invoice corrections, gross margin reconciled to the ledger, labour and overhead
  absorption, later cost changes traced through production, supplier credit notes.

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
| [STAGE_4B_DESIGN.md](STAGE_4B_DESIGN.md) | Stage 4b: operational integration, durable cost of sales, returns vs corrections, margin reconciliation, conversion cost, tracing, supplier credits |
| [STAGE_4B_EVIDENCE.md](STAGE_4B_EVIDENCE.md) | Stage 4b requirement → evidence matrix in five categories |
| [DECISION_PACK.md](DECISION_PACK.md) | Decisions the accountant must take (D-1 costing, D-2 advances VAT, cash-flow classes, cutover) |
| [RECOVERY_BUNDLE.md](RECOVERY_BUNDLE.md) | How to restore the unpushed branch from the incremental bundle (needs `fc64c05`) |
| [RELEASE_PROPOSAL.md](RELEASE_PROPOSAL.md) | What would be released, gates, approvals needed, recovery plan |

Evidence: `evidence/app/` (running application, synthetic fixture), `evidence/figma/` (Figma frames),
`evidence/side/` (Figma | app side by side, Stage 2 corrections, Stage 3 and Stage 4), `evidence/test-runs/`.
