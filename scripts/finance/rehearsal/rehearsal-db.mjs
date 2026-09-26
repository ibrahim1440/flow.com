#!/usr/bin/env node
/**
 * Migration rehearsal on the LOCAL portable PostgreSQL only (127.0.0.1:54329).
 * Every database it touches must be named erp_rehearsal*; nothing else is accepted.
 * Secrets come from the worktree's gitignored .env and are never printed.
 *
 *   node scripts/finance/rehearsal/rehearsal-db.mjs create  <db>            fresh, marked database
 *   node scripts/finance/rehearsal/rehearsal-db.mjs env     <db> <file>     scratch env file (owner URL)
 *   node scripts/finance/rehearsal/rehearsal-db.mjs copy    <src> <dst>     server-side copy (CREATE DATABASE … TEMPLATE)
 *   node scripts/finance/rehearsal/rehearsal-db.mjs drop    <db>
 *   node scripts/finance/rehearsal/rehearsal-db.mjs snapshot <db> <out.json> [baseline.json]
 *   node scripts/finance/rehearsal/rehearsal-db.mjs compare <baseline.json> <after.json>
 *   node scripts/finance/rehearsal/rehearsal-db.mjs grant-app <db>
 *   node scripts/finance/rehearsal/rehearsal-db.mjs role-checks <db>
 *
 * The copy is the backup this server can make: a complete, restorable copy of the database
 * on the same server, taken with no connections open. It is NOT point-in-time recovery and
 * NOT an off-server dump (this PostgreSQL distribution ships no pg_dump).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { Client } = createRequire(path.join(ROOT, "package.json"))("pg");
const MARKER = "hiqbah-rehearsal-disposable";
const env = Object.fromEntries(readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
const name = (db) => { if (!/^erp_rehearsal[a-z0-9_]*$/.test(db ?? "")) throw new Error(`refusing: ${db} is not an erp_rehearsal* database`); return db; };
const url = (db, user = "finance_local", pw = env.FIN_LOCAL_PG_SUPERUSER_PASSWORD) => `postgresql://${user}:${encodeURIComponent(pw)}@127.0.0.1:54329/${db}`;
async function withDb(db, fn, user, pw) {
  const c = new Client({ connectionString: url(db, user, pw) });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function assertMarked(db) {
  const r = await withDb("postgres", (c) => c.query("SELECT shobj_description(oid,'pg_database') d FROM pg_database WHERE datname=$1", [db]));
  if (r.rows[0]?.d !== MARKER) throw new Error(`refusing: ${db} is not marked ${MARKER}`);
}
const q = (s) => `"${s.replace(/"/g, '""')}"`;

async function snapshot(db, baseline) {
  return withDb(db, async (c) => {
    const tables = (await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`)).rows.map((r) => r.table_name);
    const out = { db, takenAt: new Date().toISOString(), tables: {}, migrations: [], triggers: [], constraints: [], indexes: [] };
    for (const t of tables) {
      const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t])).rows.map((r) => r.column_name);
      // Preservation is checked over the columns the table had before the migration.
      const use = baseline?.tables[t]?.columns ?? cols;
      const rowExpr = `json_build_array(${use.map(q).join(",")})::text`;
      const r = await c.query(`SELECT count(*)::int n, coalesce(md5(string_agg(md5(${rowExpr}), '' ORDER BY md5(${rowExpr}))), '') h FROM ${q(t)}`);
      out.tables[t] = { columns: cols, checkedColumns: use.length, rows: r.rows[0].n, checksum: r.rows[0].h };
    }
    if (tables.includes("_prisma_migrations")) out.migrations = (await c.query(`SELECT migration_name, finished_at IS NOT NULL AS applied, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations ORDER BY migration_name`)).rows;
    out.triggers = (await c.query(`SELECT c.relname AS table, t.tgname AS trigger FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public' ORDER BY 1,2`)).rows;
    out.constraints = (await c.query(`SELECT c.relname AS table, k.conname AS name, k.contype AS type FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY 1,2`)).rows;
    out.indexes = (await c.query(`SELECT tablename AS table, indexname AS name FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2`)).rows;
    return out;
  });
}

const [cmd, a, b, c3] = process.argv.slice(2);
switch (cmd) {
  case "create": {
    const db = name(a);
    await withDb("postgres", async (c) => {
      if ((await c.query("SELECT 1 FROM pg_database WHERE datname=$1", [db])).rowCount) await c.query(`DROP DATABASE ${db} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${db} ENCODING 'UTF8'`);
      await c.query(`COMMENT ON DATABASE ${db} IS '${MARKER}'`);
    });
    console.log(`${db} created and marked`);
    break;
  }
  case "env": {
    const db = name(a); await assertMarked(db);
    const u = url(db);
    writeFileSync(b, [`DATABASE_URL="${u}"`, `DIRECT_URL="${u}"`, `PIN_LOOKUP_SECRET="${env.PIN_LOOKUP_SECRET}"`, `JWT_SECRET="${env.JWT_SECRET}"`, `RATE_LIMIT_SECRET="${env.RATE_LIMIT_SECRET}"`].join("\n") + "\n");
    console.log(`env for ${db} written (values not printed)`);
    break;
  }
  case "copy": {
    const src = name(a), dst = name(b); await assertMarked(src);
    await withDb("postgres", async (c) => {
      await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [src]);
      if ((await c.query("SELECT 1 FROM pg_database WHERE datname=$1", [dst])).rowCount) await c.query(`DROP DATABASE ${dst} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${dst} TEMPLATE ${src}`);
      await c.query(`COMMENT ON DATABASE ${dst} IS '${MARKER}'`);
    });
    console.log(`${dst} is a server-side copy of ${src}`);
    break;
  }
  case "drop": {
    const db = name(a); await assertMarked(db);
    await withDb("postgres", (c) => c.query(`DROP DATABASE ${db} WITH (FORCE)`));
    console.log(`${db} dropped`);
    break;
  }
  case "snapshot": {
    const db = name(a); await assertMarked(db);
    const base = c3 ? JSON.parse(readFileSync(c3, "utf8")) : undefined;
    const s = await snapshot(db, base);
    writeFileSync(b, JSON.stringify(s, null, 1));
    const rows = Object.values(s.tables).reduce((t, x) => t + x.rows, 0);
    console.log(`${db}: ${Object.keys(s.tables).length} tables, ${rows} rows, ${s.migrations.length} migrations, ${s.triggers.length} triggers`);
    break;
  }
  case "compare": {
    const base = JSON.parse(readFileSync(a, "utf8")), after = JSON.parse(readFileSync(b, "utf8"));
    const problems = [], changedCols = [];
    for (const [t, v] of Object.entries(base.tables)) {
      if (t === "_prisma_migrations") continue; // expected to grow; reported as newMigrations
      const w = after.tables[t];
      if (!w) { problems.push(`${t}: table missing`); continue; }
      if (w.rows !== v.rows) problems.push(`${t}: rows ${v.rows} → ${w.rows}`);
      if (w.checksum !== v.checksum) problems.push(`${t}: content of the original columns changed`);
      const added = w.columns.filter((x) => !v.columns.includes(x)); const removed = v.columns.filter((x) => !w.columns.includes(x));
      if (removed.length) problems.push(`${t}: columns removed ${removed.join(",")}`);
      if (added.length) changedCols.push(`${t} +${added.join(",")}`);
    }
    const newTables = Object.keys(after.tables).filter((t) => !base.tables[t]);
    const newMigrations = after.migrations.filter((m) => !base.migrations.some((x) => x.migration_name === m.migration_name));
    console.log(JSON.stringify({ applicationTables: Object.keys(base.tables).filter((t) => t !== "_prisma_migrations").length, applicationRows: Object.entries(base.tables).filter(([t]) => t !== "_prisma_migrations").reduce((n, [, x]) => n + x.rows, 0), preserved: problems.length === 0, problems, newTables: newTables.length, existingTablesWithAddedColumns: changedCols, newMigrations: newMigrations.map((m) => `${m.migration_name}${m.applied ? "" : " (NOT applied)"}`), triggersBefore: base.triggers.length, triggersAfter: after.triggers.length }, null, 1));
    if (problems.length) process.exit(2);
    break;
  }
  case "grant-app": {
    const db = name(a); await assertMarked(db);
    await withDb(db, (c) => c.query(`GRANT CONNECT ON DATABASE ${db} TO finance_app;
      GRANT USAGE ON SCHEMA public TO finance_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO finance_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO finance_app;
      REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM finance_app;`));
    console.log(`finance_app granted DML only on ${db}`);
    break;
  }
  case "role-checks": {
    const db = name(a); await assertMarked(db);
    // Something to attempt a self-decision on: one pending request, created as the owner.
    const emp = await withDb(db, async (c) => (await c.query(`SELECT id FROM "Employee" ORDER BY "createdAt" LIMIT 1`)).rows[0].id);
    await withDb(db, (c) => c.query(`INSERT INTO "FinApprovalRequest" (id, type, "branchKey", "entityType", "entityId", summary, payload, "requiredSub", "requestedBy", status)
      VALUES ('rehearsal-req', 'BUDGET_APPROVAL', 'COMPANY', 'BudgetRevision', 'none', 'rehearsal', '{}'::jsonb, 'budget_approve', $1, 'PENDING') ON CONFLICT (id) DO NOTHING`, [emp]));
    // A row-level append-only trigger only proves something against a row that exists.
    await withDb(db, (c) => c.query(`INSERT INTO "FinAuditLog" (id, action, "entityType", "entityId") VALUES ('rehearsal-audit', 'rehearsal.check', 'Rehearsal', 'none') ON CONFLICT (id) DO NOTHING`));
    const checks = [
      ["TRUNCATE refused", `TRUNCATE "FinAuditLog"`],
      ["disabling triggers refused", `ALTER TABLE "FinApprovalRequest" DISABLE TRIGGER USER`],
      ["dropping a trigger refused", `DROP TRIGGER "FinApprovalRequest_guard" ON "FinApprovalRequest"`],
      ["session_replication_role refused", `SET session_replication_role = replica`],
      ["DDL on an existing table refused", `ALTER TABLE "Customer" ADD COLUMN rehearsal int`],
      ["dropping a table refused", `DROP TABLE "Customer"`],
      ["self-decision refused", `UPDATE "FinApprovalRequest" SET status='APPROVED', "decidedBy"="requestedBy", "decidedAt"=now() WHERE id='rehearsal-req'`],
      ["forged pre-approved request refused", `INSERT INTO "FinApprovalRequest" (id, type, "branchKey", "entityType", "entityId", summary, payload, "requiredSub", "requestedBy", status, "decidedBy", "decidedAt") VALUES ('forged', 'BUDGET_APPROVAL','COMPANY','BudgetRevision','none','x','{}'::jsonb,'budget_approve','a','APPROVED','b', now())`],
      ["deleting an audit row refused", `DELETE FROM "FinAuditLog" WHERE id='rehearsal-audit'`],
      ["editing an audit row refused", `UPDATE "FinAuditLog" SET action='tampered' WHERE id='rehearsal-audit'`],
    ];
    const results = [];
    await withDb(db, async (c) => {
      for (const [label, sql] of checks) {
        try { await c.query("BEGIN"); await c.query(sql); await c.query("ROLLBACK"); results.push({ check: label, refused: false }); }
        catch (e) { await c.query("ROLLBACK").catch(() => {}); results.push({ check: label, refused: true, error: String(e.message).slice(0, 90) }); }
      }
      const ok = await c.query(`SELECT count(*)::int n FROM "Customer"`);
      results.push({ check: "ordinary read works", refused: false, rows: ok.rows[0].n });
    }, "finance_app", env.FIN_LOCAL_PG_APP_PASSWORD);
    await withDb(db, (c) => c.query(`DELETE FROM "FinApprovalRequest" WHERE id='rehearsal-req'`).catch(() => {}));
    console.log(JSON.stringify(results, null, 1));
    // Every write above must be refused (by privilege or by trigger).
    if (results.slice(0, -1).some((r) => !r.refused)) process.exit(2);
    break;
  }
  default:
    console.error("usage: see header");
    process.exit(1);
}
