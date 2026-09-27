#!/usr/bin/env bash
# One-time setup of the accounting preview database: migrate, then load the synthetic fixture.
# Refuses anything but the named preview target (scripts/accounting/preview-target.mjs).
#
#   ACCOUNTING_PREVIEW_DB=accounting_preview DATABASE_URL=... DIRECT_URL=... FIN_FIXTURE_PASSWORD=... \
#     scripts/accounting/preview-setup.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
node --input-type=module -e 'import { isPreviewTarget } from "./scripts/accounting/preview-target.mjs"; if (!isPreviewTarget(process.env.DIRECT_URL) || !isPreviewTarget(process.env.DATABASE_URL)) { console.error("Refusing: not the accounting preview database."); process.exit(1); }'
npx prisma migrate deploy
npx tsx scripts/accounting/seed-local-fixture.ts --reset
