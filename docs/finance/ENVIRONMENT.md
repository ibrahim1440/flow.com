# Finance work — environments, database safety and the local PostgreSQL

Nothing in this branch's work connected to, migrated, seeded or tested against any Neon
endpoint. Every database write went to a portable PostgreSQL on `127.0.0.1:54329`.

## 1. Conflicting classifications of the shared Neon endpoints (unresolved)

The repository and its branches disagree about what `ep-dawn-dust-aqn1u1uf` is. This document
records the disagreement; it does not resolve it, and the main checkout's `CLAUDE.md` was not
modified.

| Source | `ep-dawn-dust-aqn1u1uf` | Production is | Notes |
|---|---|---|---|
| `C:\Projects\ERP\CLAUDE.md` (main checkout, contains the owner's uncommitted edits) | **demo** — "the `.env` file should only ever contain the demo endpoint" | `ep-icy-field-aq4upc3z` | |
| `prisma/seed.ts` on `origin/main` (`PROTECTED_ENDPOINTS`) | **"Demo / training — never from this path"** | `ep-jolly-feather-aqne6cp1` ("production-primary") | Says it was verified against the Neon control plane on 2026-09-16 and that `ep-icy-field-aq4upc3z` "exists in no project of this organization" |
| `docs/sales/DATABASE_ISOLATION.md` on `feature/sales-crm-commissions` (read-only) | **"Production is `ep-dawn-dust-aqn1u1uf` on branch `br-weathered-bread-aqais7hp`, which is what serves www.beanflow.net"** | same, plus root branch `production` = `ep-jolly-feather-aqne6cp1` is "a different compute again" | Also repeats that `ep-icy-field` exists nowhere |
| `C:\Projects\ERP\.env` (main checkout; host read only, never connected) | `DATABASE_URL` points here | — | |

**Treatment in this work:** `ep-dawn-dust-aqn1u1uf`, `ep-jolly-feather-aqne6cp1`,
`ep-icy-field-aq4upc3z` and `ep-wandering-leaf-aqjtuin5` are all treated as potentially
production. They are hard-coded as refused in `scripts/finance/local-db-guard.mjs`
(`SHARED_ENDPOINTS`) in addition to the positive allowlist below. **Decision needed from the
owner:** which endpoint serves www.beanflow.net, and whether `CLAUDE.md` should be corrected —
the main checkout's `.env` currently points at the endpoint one source calls production.

## 2. Executable safeguards (not just `NODE_ENV`)

`scripts/finance/local-db-guard.mjs` is used by the fixture (`finance:fixture`, including
`--reset`, which truncates) and by the DB integration suites. A target is accepted only if
**all** hold; otherwise the process exits before any connection is made:

1. host is loopback (`127.0.0.1`, `localhost`, `::1`) — never a hosted name;
2. port is the portable server's `54329`;
3. the URL contains no shared endpoint id and no hosted-provider name (`neon.tech`, …);
4. the database is on the finance allowlist (`erp_finance_dev`, `erp_finance_test`) and is the
   one the calling script expects;
5. `FIN_DISPOSABLE_DB` in the environment equals that database name (explicit opt-in per file:
   `.env` → `erp_finance_dev`, `.env.test` → `erp_finance_test`);
6. after connecting, before any write: `current_database()` matches and the database carries
   the server-side marker `COMMENT ON DATABASE … IS 'hiqbah-finance-disposable'` (set only by
   `local-postgres.mjs setup`).

Live refusals (2026-09-26; credentials masked; exit code 1 in every case, no connection made):

```
target ***@ep-dawn-dust-aqn1u1uf-pooler.…neon.tech/neondb, FIN_DISPOSABLE_DB=erp_finance_dev
  Refusing: host is not the local loopback server; port is not the portable server's 54329;
  URL names a shared/hosted database; database is not one of the disposable finance databases;
  database is not the expected erp_finance_dev.
target ***@127.0.0.1:54329/erp_e2e, FIN_DISPOSABLE_DB=erp_e2e
  Refusing: database is not one of the disposable finance databases; … not the expected erp_finance_dev; FIN_DISPOSABLE_DB is not set to erp_finance_dev.
target ***@127.0.0.1:54329/erp_finance_dev, FIN_DISPOSABLE_DB unset
  Refusing: FIN_DISPOSABLE_DB is not set to erp_finance_dev.
target ***@127.0.0.1:5432/erp_finance_dev, FIN_DISPOSABLE_DB=erp_finance_dev
  Refusing: port is not the portable server's 54329.
```

The marker check is covered by `tests/finance/unit/db-guard.test.ts` (a loopback database
without the marker is refused).

## 3. Effective connection settings (masked)

`node scripts/finance/check-env.mjs` prints every connection variable without secrets and, for
local targets only, opens a read-only session to confirm what it actually reached:

```
.env      DATABASE_URL  host=127.0.0.1 port=54329 database=erp_finance_dev  user=f…(13) password=present  class=LOCAL DISPOSABLE  connected: db=erp_finance_dev pg=17.10 marker=ok
.env      DIRECT_URL    (same)                                                                                          connected: db=erp_finance_dev pg=17.10 marker=ok
.env.test DATABASE_URL  host=127.0.0.1 port=54329 database=erp_finance_test user=f…(13) password=present  class=LOCAL DISPOSABLE  connected: db=erp_finance_test pg=17.10 marker=ok
.env.test DIRECT_URL    (same)                                                                                          connected: db=erp_finance_test pg=17.10 marker=ok
../ERP/.env DATABASE_URL host=ep-dawn-dust-aqn1u1uf-pooler.…  class=SHARED NEON — POTENTIALLY PRODUCTION  not connected
```

There is no `SHADOW_DATABASE_URL`; `prisma migrate deploy` does not use a shadow database.
`prisma.config.ts` reads `DATABASE_URL`/`DIRECT_URL` from the environment only.

## 4. Portable PostgreSQL — source, version, repeatable setup

| | |
|---|---|
| Package | `@embedded-postgres/windows-x64@17.10.0-beta.17` (npm; project `github.com/leinelissen/embedded-postgres`, MIT) |
| Server | PostgreSQL **17.10**, Windows x64 binaries shipped in the package |
| Integrity (npm lock) | `sha512-q6xIETTkv67i1QlTWz1LAKb3Z+vG2V3qrp+BjLEWhCQ9jE4hbbsQ/J/3wiOPFLJbuwak7CfHC9EUJG7txAbGKw==` |
| Pinned in | `scripts/finance/local-postgres.package.json` + `local-postgres.lock.json` (installed into `.local-postgres/`, gitignored — binaries and data are never committed) |
| Listen | `127.0.0.1:54329` only; UTF-8, locale `C` |
| Databases | `erp_finance_dev` (manual testing / fixture), `erp_finance_test` (integration suites) — both marked |
| Roles | superuser `finance_local` (migrations, fixture reset) · `finance_app` (DML only: no TRUNCATE/TRIGGER/REFERENCES, owns nothing, cannot disable triggers) |
| Secrets | `FIN_LOCAL_PG_SUPERUSER_PASSWORD`, `FIN_LOCAL_PG_APP_PASSWORD` in the worktree's gitignored `.env` |

The distribution has no `psql`; the scripts use the `pg` client already in the project.

```bash
# one-time: install the pinned binaries, initdb, create + mark both databases
node scripts/finance/local-postgres.mjs setup
# migrate both databases (each .env file points at its own database)
set -a; . ./.env; set +a; node scripts/migrate-deploy.mjs
set -a; . ./.env.test; set +a; node scripts/migrate-deploy.mjs
# least-privilege runtime role (re-run after migrations add tables)
node scripts/finance/local-postgres.mjs grant-app
# realistic local fixture (refuses anything but erp_finance_dev)
npm run finance:fixture -- --reset
```

```bash
npm run db:local          # start (detached; survives the shell)
npm run db:local:status   # pg_ctl status + the postgres command line
npm run db:local:stop     # fast shutdown
```

Restart = `db:local:stop` then `db:local`. Verified 2026-09-26: stop → status "no server
running" → start → both databases reachable, markers intact, data preserved.

To remove everything: stop the server, then delete `.local-postgres/` in this worktree.

## 5. Other disposable database used for verification

`erp_e2e` on the same local server (marker `hiqbah-regression-disposable`) was created only to
run the repository's existing backend regression suites, which have their own guard
(`ERP_TEST_DATABASE_URL` + name allowlist, never `DATABASE_URL`). It held seed data generated
with random PINs kept in the session scratchpad, and was dropped after the run.

## 6. What production needs that this environment does not prove

- The DB triggers constrain every role that is not the table owner or a superuser. Locally the
  migrations run as the superuser `finance_local` and the app role is `finance_app`. In
  production the application must also connect as a role that does **not** own the tables
  (Neon's default `neondb_owner` does); otherwise `ALTER TABLE … DISABLE TRIGGER` is available
  to the application and the append-only guarantees become conventions.
- Backups/PITR before `migrate deploy`, and a dry run on a Neon branch copy first.
