// Exercises scripts/accounting/verify-credential-rotation.mjs against the LOCAL disposable
// PostgreSQL only: every verdict path, the refusal of secrets on the command line, and that no
// password ever appears in the output. Run: npm run test:accounting:scripts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN || !/@(127\.0\.0\.1|localhost):\d+\//.test(ADMIN)) throw new Error("DATABASE_URL must be the local disposable server (.env.test).");
const { Client } = createRequire(import.meta.url)("pg");
const SCRIPT = path.resolve("scripts/accounting/verify-credential-rotation.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "rotation-"));
const pwA = "A" + randomBytes(12).toString("hex"), pwB = "B" + randomBytes(12).toString("hex");
const port = new URL(ADMIN).port;
const db = new URL(ADMIN).pathname.slice(1);
const url = (pw) => `postgresql://rot_probe:${pw}@127.0.0.1:${port}/${db}`;
const file = (name, s) => { const f = path.join(dir, name); writeFileSync(f, s, { mode: 0o600 }); return f; };
const targets = (list) => file(`t-${Math.random()}.json`, JSON.stringify(list));
const LIVE = { endpoint: "local-live", branch: "local", host: "127.0.0.1", port: Number(port), live: true };
const CLOSED = { endpoint: "local-closed-port", branch: "local", host: "127.0.0.1", port: 9 };
const run = (env, args = []) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ROTATION_TIMEOUT_MS: "3000", EXPECT_ENDPOINT_ID: "", EXPECT_USER: "rot_probe", EXPECT_DB: db, ...env }, encoding: "utf8" }); return { code: r.status, out: r.stdout + r.stderr }; };
let admin;
const dropProbe = async () => { if ((await admin.query("select 1 from pg_roles where rolname = 'rot_probe'")).rowCount) { await admin.query("DROP OWNED BY rot_probe"); await admin.query("DROP ROLE rot_probe"); } };
before(async () => { admin = new Client({ connectionString: ADMIN }); await admin.connect(); await dropProbe(); await admin.query(`CREATE ROLE rot_probe LOGIN PASSWORD '${pwA}'`); await admin.query(`GRANT CONNECT ON DATABASE "${db}" TO rot_probe`); });
after(async () => { await dropProbe(); await admin.end(); rmSync(dir, { recursive: true, force: true }); });

test("refuses secrets on the command line or directly in the environment", () => {
  assert.equal(run({ OLD_OWNER_URL_FILE: file("o", url(pwA)) }, [url(pwA)]).code, 64);
  assert.equal(run({ OLD_OWNER_URL: url(pwA) }).code, 64);
  assert.equal(run({ OLD_OWNER_URL_FILE: url(pwA) }).code, 64, "a URL in place of a file path");
});

test("old password still valid → FAIL (exit 1)", () => {
  const r = run({ OLD_OWNER_URL_FILE: file("old1", url(pwA)), ROTATION_TARGETS_FILE: targets([LIVE]) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL/);
  assert.ok(!r.out.includes(pwA));
});

test("after rotation: reachable endpoint rejecting with 28P01 → PASS; closed port → INCONCLUSIVE, never PASS", async () => {
  await admin.query(`ALTER ROLE rot_probe PASSWORD '${pwB}'`);
  const only = run({ OLD_OWNER_URL_FILE: file("old2", url(pwA)), NEW_OWNER_URL_FILE: file("new2", url(pwB)), ROTATION_TARGETS_FILE: targets([LIVE]) });
  assert.equal(only.code, 0, only.out);
  assert.match(only.out, /authentication rejected \(28P01\)/);
  assert.match(only.out, /server identity matches/);
  const mixed = run({ OLD_OWNER_URL_FILE: file("old3", url(pwA)), ROTATION_TARGETS_FILE: targets([LIVE, CLOSED]) });
  assert.equal(mixed.code, 2, "a network failure is inconclusive, not revocation");
  assert.match(mixed.out, /INCONCLUSIVE/);
  assert.match(mixed.out, /not reachable/);
  for (const r of [only, mixed]) { assert.ok(!r.out.includes(pwA) && !r.out.includes(pwB), "no password in output"); assert.ok(!/postgres(ql)?:\/\//.test(r.out), "no URL in output"); }
});

test("new credential on the wrong database → FAIL", () => {
  const r = run({ OLD_OWNER_URL_FILE: file("old4", url(pwA)), NEW_OWNER_URL_FILE: file("new4", url(pwB)), ROTATION_TARGETS_FILE: targets([LIVE]), EXPECT_DB: "some_other_db" });
  assert.equal(r.code, 1, r.out);
});
