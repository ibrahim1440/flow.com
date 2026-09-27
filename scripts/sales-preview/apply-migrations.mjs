#!/usr/bin/env node
/**
 * Apply pending migrations to the ISOLATED PREVIEW database, and nothing else.
 *
 * This is a wrapper around the repository's own `scripts/migrate-deploy.mjs`, not a second
 * way to migrate: the credential is loaded from outside the repo, the target is asserted
 * against the allowlist first, and then the normal deploy path runs. The point of the
 * wrapper is that the operator cannot accidentally hand it a different DATABASE_URL.
 *
 * Usage:  node scripts/sales-preview/apply-migrations.mjs [--dry-run]
 */
import { spawnSync } from "node:child_process";
import { loadPreviewEnv } from "./preview-env.mjs";

const dryRun = process.argv.includes("--dry-run");

let loaded;
try {
  loaded = loadPreviewEnv("migrate");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(3);
}

console.log(`Target: ${loaded.target}  (role ${loaded.role})`);
if (dryRun) {
  console.log("--dry-run: target verified, nothing applied.");
  process.exit(0);
}

const res = spawnSync(process.execPath, ["scripts/migrate-deploy.mjs"], {
  stdio: "inherit",
  shell: false,
  env: { ...process.env, ...loaded.env },
});

if (res.error) {
  console.error(`Could not run the deploy script: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
