# End-to-end suites

There is no test framework in this project, so these run under plain `node` against a live
dev server and a real database. They talk HTTP for the behaviour under test and SQL for
fixtures and assertions, which keeps them honest: nothing is mocked, and a passing run
means the actual route handlers, the actual transactions, and the actual DB constraints all
did the right thing.

## Running them

```bash
# 1. Point DATABASE_URL at a DISPOSABLE database and apply migrations
npx prisma migrate deploy
npm run seed

# 2. Start the dev server (they talk to http://127.0.0.1:3000)
npm run dev

# 3. In another shell
npm run e2e          # shelf-flow + race
npm run e2e:shelf
npm run e2e:race
npm run e2e:reset    # DESTRUCTIVE — wipes operational data, see below
```

`BASE_URL` overrides the server address. `PSQL_BIN` overrides the path to `psql.exe`.

## The suites

| File | What it proves |
|---|---|
| `shelf-flow.mjs` | The shelf-first rule end to end: an order draws on free shelf stock before anything is roasted, a false "Available on Shelf" claim is refused, production is capped by the shortfall rather than the full order, a roast always consumes green stock, outstanding demand stays distinct from produced-not-delivered, items with no product still pool via their green bean, and the finished-goods ledger reconciles to the shelf balance. |
| `race.mjs` | The reservation guard under real concurrency: six orders of 10kg fired simultaneously at a 10kg shelf. Exactly one wins, `reservedQty` never exceeds `availableQty`, and the `StockAllocation` rows reconcile with the lot. A read-then-write implementation passes the sequential suite and fails this one. |
| `reset.mjs` | Admin reset still works now that `StockAllocation.finishedGoodsLotId` is `ON DELETE RESTRICT`. **Destructive** — it deletes operational data, so it refuses to run unless the database name contains `test`, `dev`, or `demo`, and it should be run last. |

Each assertion is written as the *correct* behaviour rather than the current one, so the
same file documents a defect while it is open and guards it once it is closed.

## Fixtures

Every suite tags the rows it creates (`E2E-SHELF`, `E2E-RACE`, `E2E-RESET`) and cleans them
up on the next run, so repeated runs are idempotent and they do not disturb seeded data.
The ledger reconciliation is scoped to lots the suite produced through the real packaging
route — fixtures inserted straight into the table by another suite have no ledger rows by
design and would otherwise read as a phantom imbalance.
