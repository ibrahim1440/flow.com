# Accounting module — handover index

Status on branch `feature/accounting-ledger-core` (based on `main` @ `fc64c05`, verified the latest
through the GitHub API on 2026-09-27). **Increment 1 of the brief: the general ledger core.** This is
not the complete accounting system the brief describes; `REQUIREMENTS_MATRIX.md` says exactly what
exists, what is partial and what is missing.

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
| [RELEASE_PROPOSAL.md](RELEASE_PROPOSAL.md) | What would be released, gates, approvals needed, recovery plan |

Evidence: `evidence/app/` (running application, synthetic fixture), `evidence/figma/` (Figma frames).
