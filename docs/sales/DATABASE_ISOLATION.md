# Where the preview database is, what its credentials can reach, and how that was proven

Every fact here was read back from provider metadata, from the PostgreSQL catalogue, or from
a behavioural probe. No production database was connected to. No credential, connection
string or secret appears anywhere in this file.

---

## 1. Identity

| | |
|---|---|
| Provider | Neon, PostgreSQL 17 |
| Project | `hiqbah` — `dark-lab-61530722` |
| Branch | `erp-regression-r1` — `br-bold-forest-aq3z2qjq` |
| Endpoint | `ep-wandering-leaf-aqjtuin5` (`…c-8.us-east-1.aws.neon.tech`), read-write, `aws-us-east-1` |
| **Database** | **`sales_preview`**, created 2026-09-24, owned by `neondb_owner` |
| **Runtime role** | **`sales_preview_app`** — the application, locally and hosted |
| **Migration role** | **`sales_preview_migrator`** — `prisma migrate deploy`, and nothing else |
| Migrations | 21 applied cleanly; `prisma migrate status` reports "Database schema is up to date!" |

A previous revision of this document described a different database, `sales_crm_preview`,
reachable only as `neondb_owner`. That database still exists and is untouched; it was
replaced rather than retrofitted, because the fix was a new role model and a role cannot be
retrofitted onto tables somebody else already owns. §5 shows the new runtime role cannot read
it either.

**It is not production.** Production is `ep-dawn-dust-aqn1u1uf` on branch
`br-weathered-bread-aqais7hp`, which is what serves www.beanflow.net; the root branch named
`production` (`br-fragrant-poetry-aqd0ndyx`, endpoint `ep-jolly-feather-aqne6cp1`) is a
different compute again. `sales_preview` is on neither.

**But the branch it sits on is a child of production.** `erp-regression-r1` was branched from
`br-weathered-bread-aqais7hp` at LSN `0/1641CDE8`, 2026-09-11. Neon branches are
copy-on-write, so writes here can never reach the parent — but the branch does carry a
September copy of production data in its *other* database, `neondb`. That single fact is what
the whole of §3–§5 exists to deal with.

---

## 2. Two credentials, and where each one lives

|  | runtime — `sales_preview_app` | migration — `sales_preview_migrator` |
|---|---|---|
| Created by | plain SQL `CREATE ROLE` (see §3) | plain SQL `CREATE ROLE` |
| Used by | the Next.js application, local and hosted | `prisma migrate deploy`, run deliberately by a person |
| May change the schema | no | yes, in schema `public` of `sales_preview` only |
| Set on the Vercel project | yes — branch-scoped `DATABASE_URL` **and** `DIRECT_URL` | **no** |
| Local file | `.env.preview-app` | `.env.preview-migrate` |
| Guard | `withpreview.mjs` — refuses to run `prisma` at all | `withmigrate.mjs` — runs `prisma` and nothing else |

**The migration credential is not on the Vercel project, and could not have been put there by
accident.** The script that publishes these variables refuses outright any value containing
`neondb_owner`, `sales_preview_migrator` or `cloud_admin`, whatever its source file says, and
exits non-zero rather than publishing it.

**Why `DIRECT_URL` is set at all, given Prisma treats it as the migration connection.** This
project has a *branch-agnostic* Preview `DIRECT_URL` — one that applies to every preview
branch that does not override it, and whose value cannot be read back because it is stored as
a Sensitive variable. Leaving the branch-scoped value unset would let that inherited value
apply here. Setting it to the **runtime** role does two jobs at once: it shadows the inherited
value, and it keeps the elevated credential off the project. There is no third option in
which the variable is both absent and safe.

Nothing in a deployment runs a migration, either: the build command is
`tsx scripts/validate-env.ts && prisma generate && next build`. Migrations were removed from
the build long ago, precisely so that compiling TypeScript could not mutate a database as a
side effect.

---

## 3. Why the roles were created in SQL rather than through Neon

