#!/bin/sh
# Proves both application-side allowlists in both directions, without ever opening a
# connection: each guard refuses before it spawns anything, so a refusal here is not a
# database rejecting a login.
#
# The new condition compared with the previous revision is the ROLE. The old guard checked
# where a connection pointed but not who it connected as, so it would have started the
# application as neondb_owner.
S="$1"                      # a writable scratch directory for the probe env files
D=$(dirname "$0")
H="c-8.us-east-1.aws.neon.tech"
OK_EP="ep-wandering-leaf-aqjtuin5"

# Probe env files carrying no URLs of their own, so only the injected ones are seen.
printf 'JWT_SECRET=x\nPIN_LOOKUP_SECRET=y\n' > "$S/.probe-app"
printf 'JWT_SECRET=x\nPIN_LOOKUP_SECRET=y\n' > "$S/.probe-mig"

runtime() {
  label="$1"; url="$2"
  out=$(DATABASE_URL="$url" DIRECT_URL="$url" PREVIEW_ENV="$S/.probe-app" \
        node ""$D"/withpreview.mjs" node -e "console.log('REACHED THE TOOL')" 2>&1)
  printf '  %-48s %s\n' "$label" "$(echo "$out" | head -1)"
}
migrate() {
  label="$1"; url="$2"
  out=$(DATABASE_URL="$url" DIRECT_URL="$url" MIGRATE_ENV="$S/.probe-mig" \
        node ""$D"/withmigrate.mjs" prisma --version 2>&1)
  printf '  %-48s %s\n' "$label" "$(echo "$out" | head -1)"
}

echo "RUNTIME GUARD (withpreview.mjs) — target and identity"
runtime "production endpoint (ep-dawn-dust)"           "postgresql://sales_preview_app:p@ep-dawn-dust-aqn1u1uf.$H/sales_preview"
runtime "root production branch (ep-jolly-feather)"    "postgresql://sales_preview_app:p@ep-jolly-feather-aqne6cp1.$H/sales_preview"
runtime "the identifier the brief named (ep-icy-field)" "postgresql://sales_preview_app:p@ep-icy-field-aq4upc3z.$H/sales_preview"
runtime "an endpoint in no environment at all"          "postgresql://sales_preview_app:p@ep-somewhere-else.$H/sales_preview"
runtime "RIGHT endpoint, WRONG database (neondb)"       "postgresql://sales_preview_app:p@$OK_EP.$H/neondb"
runtime "RIGHT endpoint and database, role neondb_owner" "postgresql://neondb_owner:p@$OK_EP.$H/sales_preview"
runtime "RIGHT target, but the MIGRATION role"          "postgresql://sales_preview_migrator:p@$OK_EP.$H/sales_preview"
runtime "RIGHT target, an unknown role"                 "postgresql://someone_else:p@$OK_EP.$H/sales_preview"
runtime "the approved runtime identity"                 "postgresql://sales_preview_app:p@$OK_EP.$H/sales_preview"

echo
echo "RUNTIME GUARD — what it will run"
out=$(DATABASE_URL="postgresql://sales_preview_app:p@$OK_EP.$H/sales_preview" \
      DIRECT_URL="postgresql://sales_preview_app:p@$OK_EP.$H/sales_preview" \
      PREVIEW_ENV="$S/.probe-app" node ""$D"/withpreview.mjs" prisma migrate deploy 2>&1)
printf '  %-48s %s\n' "asked to run a migration" "$(echo "$out" | head -1)"

echo
echo "MIGRATION GUARD (withmigrate.mjs) — target and identity"
migrate "production endpoint (ep-dawn-dust)"            "postgresql://sales_preview_migrator:p@ep-dawn-dust-aqn1u1uf.$H/sales_preview"
migrate "RIGHT endpoint, WRONG database (neondb)"        "postgresql://sales_preview_migrator:p@$OK_EP.$H/neondb"
migrate "RIGHT target, but the RUNTIME role"             "postgresql://sales_preview_app:p@$OK_EP.$H/sales_preview"
migrate "RIGHT target, role neondb_owner"                "postgresql://neondb_owner:p@$OK_EP.$H/sales_preview"

echo
echo "MIGRATION GUARD — what it will run"
out=$(DATABASE_URL="postgresql://sales_preview_migrator:p@$OK_EP.$H/sales_preview" \
      DIRECT_URL="postgresql://sales_preview_migrator:p@$OK_EP.$H/sales_preview" \
      MIGRATE_ENV="$S/.probe-mig" node ""$D"/withmigrate.mjs" next dev 2>&1)
printf '  %-48s %s\n' "asked to start the application" "$(echo "$out" | head -1)"

rm -f "$S/.probe-app" "$S/.probe-mig"
