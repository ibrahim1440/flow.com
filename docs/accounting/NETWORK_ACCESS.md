# Network access needed for cloud verification

Observed on 2026-09-27 in the Claude Code cloud environment used for this work.

## What the environment actually provides

- **Outbound traffic goes only through an HTTPS CONNECT egress proxy** (`HTTPS_PROXY`), and an
  organisation policy decides which hosts may be reached.
- The proxy's own status page recorded a **policy denial for `console.neon.tech:443`** (the gateway
  answered 403 to CONNECT).
- A direct TCP connection to the preview endpoint on port 5432 gets no route.
- The application's database driver (`pg` behind Prisma's driver adapter) and Prisma's migration
  engine (`prisma migrate deploy`) **open plain TCP sockets and do not use `HTTPS_PROXY`**.

So allow-listing a domain for HTTPS **does not** give PostgreSQL connectivity. I have not attempted
to tunnel PostgreSQL through the proxy, and will not.

## Exact endpoints

| Purpose | Host | Protocol | Port |
|---|---|---|---|
| Neon control-plane API. Needed by `check-preview-identity.mjs` for authoritative identity; the setup fails closed without it | `console.neon.tech` | HTTPS | 443 |
| Accounting preview database, direct (migrations, `DIRECT_URL`) | `ep-plain-field-awqkif28.c-12.us-east-1.aws.neon.tech` | PostgreSQL wire protocol with TLS (`sslmode=require`, preferably `verify-full`) | 5432 |
| Accounting preview database, pooled (runtime, `DATABASE_URL`) | `ep-plain-field-awqkif28-pooler.c-12.us-east-1.aws.neon.tech` | same | 5432 |

These hostnames come from the Neon API: project `dry-smoke-16360248`, branch
`br-withered-art-aw2zp5kr`, endpoint `ep-plain-field-awqkif28`.

## Setting to change in this environment

In the session's environment menu (title bar) → **Edit** → **Network access**, either add the hosts
above to the allowed domains, or choose a broader access level. Access levels are described at
https://code.claude.com/docs/en/claude-code-on-the-web.

- **Adding `console.neon.tech`** is expected to fix the API call, which goes over HTTPS.
- **Adding the database hosts** helps only if the chosen access level gives direct (non-proxy) TCP
  egress on port 5432. The documentation I can read does not promise that for an allowed-domains
  list. After any change, I will prove it with the real driver (`node scripts/accounting/check-preview-identity.mjs`)
  and with `prisma migrate status`, not with an HTTPS probe.

## If direct database access stays unavailable: authorised alternatives

| Option | Compatible with the real driver and migrations? | Notes |
|---|---|---|
| **A. GitHub Actions workflow** in `flow.com` (after the Claude GitHub App is installed), using a GitHub *environment* `accounting-preview` with secrets `DATABASE_URL`, `DIRECT_URL` (test-project roles only) and `NEON_API_KEY` (project-scoped to `dry-smoke-16360248`) | Yes. Hosted runners have direct egress on 5432 | Recommended. The job runs `preview-setup.sh`, the runtime HTTP suites against a locally started `next start`, and uploads the results. It holds no production secret; the environment can require your approval per run |
| B. Your own machine | Yes | Run the same commands; the evidence is only as good as the logs you send back |
| C. Neon serverless driver over HTTPS/WebSocket (443) | **No** for migrations. Only partially for runtime | Prisma's migration engine needs TCP, and the app uses `pg`. Switching drivers would test something other than what ships |
| D. Vercel Preview deployment | Runtime only | Vercel functions reach Neon directly, which verifies the deployed app. It cannot run migrations (the build never migrates, by design) |

Meanwhile, all implementation and testing continue against the local PostgreSQL 16 server.
