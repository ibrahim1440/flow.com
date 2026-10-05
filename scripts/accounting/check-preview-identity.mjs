#!/usr/bin/env node
// Refuses (exit 1) unless every named env variable points at the accounting preview database,
// by the allowlist, by Neon control-plane metadata (needs NEON_API_KEY) and by server-reported
// identity (scripts/accounting/preview-target.mjs). Any unavailable check refuses.
// Prints ids only, never a URL.
//
//   node scripts/accounting/check-preview-identity.mjs DIRECT_URL DATABASE_URL
import { assertPreviewIdentity, assertNeonMetadata, isPreviewTarget } from "./preview-target.mjs";

let failed = false;
for (const v of process.argv.slice(2)) {
  try {
    if (!isPreviewTarget(process.env[v])) throw new Error(`Refusing: ${v} is not an allow-listed preview URL (or ACCOUNTING_PREVIEW_DB is not set).`);
    const m = await assertNeonMetadata(process.env[v], v);
    const r = await assertPreviewIdentity(process.env[v], v);
    if (r.project !== m.project || r.branch !== m.branch || r.endpoint !== m.endpoint) throw new Error(`Refusing (${v}): server-reported ids differ from Neon metadata.`);
    console.log(`${v}: OK allowlist · Neon API project=${m.project} branch=${m.branch} endpoint=${m.endpoint} · server ids match · db=${r.db} · marker present`);
  } catch (e) {
    failed = true;
    console.error(`${v}: ${String(e.message).replace(/postgres(ql)?:\/\/\S+/g, "<url>")}`);
  }
}
process.exit(failed || process.argv.length < 3 ? 1 : 0);
