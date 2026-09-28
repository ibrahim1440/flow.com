# Stage 4b — requirement → evidence

Repository [https://github.com/ibrahim1440/flow.com](https://github.com/ibrahim1440/flow.com),
branch `feature/accounting-ledger-core` (**unpushed**). Test counts and the commit they ran on are in
[`TEST_RESULTS.md`](TEST_RESULTS.md). These are local results on synthetic data, produced and
reported by the implementer; they are not an independent certification, and nothing here is
accepted.

Categories:
- **V** — implemented and verified locally (a named test exercises it and passed);
- **I** — implemented but not verified (code exists; no test or capture exercises it yet);
- **X** — incomplete;
- **D** — awaiting an accounting decision;
- **C** — blocked only by cloud access.

| # | Requirement (review item) | Cat. | Evidence / what is missing |
|---|---|---|---|
| 1.1 | Explicit, idempotent integration: receipts (purchases) | V | `ops-integration.test.ts` (event → RECEIPT, one document per event); `ops-integration.test.mjs` through `POST /api/purchases` |
| 1.2 | … roasting | V | both tests; HTTP through `POST /api/roasting-batches` incl. conversion-cost absorption |
| 1.3 | … roast cancellation (restock / write-off / not yet in the accounts) | V | `ops-integration.test.ts` (restock at original cost; cancelled before posting → dismissed); HTTP `DELETE /api/roasting-batches/[id]?restock=true` |
| 1.4 | … blending | V (event → document) / I (route) | `ops-integration.test.ts` test 3 (two source batches → blend at 176.47); `POST /api/roasting-batches/blend` is instrumented but not driven over HTTP |
| 1.5 | … packaging (standard, partial, top-up) | V | `ops-integration.test.ts` (standard + partial + top-up by hand); HTTP through `POST /api/roasting-batches/[id]/pack` (standard) |
| 1.6 | … transfers between accounting locations | V (stage 4 documents) / X (operational) | the operational system has no locations; dispatch is the only operational transfer (to DLV) |
| 1.7 | … dispatch | V | both tests; HTTP through `POST /api/deliveries`, then the invoice built from the order takes the dispatched cost |
| 1.8 | … customer returns | V | `CustomerReturn` workflow (§3); the operational system has no return screen, so returns are recorded in accounting with warehouse evidence |
| 1.9 | … counts / adjustments | V | `ops-integration.test.ts`; HTTP `POST /api/inventory/adjust`; `PATCH /api/materials/[id]` instrumented, not driven by a test (I) |
| 1.10 | Authoritative quantity per workflow defined | V | `STAGE_4B_DESIGN.md` §1 table |
| 1.11 | Approvals preserved | V | held document approved by someone else (`ops-integration.test.ts` test 1: the recorder cannot approve); loss above band held |
| 1.12 | Pending / failed effects exposed | V (API) / I (screens) | status endpoint asserted over HTTP; chips on purchases, roasting, packing, dispatch screens and the exception queue are built and type-checked, see TEST_RESULTS for captures |
| 1.13 | Unknown stock writers detected | V | `ops-integration.test.ts` (UNINTEGRATED; writers with an event are not flagged) |
| 1.14 | Reconciliation detects exceptions without re-entry | V | `ops-integration.test.ts` (MATCHED and EXCEPTION rows) |
| 1.15 | Flow proven through the existing operational screens | V (their API routes) / see TEST_RESULTS (browser) | `ops-integration.test.mjs` uses the same routes the screens call, as an operations user |
| 2.1 | Durable costing, retries, visible exception queue, explicit status | V | `stage4b-workflows.test.ts` B, `stage4-gaps.test.ts`; queue page built |
| 2.2 | No silent skipping; non-stock lines explicit | V | `stage4-gaps.test.ts` |
| 2.3 | Actual fulfilment location; unit conversion | V | `stage4b-workflows.test.ts` A (carton of 12 l at the café) |
| 2.4 | Failures, crashes, retries, missing mappings, insufficient stock, period closure | V | `stage4b-workflows.test.ts` B; `ops-integration.test.ts` robustness |
| 2.5 | Recovery when later movements prevent back-dating | V | late booking with original date kept; margin BOOKED_LATER |
| 2.6 | Revenue/COGS timing subject to approved policy | D | `salesCostTiming` undecided by default (AWAITING_POLICY); DECISION_PACK §4 |
| 3.1 | Correction / reissue without stock movement | V | `stage4b-workflows.test.ts` A (INV-B reversed, INV-C reissued) |
| 3.2 | Confirmed physical return with evidence and approvals | V | A (R-A: received with evidence, approver ≠ recorder/receiver) |
| 3.3 | Cancellation before fulfilment | V | B (undispatched order line → CANCELLED) |
| 3.4 | Partial return | V | A (4 of 10) and the chain test (5 of 100) |
| 3.5 | Refund / price credit without goods | V | A (CN-P) |
| 3.6 | No duplicated restoration | V | A (a second return above what is out is refused); unique credit per return |
| 4.1 | Margin includes all revenue and credit-note effects | V | `stage4-gaps.test.ts`, A |
| 4.2 | Missing / pending costs explicit | V | `stage4-gaps.test.ts` (incomplete flag and rows) |
| 4.3 | Reconciles to revenue, returns and COGS accounts, differences explained | V | `stage4-gaps.test.ts` reconciliation; chain test (`difference = 0.00`) |
| 5.1 | Configurable labour and overhead, approved bases, normal capacity | V (mechanism) / D (rates) | `stage4b-workflows.test.ts` C; rates are synthetic (DECISION_PACK §4b) |
| 5.2 | No double counting | V | contra accounts 6190/6790; C (under-absorption stays in expense) |
| 5.3 | Later price differences and landed costs traced to RM, WIP, FG and sold goods | V | chain test (landed cost and price difference into roasted coffee and abnormal loss), `stage4-gaps.test.ts`, D (price credit to stock, training and returned goods) |
| 5.4 | Synthetic rates and bands separate from approved policy | V | `-SYN` codes; DECISION_PACK assumptions list |
| 6.1 | Supplier credit notes; settlement of supplier-return balances | V | D; fixture credit note settles the fixture's return |
| 6.2 | Credit applied to bills | V | D (CN1 applied to B1) |
| 6.3 | ACC-47 loss, cost and journal information | see FIGMA_PARITY | depends on the capture run recorded in TEST_RESULTS |
| 6.4 | Regression tests written before fixes | V (stage 4 gaps, 4b workflows) / X (operational integration: written with the code) | `evidence/test-runs/*-before-fix.txt` |
| 6.5 | Hand-worked multi-period examples | V | chain (Jan–Mar + today), A (Feb, Mar, today) |
| 6.6 | Release gates | X | a release package is not proposed; migration rehearsal on a production copy is required first (MIGRATION_AND_CUTOVER) |
| 7.1 | Figma frames for the new screens | C / X | see FIGMA_PARITY |
| 7.2 | Preview deployment, Neon rehearsal | C | GitHub App not installed on flow.com (push 403); Vercel team scope; no Neon access from this sandbox |
| 7.3 | Credential rotation | D (owner) | CREDENTIAL_INCIDENT.md; not performed, not claimed |
