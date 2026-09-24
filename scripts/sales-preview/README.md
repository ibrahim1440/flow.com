# Running anything against the Sales CRM preview database

These are the scripts behind `docs/sales/DATABASE_ISOLATION.md`. They exist so the isolation
claims in that document can be re-checked rather than taken on trust.

**No credential is committed here, and none ever should be.** Each script reads its
connection details from an environment file that lives *outside* the repository, in a
directory of your choosing, and refuses to start if that file names the wrong role, database
or endpoint.

## The two identities

The preview database has two credentials and they are not interchangeable.

| file | role | what it is for |
|---|---|---|
| `.env.preview-app` | `sales_preview_app` | running the application and the test suites |
| `.env.preview-migrate` | `sales_preview_migrator` | `prisma migrate deploy`, and nothing else |

Each file holds `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET` and `PIN_LOOKUP_SECRET`; the app
file also sets `SALES_SANDBOX_COLLECTIONS=true`. Write them with permissions `0600`.

`PIN_LOOKUP_SECRET` is not an ordinary secret. Employee PIN rows store a *keyed* selector
derived from it, so changing it makes every seeded employee unable to sign in until the
fixtures are regenerated. `JWT_SECRET` only signs sessions, so changing that merely logs
everyone out. Do not assume the two behave alike.

## Running things

```sh
S=/path/to/your/env/directory          # holds .env.preview-app and .env.preview-migrate

# The application, as the restricted runtime role. Refuses to run prisma at all.
PREVIEW_ENV="$S/.env.preview-app" node scripts/sales-preview/withpreview.mjs next dev

# The browser suite, same identity.
PREVIEW_ENV="$S/.env.preview-app" node scripts/sales-preview/withpreview.mjs playwright test

# Migrations, as the migration role. Refuses to run anything but prisma.
MIGRATE_ENV="$S/.env.preview-migrate" node scripts/sales-preview/withmigrate.mjs prisma migrate deploy
```

## Re-checking the isolation claims

```sh
# Both allowlists, both directions. Opens no connection: each guard refuses before
# it spawns anything, so a refusal is never a database rejecting a login.
sh scripts/sales-preview/guard-proof.sh "$S"

# 36 assertions on effective privileges, memberships, ownership, PUBLIC grants and
# default privileges — plus a synthetic probe table in neondb that proves the runtime
# role's refusals are the privilege system working and not an empty result set.
SCRATCH="$S" node scripts/sales-preview/verify-roles.mjs
```

`verify-roles.mjs` creates and drops `public."__isolation_probe"` in `neondb`, holding one
invented row. It reads no real data, and it is the only thing any of these scripts writes
outside `sales_preview`.

## Smoke-testing a deployed Preview

```sh
SCRATCH="$S" SMOKE_URL="https://<the-preview-url>" node scripts/sales-preview/smoke-hosted.mjs
```

Exercises sign-in, lead conversion, the deal record, quotation pricing and discount
authorisation, quote-to-order, won and lost, and the commission cycle through to an
adjustment and a refund — all over HTTPS against the deployed application, with no local
server and no direct database access.

Two things it needs:

- The fixtures the browser suite seeds. Run `playwright test` against the same database
  first; the smoke test reads `tests/e2e/support/catalog.json` for their identifiers.
- If the deployment is behind Vercel's SSO protection, a Protection Bypass for Automation
  secret in `$S/.bypass-secret`, sent as an `x-vercel-protection-bypass` header. Create it for
  the run and revoke it afterwards. Do not send `x-vercel-set-bypass-cookie`: it returns the
  secret to you inside a `_vercel_jwt` cookie, which puts it in your terminal scrollback and
  your shell history.

Commission figures are asserted as *deltas* against a baseline the script reads first, because
the database legitimately carries rows from earlier runs. An absolute assertion would either
fail for the wrong reason or pass because of them.
