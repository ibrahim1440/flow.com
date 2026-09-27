#!/usr/bin/env node
// Refuses (exit 1) unless every named env variable points at the accounting preview database,
// by URL and by server-reported identity (scripts/accounting/preview-target.mjs).
// Prints ids only, never a URL.
//
//   node scripts/accounting/check-preview-identity.mjs DIRECT_URL DATABASE_URL
import { assertPreviewIdentity } from "./preview-target.mjs";

let failed = false;
for (const v of process.argv.slice(2)) {
  try {
    const r = await assertPreviewIdentity(process.env[v], v);
    console.log(`${v}: OK project=${r.project} branch=${r.branch} endpoint=${r.endpoint} db=${r.db} marker=ok`);
  } catch (e) {
    failed = true;
    console.error(`${v}: ${String(e.message).replace(/postgres(ql)?:\/\/\S+/g, "<url>")}`);
  }
}
process.exit(failed || process.argv.length < 3 ? 1 : 0);