Neon's own documentation is explicit, and it was checked rather than assumed: a role created
through the Neon **Console, API or CLI** is granted `neon_superuser`. `neon_superuser` is in
turn a member of `pg_read_all_data`, `pg_write_all_data`, `pg_monitor`, `pg_signal_backend`,
`pg_maintain` and `pg_create_subscription`.

`pg_read_all_data` alone would defeat this entire exercise — it is a standing grant to read
every table in every database the role can connect to, including the production-derived
`neondb` on this branch. A role created with a plain SQL `CREATE ROLE` receives no
memberships at all. That is the whole reason these two were created in SQL.

Verified, not assumed: `pg_auth_members` shows **both task roles are members of no role
whatsoever**, while `neondb_owner` is a member of `neon_superuser` and `neon_auth`.

Two consequences of working without superuser are worth recording, because both changed the
design:

- **`ALTER ROLE … NOSUPERUSER / NOREPLICATION / NOBYPASSRLS` requires superuser even to
  restate a value the role already has.** So those attributes are set once at `CREATE` time
  and then *verified from the catalogue*, rather than re-asserted defensively on each run.
- **A `CREATEROLE` role that creates a role receives `admin_option` but not `set_option` on
  it.** `neondb_owner` therefore cannot `SET ROLE` to either task role, and PostgreSQL will
  not let you hand a database to a role you cannot become. Hence the database is owned by
  `neondb_owner` and the migrator was granted `CREATE` on the schema instead. That turned out
  **tighter** than the original intent: the migrator still owns every table it creates, so it
  can alter them later, but it cannot drop or rename the database itself.

---

## 4. Effective privileges, read from the catalogue

### 4a. Attributes

| | `sales_preview_app` | `sales_preview_migrator` | (for contrast) `neondb_owner` |
|---|---|---|---|
| SUPERUSER | no | no | no |
| CREATEDB | no | no | **yes** |
| CREATEROLE | no | no | **yes** |
| BYPASSRLS | no | no | **yes** |
| REPLICATION | no | no | **yes** |
| INHERIT | **NOINHERIT** | inherit | inherit |

### 4b. Role memberships

**None, for either task role.** This is the condition §3 exists to secure, and it is checked
directly rather than inferred from how the role was created.

### 4c. Ownership

| Object | Owner |
|---|---|
| database `sales_preview` | `neondb_owner` |
| all 63 tables in schema `public` | `sales_preview_migrator` |
| anything at all | **not** `sales_preview_app` |

### 4d. Explicit grants

Database ACL on `sales_preview` — `neondb_owner=CTc`, `sales_preview_migrator=Cc`,
`sales_preview_app=c`. The runtime role holds `CONNECT` and nothing else. `CREATE` on the
database belongs to the migrator, which is needed because Prisma issues
`CREATE SCHEMA IF NOT EXISTS "public"` and PostgreSQL checks `CREATE` on the database even
when the schema already exists.

Schema `public` ACL — `pg_database_owner=UC`, `PUBLIC=U`, `sales_preview_migrator=UC`,
`sales_preview_app=U`. The runtime role has `USAGE`, not `CREATE`.

Table grants to the runtime role — exactly `SELECT, INSERT, UPDATE, DELETE`. Not `TRUNCATE`,
not `REFERENCES`, not `TRIGGER`.

### 4e. Default privileges

`ALTER DEFAULT PRIVILEGES` is configured *for the migrator*, granting the runtime role
`arwd` on tables it creates in future and `rU` on sequences. Without this, the next migration
would create tables the application could not read, and the failure would look like a bug in
the feature rather than a missing grant.

### 4f. PUBLIC, stated plainly

A role-specific `REVOKE` does not cancel access still granted through `PUBLIC`, so `PUBLIC`
was examined as a separate question:

- On `sales_preview`: `REVOKE ALL ON DATABASE … FROM PUBLIC` was issued. `PUBLIC` does not
  appear in the database ACL at all.
- On schema `public`: `PUBLIC` keeps `USAGE` — which it needs in order to resolve types — and
  has no `CREATE`. Removing the PostgreSQL 15+ default `CREATE` grant was an explicit
  `REVOKE`.
