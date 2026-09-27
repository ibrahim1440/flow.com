# Test results

Code under test: branch `feature/accounting-ledger-core` @ **`62cff11`** (docs-only commits follow).
Environment: container Linux, Node 22.22.2, PostgreSQL 16 local disposable server on 127.0.0.1:54329
(production is PostgreSQL 17 on Neon), Chromium 1194 (Playwright). All data synthetic.

| Kind | Command | Result | What it proves / does not |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit` | clean | |
| Lint (changed areas) | `npx eslint src/lib/accounting src/app/api/accounting src/app/dashboard/accounting tests/accounting scripts/accounting` | clean | |
| Production build | `npm run build` | exit 0 | |
| Unit | `npm run test:accounting:unit` | **8/8** | money/rounding, Riyadh dates, guard-message extraction, template integrity, policy coverage |
| DB integration | `npm run test:accounting:db` (erp_finance_integration) | **25/25** | real Postgres, real triggers: journal workflow, DB guards, reversal, periods, concurrency, statements, commission outbox/gate/provisional/replay/order/cutover/return-after-payout |
| Mutation check | guard trigger disabled → rerun | 4 failures, as expected; re-enabled → 25/25 | the guard tests detect a missing guard |
| HTTP (real server) | `node --test tests/accounting/http/authz.test.mjs` | **5/5** | 401 no session, 403 no module / view-only writes, preparer cannot approve, double approval 409, malformed 400 |
| Finance regression | `npm run test:finance:unit` / `test:finance:db` | 52/52, 40/40 | Finance unaffected |
| Backend regression | `node scripts/e2e/regression/run-all.mjs` (erp_e2e, server on :3010) | 26 suites, 2,289 assertions, **11 failed in 3 suites** | **all 11 reproduce identically on untouched `main` @ `fc64c05`** (erp_test, server on :3011): `harness-selftest` 2 (local `.env` present), `reset-safety` 8 (reset authorisation env not set on the test server), `h2a-hardening` 1 (same "44 batches" at baseline) |
| Browser capture | `node tests/accounting/visual/capture.mjs docs/accounting/evidence/app` | 17 screens, no page errors, no horizontal overflow, `dir` rtl/ltr correct | browser-verified rendering, not a behavioural UAT script |
| Visual vs Figma | side-by-side review | see `FIGMA_PARITY.md` | manual review; no pixel-diff tool (PIL unavailable) |
| Migration rehearsal | production copy on Neon | applied; see `MIGRATION_AND_CUTOVER.md` | schema + DB guards on real data shape; not the app on that data |
| Official sandbox (ZATCA) | — | **not run** | nothing to test; not implemented |
| Vercel Preview | — | **blocked** | see `RELEASE_PROPOSAL.md` |

Not claimed: "zero bugs"; production readiness of anything outside the ledger core.
