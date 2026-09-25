#!/usr/bin/env node
/**
 * Run one read-only SQL statement against the isolated preview database.
 *
 * For inspection during development — "what stage codes exist", "did the constraint land".
 * Refuses anything that is not a SELECT, and refuses any target that is not the preview
 * database. Not a migration tool and not a data-fixing tool.
 *
 * Usage:  node scripts/sales-preview/psql.mjs "SELECT ..."
 */
import { loadPreviewEnv } from "./preview-env.mjs";
import pg from "pg";

const sql = process.argv.slice(2).join(" ").trim();
if (!sql) {
  console.error('Usage: node scripts/sales-preview/psql.mjs "SELECT ..."');
  process.exit(2);
}
if (!/^\s*(select|with|explain|show)\b/i.test(sql)) {
  console.error("REFUSED: read-only. This runs SELECT / WITH / EXPLAIN / SHOW and nothing else.");
  process.exit(3);
}

let loaded;
try {
  loaded = loadPreviewEnv("app");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(3);
}

const client = new pg.Client({ connectionString: loaded.env.DIRECT_URL });
await client.connect();
try {
  const res = await client.query(sql);
  console.table(res.rows);
} finally {
  await client.end();
}
