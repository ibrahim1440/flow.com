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
file also sets `SALES_SANDBOX_COLLECTIONS=true`.

**Restricting them on Windows takes more than `mode: 0o600`.** Node's `mode` argument only
toggles the read-only attribute on Windows; the file still inherits its parent's ACL, and
`ls -l` under Git Bash reports an emulated `0644` that means nothing. Use a real ACL:

```sh
icacls "$(cygpath -w "$S/.env.preview-app")" /inheritance:r /grant:r "$(whoami):(R,W)"
```

On Linux or macOS `chmod 600` is sufficient and `mode: 0o600` works as written.

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

## Handing the review accounts to a person

The three reviewer accounts are seeded by the browser suite, and its fixture PINs are
committed in `tests/e2e/support/roles.ts` — fine for a disposable test database, wrong as the
way a person receives credentials for a review environment. Issue fresh ones instead:

```sh
PREVIEW_ENV="$S/.env.preview-app" npx tsx scripts/sales-preview/reviewer-accounts.ts
```

It prints three new six-digit PINs **once, to your terminal**, writes nothing to disk, and
replaces whatever the accounts had — so the committed fixture PINs no longer open the
database. Run it again to get new ones; the old ones are not recoverable.

It runs as the restricted runtime role and refuses any other identity: it is an `UPDATE` on
three rows, not an administrative act.

**Ordering, because these two tools disagree by design:** run the browser suite (seeds the
fixtures) → run the smoke test (uses the fixture PINs) → rotate for the human reviewer. If you
need to smoke-test after rotating, pass the live values instead:

```sh
SMOKE_PIN_REP=… SMOKE_PIN_MANAGER=… SMOKE_PIN_FINANCE=… \
  SCRATCH="$S" SMOKE_URL="…" node scripts/sales-preview/smoke-hosted.mjs
```

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
  secret in `$S/.bypass-secret`, sent as an `x-vercel-protection-bypass` header.

**Treat that secret as a project-wide credential, because it is one.** It bypasses deployment
protection on **every deployment in the project** until revoked — not only the URL you point it
at, and not only preview deployments. Handle it accordingly:

- **Generate it yourself and pass it in.** Asking Vercel to generate one returns the value in
  the response body, where it lands in your scrollback. Send the API call with `--silent`.
- **Never send `x-vercel-set-bypass-cookie: true`.** It answers `307` with a
  `Set-Cookie: _vercel_jwt=…` whose JWT payload contains the secret in clear text, so
  inspecting response headers leaks it — and a redaction filter matching the literal string
  will not catch it, because it is base64-encoded. The plain header alone returns `200`.
- **Never print response headers** around a bypass-protected request, and keep shell tracing
  (`set -x`) away from any command that carries the secret.
- **Revoke it when the run finishes, and verify the revocation two ways:** the raw secret
  should go back to `302`, *and* any cookie already issued from it should also be refused.
  Revoking the secret is not by itself proof the cookie path died with it.

`smoke-hosted.mjs` enforces the printing rules itself: every logged detail passes through a
pattern-based redactor, auth responses are reported by status code only, and the cookie jar is
never printed.

Commission figures are asserted as *deltas* against a baseline the script reads first, because
the database legitimately carries rows from earlier runs. An absolute assertion would either
fail for the wrong reason or pass because of them.
