# Backend regression suites

The concurrency and inventory-integrity suites the release certification relies on. They
drive the running application over HTTP as real users would, and read the database only to
verify what the application did.

Run them with:

```
npm run regression
```

or one at a time:

```
npm run regression -- production-gate reservation-cas
```

## What they need

These suites create, mutate and delete data. They will not start until you nominate a
throwaway database explicitly:

| Variable | Meaning |
| --- | --- |
| `ERP_TEST_DATABASE_URL` | Connection string for a **disposable** database. |
| `ERP_TEST_BASE_URL` | The running application under test, e.g. `http://localhost:3010`. |
| `ERP_TEST_ADMIN_PIN` | The seeded administrator PIN for that database. |
| `ERP_TEST_DB_ALLOWLIST` | Optional. Comma-separated database names that may be used. |

They deliberately **do not read `DATABASE_URL`**. On any machine where the application has
been run, that variable points at real data, and a suite that fell back to it would run
destructive tests against production. There is no fall-back path: the variable is never
consulted.

The database name must appear in the allowlist, which defaults to
`erp_mvp_test, erp_test, erp_e2e, erp_demo`. An unrecognised name is refused rather than
allowed, so a database this list has never heard of cannot be touched by accident.

No credential appears in these files. The administrator PIN comes from the environment;
suites that need their own operator generate a random PIN per run and delete the account
afterwards.

## Setting up a test database

```
createdb erp_test                       # or a Neon/Postgres branch of your choosing
export ERP_TEST_DATABASE_URL=...        # pointing at it
DATABASE_URL=$ERP_TEST_DATABASE_URL npx prisma migrate deploy
DATABASE_URL=$ERP_TEST_DATABASE_URL npx tsx prisma/seed.ts
DATABASE_URL=$ERP_TEST_DATABASE_URL npm run build && npx next start -p 3010
export ERP_TEST_BASE_URL=http://localhost:3010
export ERP_TEST_ADMIN_PIN=...           # the PIN the seed created
npm run regression
```

The suites are run against a production build rather than the dev server, because that is
what certification measures.

## The suites

| Suite | Covers |
| --- | --- |
| `production-gate` | Production Entry Gate — production refused unless the order is approved and reviewed |
| `production-concurrency` | The gate under concurrent hold / cancel, both serialization directions |
| `lifecycle-locks` | Canonical lock order `ALLOC → OrderItem → Order`; deadlock freedom |
| `reservation-cas` | Reservation compare-and-swap; no double reservation under concurrent review or delivery |
| `po-lifecycle` | Production Order state machine, batch linking, cancellation, numbering |
| `hardening` | Concurrency, idempotency, forced mid-transaction failure, security smoke |
| `finished-products` | Unit-native finished goods, lots, both packaging paths |
| `delivery` | Dispatch, partial and full |
| `order-to-delivery` | End-to-end, happy and unhappy paths |
| `release-simulation` | A second end-to-end pass on different data |

Each suite tears down only the fixtures it created, keyed by its own tag, and asserts a set
of global inventory invariants before it exits. Each exits non-zero on failure.

They run **serially** — see the comment in `run-all.mjs`. They share one database and one
stock pool, and several assert on global invariants, so running two at once makes those
assertions read another suite's data.

## Not included here

Browser tests live in `tests/e2e` and run under Playwright (`npm run uat`). Performance
profiling, load checks and one-off diagnostic probes are deliberately excluded: they are
measurement tools, not pass/fail regressions, and their thresholds are specific to the
machine and network they were measured on.
