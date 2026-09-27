# Defects and limitations

## Found and fixed during this work
| # | Defect | Root cause | Fix | Regression test |
|---|---|---|---|---|
| 1 | Reversal left the original entry POSTED (S0) | `reverseJournalEntry` never flipped the original | posting a REVERSAL flips the original to REVERSED; DB allows POSTED→REVERSED only with a posted reversal | reversal test |
| 2 | Reversal posted by one person, no approval (S0) | immediate POSTED insert | reversal is a submitted request, approved by someone else | reversal test |
| 3 | No four-eyes on journals (S0) | none | service + trigger | journal + guard tests |
| 4 | Concurrent approve/post could both succeed (S0) | read-then-write | conditional updates | concurrency test |
| 5 | Account parent could form a cycle (S0 PATCH) | no check | account service | covered by service; UI |
| 6 | English engine text / reasons in the Arabic UI | stored canonical English | display mapping for known phrases/reasons | visual capture |
| 7 | Mobile approval hid amounts | table scrolled inside card | stacked lines under `sm` | visual capture ACC-11 |
| 8 | Negative amounts shown as `600.00-` in RTL | raw decimal string | bracketed negatives | visual capture ACC-09 |
| 9 | Figma cards fixed at 10 px; ACC-04 table clipped | `resize()` fixed sizing; widths > card | hug + corrected widths | re-screenshotted |

| 10 | Reconciliation listed a transfer's receiving leg as not posted | only the paying leg carries the event | the receiving leg counts as posted through its peer | `stage2.test.ts` transfer case; HTTP ACC-TILL = 0.00 |
| 11 | Secondary text on the cash-flow view used a background colour token (`text-muted`, #F3F4F6) | wrong token | `text-muted-foreground` | found in review before commit |

## Pre-existing (reproduced identically on `main` @ `fc64c05`)
All three now have a reproducible passing setup (`scripts/e2e/regression/local-certification.mjs`,
`REGRESSION_SIDE_BY_SIDE.md`); the h2a seed issue was fixed in `prisma/seed.ts`:
- `h2a-hardening`: "no roast lost its provenance" counts roasts without a bean created in the last
  20 minutes across the whole DB → 44 on a freshly seeded DB (the seed itself creates such rows).
- `harness-selftest`: two checks expect an unconfigured environment; a local `.env` satisfies it.
- `reset-safety`: 8 checks need the reset-authorisation variable on the test server.

## Limitations (known, not defects)
- Implemented: the ledger core, commission posting, payables (supplier bills), bank-to-ledger and
  the cash-flow statement. Not implemented: AR/sales invoices, inventory valuation, manufacturing
  costing, fixed assets, year-end close and ZATCA (see `REQUIREMENTS_MATRIX.md`).
- A bank line edited after it has posted is not re-posted; the reconciliation report shows the
  difference (`STAGE_2_DESIGN.md` §7).
- Bill attachments are not implemented.
- Local tests use PostgreSQL 16; production is 17 (the rehearsal ran on 17).
- `scripts/accounting/seed-local-fixture.ts` takes ~5 min in this sandbox (waiting, not CPU); cause not investigated.
- Period "locked by" shows no name in the app; GL shows one view at a time.
