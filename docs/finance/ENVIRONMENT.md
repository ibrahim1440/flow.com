# Finance work — environments, database safety and the local PostgreSQL

Nothing in this branch's work connected to, migrated, seeded or tested against any Neon
endpoint. Every database write went to a portable PostgreSQL on `127.0.0.1:54329`.

## 1. Which database serves www.beanflow.net — identified from indirect evidence (2026-09-26)

**Conclusion: treat `ep-dawn-dust-aqn1u1uf` as the live production database** (it already was
treated that way; every finance guard refuses it and every other shared endpoint). Its Neon
branch is named `hiqbah-demo-training-20260529` and two repository sources call it "demo".

**Limitation — the deployed connection configuration was not inspected directly.** The
production `DATABASE_URL` in Vercel is a *sensitive* variable: the API never returns its value,
so the host and database it names could not be read. The conclusion rests on the independent,
indirect evidence below; the owner can confirm it directly in the Vercel dashboard (or by
reading the variable's host with the project owner's access). No further production traffic
will be generated and no production data was accessed.

| Kind | Evidence | Weight |
|---|---|---|
| Independent | The production deployment (`flow-com`, `dpl_6Aa8nwC1xyyB3nmtrYCffCSKM4Cq`) has a single production `DATABASE_URL` (sensitive, last edited 2026-09-09 06:07 UTC) and no production `DIRECT_URL` | shows there is exactly one production database setting; does not show which host |
| Independent | Neon activity metadata: `ep-jolly-feather-aqne6cp1` (branch literally named `production`) suspended since 2026-09-17 11:56 UTC with 86 KB transferred in its lifetime, while the site kept serving; `ep-dawn-dust-aqn1u1uf` active until 2026-09-25 23:42 UTC with ~400 MB transferred | the branch named "production" is not what the live site uses |
| Independent | Every `pre-go-live` / `pre-cutover` / `pre-migration` backup branch since 2026-09-17 was cut from `ep-dawn-dust`'s branch (`br-weathered-bread-aqais7hp`) | the go-live migrations were applied to that branch |
| Independent | `docs/sales/DATABASE_ISOLATION.md` on the sales branch states it serves www.beanflow.net | a written claim by another workstream |
| **Corroborating (not direct)** | One `GET /api/health` (the public uptime check: bounded `SELECT 1`, no writes) at 10:45:00 UTC was followed by `ep-dawn-dust`'s compute starting at 10:45:03 UTC while `ep-jolly-feather` stayed suspended | a timing correlation, not an inspection of the configuration; another client could in principle have woken that compute in the same seconds. Not repeated |

Details of each observation:

| # | Evidence | Source | Result |
|---|---|---|---|
| 1 | Public response headers of `https://www.beanflow.net` | `curl -I` | `Server: Vercel`, `X-Powered-By: Next.js`, function region `iad1`; DNS `www.beanflow.net` → `vercel-dns-017.com` |
| 2 | Vercel project owning the domain | Vercel API (existing authorisation), `get_project` | project **`flow-com`** (`prj_bBAuuOg4luOQYmkTls2nnQoAP6dG`), account scope `ibrahimmutambak-4927s-projects` (`team_z7AUzCwCyqrP3upYSGHOuX7q`); domains `www.beanflow.net`, `beanflow.net`, `flow-com-delta.vercel.app`, … |
| 3 | Current production deployment | `list_deployments target=production state=READY` | **`dpl_6Aa8nwC1xyyB3nmtrYCffCSKM4Cq`**, created 2026-09-19 05:56 UTC from `main` @ **`4640cbe`** (the base of this branch), repo `ibrahim1440/flow.com` |
| 4 | Database variables of that environment (names and metadata only, never decrypted) | `filter_project_envs decrypt=false` | Production: `DATABASE_URL` (id `utHcUVSmtDnNhptT`, type **sensitive** — Vercel never returns the value, so the host cannot be read from Vercel; last edited 2026-09-09 06:07 UTC), `JWT_SECRET`, `PIN_LOOKUP_SECRET`; **no production `DIRECT_URL`**. Preview-only, branch-scoped copies exist for `feature/sales-crm-commissions`, `release/rc-order-operations-20260906`, `-20260908` and `release/pre-go-live-20260904` |
| 5 | Neon project, branches and computes | Neon control-plane API (metadata only; `describe_branch`, which queries the database, was not used) | Project **`hiqbah`** (`dark-lab-61530722`, `aws-us-east-1`). Branch **`production`** (`br-fragrant-poetry-aqd0ndyx`, endpoint `ep-jolly-feather-aqne6cp1` "production-primary"): suspended since **2026-09-17 11:56 UTC**, 86 KB transferred in its lifetime. Branch `hiqbah-demo-training-20260529` (`br-weathered-bread-aqais7hp`, endpoint `ep-dawn-dust-aqn1u1uf`): last active 2026-09-25 23:42 UTC, ~400 MB transferred; every `pre-go-live` / `pre-cutover` / `pre-migration` backup branch since 2026-09-17 was cut **from this branch** |
| 6 | Which compute the live site wakes | one `GET https://www.beanflow.net/api/health` at 10:45:00 UTC (the public, unauthenticated uptime endpoint on `main`: bounded `SELECT 1`, no writes, returns only up/down) → HTTP 200 in 2.74 s (cold start; the route documents ~167 ms warm) | `ep-dawn-dust-aqn1u1uf` compute started at 10:45:03 UTC; `ep-jolly-feather-aqne6cp1` stayed suspended — **corroborating only** (see above) |