- **On `neondb`, `PUBLIC` keeps `CONNECT`, and that was deliberately left alone.** `neondb` is
  the unrelated database on this branch that holds the September copy of production data, and
  the operational regression suite uses that branch. Revoking a `PUBLIC` privilege there would
  be a change to shared infrastructure, which the instructions explicitly ruled out.

The consequence is recorded rather than hidden: **the runtime role can open a connection to
`neondb`.** What it cannot do is read or write anything once connected — which is the subject
of §5, and is proven rather than argued.

---

## 5. Proven behaviourally — 36 assertions, 0 failed

Catalogue inspection says what *should* happen. These assertions make the database
demonstrate it. Run with `verify-roles.mjs`.

**36 with an owner credential configured, 33 without.** Creating the probe table in `neondb`
needs rights there, which most people running this will not have and should not have to
obtain. Absent one, the three probe assertions are skipped and the run says so on screen; the
privilege sweep and everything else still runs. Both figures are 0 failed.

**Can it reach the data on the other side of the branch?**

- A **synthetic probe table** was created in `neondb` — `public."__isolation_probe"`, holding
  one invented row — and the runtime role was pointed at it. `SELECT`, `INSERT` and `DELETE`
  were each **refused with 42501**, as was `CREATE TABLE`. The probe was then dropped. No real
  row was read to establish any of this.
- A sweep rather than a sample: **0 of the 64 tables in `neondb` are readable by the runtime
  role, and 0 are writable.** **0 of the 63 tables in `sales_crm_preview`** — the older
  preview database — are readable either.

The probe exists because the two checks answer different questions. "0 of 64 tables readable"
is a privilege calculation that never selects a row, which is what makes it safe; but a
refusal that returns nothing looks the same as an empty database. The probe is the positive
control: a row that definitely exists, that the role definitely cannot see.

**What it may do in its own database** — read all 63 tables, own none of them; `CREATE TABLE`,
`DROP TABLE`, `ALTER TABLE` and `TRUNCATE` are each refused *in practice*, not merely absent
from a grant list.

**That it cannot become something else** — `SET ROLE sales_preview_migrator` and `SET ROLE
neondb_owner` are both refused, `pg_authid` is unreadable, and it can create neither a role
nor a database.

---

## 6. Two protections, and now neither one is load-bearing alone

The previous revision recorded that only the application allowlist existed. Both exist now.

### 6a. Application allowlists — enforced, proven in both directions

Two guards, one per identity. Each parses every connection variable it can see
(`DATABASE_URL`, `DIRECT_URL`, `SHADOW_DATABASE_URL`, `ERP_TEST_DATABASE_URL`, `POSTGRES_URL`)
with a real URL parser rather than a substring match, and refuses **before spawning
anything** — so a refusal below is never a database rejecting a login.

The condition that is new in this revision is the **role**. The previous guard checked where a
connection pointed but not who it connected as, and would have started the application as
`neondb_owner`.

| Runtime guard `withpreview.mjs` | Result |
|---|---|
| production endpoint `ep-dawn-dust-aqn1u1uf` | REFUSED — protected endpoint |
| root production branch `ep-jolly-feather-aqne6cp1` | REFUSED — protected endpoint |
| `ep-icy-field-aq4upc3z` (the identifier the brief named) | REFUSED — protected endpoint |
| an endpoint in no environment at all | REFUSED — not the approved endpoint |
| right endpoint, **wrong database** (`neondb`) | REFUSED — not the approved database |
| right endpoint and database, role `neondb_owner` | **REFUSED — privileged role** |
| right target, the **migration** role | **REFUSED — migration role** |
| right target, an unknown role | REFUSED — not the approved runtime role |
| right endpoint, database and runtime role | **accepted** |
| asked to run `prisma migrate deploy` | **REFUSED — migrations do not run under the runtime identity** |

| Migration guard `withmigrate.mjs` | Result |
|---|---|
| production endpoint `ep-dawn-dust-aqn1u1uf` | REFUSED — protected endpoint |
| right endpoint, wrong database (`neondb`) | REFUSED — not the approved database |
| right target, the **runtime** role | REFUSED — not the migration role |
| right target, role `neondb_owner` | REFUSED — not the migration role |
| asked to start the application (`next dev`) | **REFUSED — the migration identity runs prisma and nothing else** |

