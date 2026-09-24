# Where the preview database actually is, and what its credential can reach

Read from provider metadata and from the preview database itself. No production database
was connected to. No credential, connection string or secret appears anywhere in this file.

---

## 1. Identity

| | |
|---|---|
| Provider | Neon, PostgreSQL 17 |
| Project | `hiqbah` — `dark-lab-61530722` |
| Branch | `erp-regression-r1` — `br-bold-forest-aq3z2qjq` |
| Endpoint | `ep-wandering-leaf-aqjtuin5` (`…c-8.us-east-1.aws.neon.tech`), read-write, `aws-us-east-1` |
| **Database** | **`sales_crm_preview`**, created 2026-09-23, owner `neondb_owner` |
| Migrations | 21 applied, 0 unfinished |

**It is not production.** Production is `ep-dawn-dust-aqn1u1uf` on branch
`br-weathered-bread-aqais7hp`, which is what serves www.beanflow.net; the root branch named
`production` (`br-fragrant-poetry-aqd0ndyx`, endpoint `ep-jolly-feather-aqne6cp1`) is a
different compute again. `sales_crm_preview` is on neither.

**But the branch it sits on is a child of production.** `erp-regression-r1` was branched
from `br-weathered-bread-aqais7hp` at LSN `0/1641CDE8`, 2026-09-11. Neon branches are
copy-on-write, so writes here can never reach the parent — but the branch does carry a
September copy of production data in its OTHER database, `neondb`. That is precisely why
`sales_crm_preview` was created as a new, empty database rather than by reusing `neondb`.

---

## 2. What the preview database contains

Counted in `sales_crm_preview` itself:

| | |
|---|---|
| Employees | 9 — **every one** carries the `UAT_` fixture prefix, and nothing else |
| Customers | 9 — all `UAT `/`UAT-` prefixed |
| Orders | 3 — all raised by the suites |
| Leads | 0 between runs (the suites tear down what they create) |
| Collection events | 0 between runs |

**Every identity and every credential in this database is a test fixture.** There are no
untagged, staff-shaped rows. Nothing was copied here from anywhere: the database was created
empty and has only ever been filled by the suites' own `globalSetup` and fixtures.

This was the specific risk that shaped the decision. The obvious parent, `erp-regression-r1`'s
`neondb`, holds 17 untagged staff-shaped `Employee` rows — matching production's employee
count exactly, six with passwords set, with the real role spread. It could not be verified
synthetic-only, so it was not branched and not reused.

---

## 3. Two different protections, and only one of them exists

The brief asked for these to be distinguished. They are very different, and conflating them
is how a preview ends up pointed at real data.

### 3a. Application allowlist — **enforced, and proven both ways**

Every command that touches this database runs through a guard that requires the URL to name
**both** the approved endpoint **and** the approved database. It is an allowlist, not a
denylist: an unrecognised target is refused rather than allowed. Every connection variable is
checked — `DATABASE_URL`, `DIRECT_URL`, `SHADOW_DATABASE_URL`, `ERP_TEST_DATABASE_URL`,
`POSTGRES_URL` — and the refusal happens before anything is spawned, so no connection is ever
opened to be rejected.

Exercised in both directions:

| Target | Result |
|---|---|
| production endpoint `ep-dawn-dust-aqn1u1uf` | REFUSED — names a protected endpoint |
| root production branch `ep-jolly-feather-aqne6cp1` | REFUSED — names a protected endpoint |
| `ep-icy-field-aq4upc3z` (the identifier the brief named) | REFUSED — names a protected endpoint |
| **right endpoint, wrong database** (`ep-wandering-leaf` + `neondb`) | **REFUSED — not the approved database** |
| an endpoint in no environment at all | REFUSED — not the approved endpoint |
| `ep-wandering-leaf-aqjtuin5` + `sales_crm_preview` | **accepted** |

The fourth row is the one that matters: the guard stops the preview reaching the
production-derived data sitting on the very same compute.

A correction the brief itself anticipated: it named `ep-icy-field-aq4upc3z` as production.
**That endpoint exists in no environment of this project.** An earlier guard in this codebase
named it and was therefore protecting nothing — which is exactly why a denylist alone is not
acceptable. It is still denied here, as a second line of defence and never as the only one.

### 3b. Database privilege isolation — **does not exist**

Asked of the preview database directly:

| | |
|---|---|
| Connecting role | `neondb_owner` |
| Superuser | no |
| Can create databases / roles | **yes / yes** |
| Bypasses row-level security | **yes** |
| Can connect to `neondb` on the same branch | **yes** |
| Login roles on the branch | `neondb_owner` plus Neon's own `cloud_admin`, `neon_service`, `neon_auth` |

There is exactly one usable role in this project, it owns everything, and it can open the
production-derived `neondb` on the same branch. **The only thing preventing that is the
application allowlist in 3a.** Postgres grants would not stop it.

Worse, and stated plainly because it is the honest reading: Neon roles are branch-scoped and
a child branch inherits the parent's roles at branch time. `neondb_owner` shows
`updated_at = 2026-05-10T07:43:33Z` on **both** the preview branch and the production branch
— identical, and predating the branch point by four months. That is consistent with the
password never having been rotated on either, which would mean the same credential
authenticates against the production endpoint with nothing changed but the hostname.

**This was not tested, deliberately.** Confirming it would require attempting a production
connection, which is forbidden and which would be the wrong way to learn the answer. It is
recorded as an unverified but well-supported inference, because acting as though it were
false would be the more dangerous mistake.

### What would actually fix it

Create a Postgres role scoped to `sales_crm_preview`, revoke `CONNECT` on `neondb` from
`PUBLIC` (the owner keeps its own access, so the operational regression is unaffected), and
point the preview at the new role. Then the two protections would be independent, and neither
alone would be load-bearing.

**Not done here.** It changes role grants on a branch shared with the operational regression
suite, `PUBLIC` grants on managed infrastructure can affect the provider's own service roles,
and the regression was mid-run. It is a decision about shared infrastructure, not a detail of
this feature, so it is written down rather than taken.

---

## 4. The migration, read rather than inferred

`prisma/migrations/20260924090000_add_sales_crm_and_commissions/migration.sql`, read line by
line rather than judged by whether the tests passed:

| | |
|---|---|
| `CREATE TABLE` | 19 — all new |
| `CREATE TYPE` | 11 — all new |
| `CREATE INDEX` | 45 — all on the new tables |
| `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` | 38 — all **from** new tables |
| `DROP` / `TRUNCATE` / `DELETE` / `UPDATE` | **0** |
| `ALTER TABLE` on a pre-existing table | **0** |
| `ALTER COLUMN`, renames, type changes | **0** |
| Changes to permissions, functions, triggers or data | **0** |

Every foreign key points **from** a new table **to** an existing one, which needs no change
to the existing table. Nothing pre-existing is altered, so there is nothing for a running
build to be incompatible with.

That the 26-suite operational regression then passes against the migrated schema is
corroboration, not the proof — a passing test suite cannot demonstrate the absence of a
statement nobody looked for. The counts above come from reading the file.

---

## 5. Reproducing any of this

```
# Application allowlist, both directions (opens no connection):
bash guard-proof.sh

# What the preview database contains (Neon control plane + one read-only query):
#   project dark-lab-61530722, branch br-bold-forest-aq3z2qjq, database sales_crm_preview

# The migration, counted:
grep -c "^CREATE TABLE" prisma/migrations/20260924090000_*/migration.sql
grep -cE "^(DROP|TRUNCATE|DELETE|UPDATE)" prisma/migrations/20260924090000_*/migration.sql
```