Non-secret identifiers of the live database: Neon project `dark-lab-61530722` (`hiqbah`),
branch `br-weathered-bread-aqais7hp`, endpoint `ep-dawn-dust-aqn1u1uf`, hosts
`ep-dawn-dust-aqn1u1uf.c-8.us-east-1.aws.neon.tech` / `…-pooler.c-8.us-east-1.aws.neon.tech`.
Which of the two hosts the sensitive variable uses, and the database name inside it, cannot be
read without decrypting the value; the owner can confirm both in the Vercel dashboard.

Consequences the owner should act on (nothing was changed by this work):

| Source | Says | Now known |
|---|---|---|
| `C:\Projects\ERP\CLAUDE.md` (owner's uncommitted edits) | `ep-dawn-dust` = demo; production = `ep-icy-field-aq4upc3z`; ".env should only ever contain the demo endpoint" | **Wrong on both.** `ep-icy-field` exists in no Neon project of this organisation. The main checkout's `.env` therefore points at production. |
| `prisma/seed.ts` on `origin/main` | `ep-dawn-dust` = "Demo / training", `ep-jolly-feather` = production | Both are refused by the seed guard, so it is safe, but the labels are inverted in practice |
| `docs/sales/DATABASE_ISOLATION.md` (sales branch) | `ep-dawn-dust` serves www.beanflow.net | **Correct** |
| Neon branch `erp-regression-r1` (`ep-wandering-leaf-aqjtuin5`) | a regression target | A **child of the production branch** (production-derived data) and active today — treat as sensitive |

Guards: `scripts/finance/local-db-guard.mjs` keeps `ep-dawn-dust-aqn1u1uf`,
`ep-jolly-feather-aqne6cp1`, `ep-icy-field-aq4upc3z` and `ep-wandering-leaf-aqjtuin5` in
`SHARED_ENDPOINTS`, in addition to the positive loopback-only allowlist.

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
../ERP/.env DATABASE_URL host=ep-dawn-dust-aqn1u1uf-pooler.…  class=LIVE PRODUCTION — serves www.beanflow.net (verified 2026-09-26; never use)  not connected
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

## 5. Other disposable databases used for verification

All on the same local server, all loopback-only:

| Database | Marker | Used for | State |
|---|---|---|---|
| `erp_e2e`, `erp_mvp_test` | `hiqbah-regression-disposable` | the repository's own backend regression and Playwright suites, which have their own guards (`ERP_TEST_DATABASE_URL` / exact-name allowlists, never the developer `.env`); seeded with random PINs held only in session scratch files | **dropped** after the runs; the scratch env files deleted |
| `erp_finance_integration` | `hiqbah-finance-disposable` | the disposable sales + finance integration branch (SALES_INTEGRATION.md §4); allowed only by that branch's copy of the guard | kept with the trial branch; drop with `DROP DATABASE erp_finance_integration` when the branch is deleted |

## 6. What production needs that this environment does not prove

- The DB triggers constrain every role that is not the table owner or a superuser. Locally the
  migrations run as the superuser `finance_local` and the app role is `finance_app`. In
  production the application must also connect as a role that does **not** own the tables
  (Neon's default `neondb_owner` does); otherwise `ALTER TABLE … DISABLE TRIGGER` is available
  to the application and the append-only guarantees become conventions.
- Backups/PITR before `migrate deploy`, and a dry run on a Neon branch copy first.
