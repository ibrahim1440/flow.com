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

## Pre-existing (reproduced identically on `main` @ `fc64c05`; not fixed here)
- `h2a-hardening`: "no roast lost its provenance" counts roasts without a bean created in the last
  20 minutes across the whole DB → 44 on a freshly seeded DB (the seed itself creates such rows).
- `harness-selftest`: two checks expect an unconfigured environment; a local `.env` satisfies it.
- `reset-safety`: 8 checks need the reset-authorisation variable on the test server.

## Limitations (known, not defects)
- Only the ledger core and commission posting exist; AP/AR/inventory valuation/manufacturing/bank→GL/
  assets/ZATCA are not implemented (see `REQUIREMENTS_MATRIX.md`).
- Local tests use PostgreSQL 16; production is 17 (the rehearsal ran on 17).
- `scripts/accounting/seed-local-fixture.ts` takes ~5 min in this sandbox (waiting, not CPU); cause not investigated.
- Period "locked by" shows no name in the app; GL shows one view at a time.
