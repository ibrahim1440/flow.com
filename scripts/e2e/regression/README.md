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

## The Sales CRM suites are a SEPARATE runner, against a different database

```
npm run regression:sales                      # all five
npm run regression:sales -- commission-engine # one at a time
```

Separate on purpose, not by oversight. The five sales suites refuse to touch any database
except the verified preview one (`sales_crm_preview`), and `npm run regression` above runs
against the regression database — so registering them in one list would give whichever
runner you invoked a guaranteed refusal. Two runners, two targets, one explicit boundary.

| Suite | Needs |
|---|---|
| `commission-engine` | nothing — pure arithmetic, no database, no HTTP |
| `quotes-domain` | nothing — pricing, lifecycle and CSV, no database, no HTTP |
| `sales-commissions-db` | PostgreSQL |
| `sales-security` | a running app |
| `sales-workflow` | a running app |

The two pure suites need `npm run build:test-domain` first — they import the compiled
domain so the test exercises exactly what ships, rather than a second copy of the
arithmetic.

The browser UAT for the same module is `npm run uat:sales`.

## What they need

These suites create, mutate and delete data. They will not start until you nominate a
throwaway database explicitly:

| Variable | Meaning |
| --- | --- |
| `ERP_TEST_DATABASE_URL` | Connection string for a **disposable** database. |
| `ERP_TEST_BASE_URL` | The running application under test, e.g. `http://localhost:3010`. |
| `ERP_TEST_ADMIN_PIN` | The seeded administrator PIN for that database. Six digits. |
| `PIN_LOOKUP_SECRET` | **The same value the application under test is running with.** |
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

PIN login finds its employee by an HMAC of the candidate (the keyed *selector*), keyed by
`PIN_LOOKUP_SECRET`, then proves it by bcrypt over a second keyed HMAC of the candidate (the
*verifier input*) — never over the raw PIN. `Employee.pin` holds `bcrypt(pinVerifierInput(pin))`,
so a stolen row cannot be attacked offline without the secret and the raw PIN never verifies
directly. The suites both seed employees and log in as them, so they must produce the same
selector and the same verifier input the server does — which means running with the server’s
own secret. A different value is not a failing test but a suite that cannot log in at all, so
it is refused up front with the other rails rather than discovered as twenty red suites. It is
never defaulted.

Because both derivations are keyed, **an employee row created before the cutover cannot log
in.** The harness reissues exactly one such account — the administrator whose PIN the
environment supplies in plaintext — into the Version B shape, and every fixture employee is
created with the two live credential columns written together (`pin` = the bcrypt verifier,
`pinLookup` = the keyed selector). The legacy `pinHash` column is inert: written by no path
and read by no path, it waits for migration #19. A test database restored from before
migration #18 therefore needs nothing done to it by hand.

## Setting up a test database

```
createdb erp_test                       # or a Neon/Postgres branch of your choosing
export ERP_TEST_DATABASE_URL=...        # pointing at it
DATABASE_URL=$ERP_TEST_DATABASE_URL npx prisma migrate deploy
DATABASE_URL=$ERP_TEST_DATABASE_URL npx tsx prisma/seed.ts
export PIN_LOOKUP_SECRET=$(openssl rand -base64 32)   # the server and the suites share this
DATABASE_URL=$ERP_TEST_DATABASE_URL npm run build && npx next start -p 3010
export ERP_TEST_BASE_URL=http://localhost:3010
export ERP_TEST_ADMIN_PIN=...           # the six-digit PIN the seed created
npm run regression
```

The suites are run against a production build rather than the dev server, because that is
what certification measures.

## The suites

| Suite | Covers |
| --- | --- |
| `harness-selftest` | That this harness is capable of failing — see below. **Pure: no database, no server.** |
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
| `h2b-hardening` | Dispatch idempotency, PIN credentials and cutover, PIN-space throttling |

Every suite except `harness-selftest` drives the running application over HTTP, tears down
only the fixtures it created — keyed by its own tag — and asserts a set of global inventory
invariants before it exits. Each exits non-zero on failure.

## Can this harness fail?

`harness-selftest` is the odd one out: it touches no database and no server, and asserts
nothing about the ERP. It exists because a green harness proves nothing by itself.

Two defects made that concrete. `delivery.mjs` read its fixture through `fs` while binding
the import as `fsx`, so it threw at module evaluation and never ran one of its 22
assertions — and the runner scored the corpse `0 passed, 0 failed`, which looked exactly
like a healthy suite with nothing to say. Separately, `skuUnits()` returned no `free` key
while four committed assertions read `.free`, so every one of them compared against
`undefined` — and `undefined` answers *false in both directions*. The oversell detector
next to them (`if (gained > free0) issue("BLOCKER", ...)`) could not fire under any
circumstances. The certification run reported ALL SUITES GREEN throughout.

So `harness-selftest` proves, on every run and with nothing installed:

- the oversell detector **fires** on a deliberately invalid reservation state, and stays
  **silent** on a valid one (`oversell.mjs`);
- a missing or NaN balance now **raises** instead of quietly comparing false;
- the runner **rejects** a suite that exited non-zero, printed no summary, asserted
  nothing, or reported failures and then exited 0 (`suite-verdict.mjs`).

Both modules are pure and import nothing. They are the same modules `harness.mjs`,
`order-to-delivery.mjs` and `run-all.mjs` actually use — testing a private copy would have
proved only that the copy worked.

They run **serially** — see the comment in `run-all.mjs`. They share one database and one
stock pool, and several assert on global invariants, so running two at once makes those
assertions read another suite's data.

## Not included here

Browser tests live in `tests/e2e` and run under Playwright (`npm run uat`). Performance
profiling, load checks and one-off diagnostic probes are deliberately excluded: they are
measurement tools, not pass/fail regressions, and their thresholds are specific to the
machine and network they were measured on.