A correction carried forward from the previous revision: the brief named
`ep-icy-field-aq4upc3z` as production. **That endpoint exists in no environment of this
project.** An earlier guard in this codebase named it and was therefore protecting nothing —
which is exactly why a denylist alone is not acceptable. It is still denied here, as a second
line and never as the only one.

### 6b. Database privilege isolation — now exists

§4 and §5. The runtime credential is not privileged, inherits nothing, owns nothing, and can
read nothing outside its own database.

### 6c. What remains

`PUBLIC` retains `CONNECT` on `neondb` (§4f), so the runtime role can *open* a connection
there. The allowlist is what stops the attempt being made; the privileges are what make it
useless if it were. That is the intended relationship between the two — each covers the
other's failure — and it is the reason neither is described here as sufficient on its own.

---

## 7. What the database actually contains

Counted in `sales_preview` itself:

| | |
|---|---|
| Employees | 9 — **0** of them without the `UAT_` fixture prefix |
| Customers | 7 — **0** untagged (everything is `UAT…` or `SMK…`) |
| Orders | 4 — all raised by the suites and the hosted smoke test |
| Collection events | 5 — **0** with a `sourceSystem` other than `SANDBOX` |

**Every identity and every credential in this database is a test fixture.** The database was
created empty and has only ever been filled by the suites' own `globalSetup`, by the
regression scripts, and by the hosted smoke test (whose rows carry an `SMK…` marker). Nothing
was copied here from anywhere.

This was the specific risk that shaped the decision. The obvious alternative — reusing
`erp-regression-r1`'s `neondb` — holds 17 untagged, staff-shaped `Employee` rows matching
production's employee count exactly, six with passwords set, with the real role spread. It
could not be verified synthetic-only, so it was neither branched nor reused.

---

## 8. The migration, read rather than inferred

`prisma/migrations/20260924090000_add_sales_crm_and_commissions/migration.sql`, read line by
line rather than judged by whether the tests passed:

| | |
|---|---|
| `CREATE TABLE` | 19 — all new |
| `CREATE TYPE` | 11 — all new |
| `CREATE INDEX` / `CREATE UNIQUE INDEX` | 45 — all on the new tables |
| `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` | 38 — all **from** new tables |
| `DROP` / `TRUNCATE` / `DELETE` / `UPDATE` | **0** |
| `ALTER TABLE` on a pre-existing table | **0** |
| `ALTER COLUMN`, renames, type changes | **0** |
| Changes to permissions, functions, triggers or data | **0** |

Every foreign key points **from** a new table **to** an existing one, which requires no change
to the existing table. Nothing pre-existing is altered, so there is nothing for a running
build to be incompatible with.

That the 26-suite operational regression then passes against the migrated schema is
corroboration, not the proof — a passing suite cannot demonstrate the absence of a statement
nobody looked for. The counts above come from reading the file.

**One bookkeeping note.** `_prisma_migrations` holds 22 rows, not 21: 21 cleanly applied, plus
one row for `20260522000000_baseline` marked rolled-back with `applied_steps_count = 0`. That
is the residue of the first baseline attempt, which failed on a missing `CREATE` grant before
executing any statement and was resolved with `prisma migrate resolve --rolled-back`. It
changed nothing in the schema, and `prisma migrate status` reports the database up to date.

---

## 9. Reproducing any of this

```sh
# Both application allowlists, both directions (opens no connection):
sh guard-proof2.sh "$SCRATCH"

# The 36 role-isolation assertions, including the synthetic probe in neondb:
SCRATCH="$SCRATCH" node verify-roles.mjs

# Migration state, under the migration identity and no other:
MIGRATE_ENV="$SCRATCH/.env.preview-migrate" node withmigrate.mjs prisma migrate status

# The migration, counted:
grep -c "^CREATE TABLE" prisma/migrations/20260924090000_*/migration.sql
grep -cE "^(DROP|TRUNCATE|DELETE|UPDATE)" prisma/migrations/20260924090000_*/migration.sql
```
