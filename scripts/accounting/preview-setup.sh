#!/usr/bin/env bash
# One-time setup of the accounting preview database: migrate, then load the synthetic fixture.
# Refuses anything but the preview target (scripts/accounting/preview-target.mjs), checked
# before EACH destructive step, twice: by URL, and by what the server itself reports (Neon
# project, branch and endpoint ids, current_database(), disposable marker).
#
#   ACCOUNTING_PREVIEW_DB=accounting_preview DATABASE_URL=... DIRECT_URL=... FIN_FIXTURE_PASSWORD=... \
#     scripts/accounting/preview-setup.sh [--migrate-only]
#
# DIRECT_URL is the owner URL of the TEST project (DDL). DATABASE_URL is used by the seed; the
# deployed Preview itself runs with the restricted accounting_app role.
set -euo pipefail
cd "$(dirname "$0")/../.."

identity() { node scripts/accounting/check-preview-identity.mjs "$@"; }

echo "== identity check (before migrate)"
identity DIRECT_URL DATABASE_URL
node scripts/migrate-deploy.mjs

[[ "${1:-}" == "--migrate-only" ]] && exit 0

echo "== identity check (before reset + seed)"
identity DATABASE_URL
npx tsx scripts/accounting/seed-local-fixture.ts --reset
