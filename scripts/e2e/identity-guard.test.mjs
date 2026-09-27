/**
 * Offline proof that the identity guard refuses what it claims to, and permits what the suites
 * actually do. Opens no connection and needs no database: `node scripts/e2e/identity-guard.test.mjs`.
 */
import { assertTestOwnedMutation, guardClient } from "./identity-guard.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}  << ${detail}`); }
};

const refuses = (name, sql, params = []) => {
  try { assertTestOwnedMutation(sql, params, "test"); check(name, false, "it was ALLOWED"); }
  catch (e) { check(name, /does not own/.test(e.message), e.message.split("\n")[0]); }
};
const permits = (name, sql, params = []) => {
  try { assertTestOwnedMutation(sql, params, "test"); check(name, true); }
  catch (e) { check(name, false, `refused: ${e.message.split("\n")[1]?.trim()}`); }
};

console.log("\n-- it refuses what would take a reviewer's access away");
refuses("a widened teardown pattern that happens to match RVW_",
  `DELETE FROM "Employee" WHERE id LIKE '%\\_emp\\_%'`);
refuses("a bare wildcard teardown",
  `DELETE FROM "Employee" WHERE id LIKE '%'`);
refuses("an unscoped delete",
  `DELETE FROM "Employee"`);
refuses("an unscoped update",
  `UPDATE "Employee" SET active = false`);
refuses("a truncate",
  `TRUNCATE "Employee"`);
refuses("naming a reserved id as a literal",
  `UPDATE "Employee" SET active=false WHERE id = 'RVW_emp_rep'`);
refuses("naming a reserved id as a bound parameter",
  `UPDATE "Employee" SET active=false WHERE id = $1`, ["RVW_emp_rep"]);
refuses("naming a reserved id inside a bound array",
  `DELETE FROM "Employee" WHERE id = ANY($1)`, [["UAT_emp_x", "RVW_emp_finance"]]);
refuses("changing a reserved account's PIN",
  `UPDATE "Employee" SET pin=$1, "pinLookup"=$2 WHERE id=$3`, ["x", "y", "RVW_emp_manager"]);
refuses("rewriting a reserved account's permissions",
  `UPDATE "Employee" SET permissions=$1 WHERE id LIKE 'RVW\\_%'`, ["{}"]);
refuses("removing a reserved commission assignment",
  `DELETE FROM "CommissionAssignment" WHERE "employeeId" LIKE 'RVW\\_%'`);
refuses("a pattern matching only the RVW plan rows",
  `DELETE FROM "CommissionPlan" WHERE id LIKE 'RVW%'`);

console.log("\n-- it permits what the suites legitimately do");
permits("the real fixture teardown",
  `DELETE FROM "Employee" WHERE id LIKE 'UAT\\_emp\\_%'`);
permits("a suite-prefixed teardown",
  `DELETE FROM "Employee" WHERE id LIKE 'H2A\\_%'`);
permits("deactivating a fixture account by id",
  `UPDATE "Employee" SET active = false WHERE id = $1`, ["UAT_emp_crmRep"]);
permits("seeding a fixture account",
  `INSERT INTO "Employee" (id,name) VALUES ($1,$2)`, ["UAT_emp_crmRep", "UAT Sales Rep"]);
permits("deleting a named list of suite ids",
  `DELETE FROM "Employee" WHERE id = ANY($1)`, [["CG_emp", "CG_emp2"]]);
permits("a read of any kind",
  `SELECT * FROM "Employee"`);
permits("a scoped read with a wide LIKE — reads are not mutations",
  `SELECT id FROM "Employee" WHERE id LIKE '%'`);
permits("mutating a non-identity table without a WHERE",
  `DELETE FROM "Lead"`);
permits("the commission teardown scoped to fixture employees",
  `DELETE FROM "CommissionAssignment" WHERE "employeeId" IN (SELECT id FROM "Employee" WHERE id LIKE 'UAT\\_emp\\_%')`);

console.log("\n-- the wrapper applies it to a real client surface");
{
  const calls = [];
  const fake = { query: (sql, params) => { calls.push([sql, params]); return Promise.resolve({ rows: [] }); }, other: 42 };
  const g = guardClient(fake, "test");
  await g.query(`DELETE FROM "Employee" WHERE id LIKE 'UAT\\_emp\\_%'`);
  check("a permitted statement reaches the client", calls.length === 1, String(calls.length));
  let threw = false;
  try { await g.query(`DELETE FROM "Employee" WHERE id LIKE '%'`); } catch { threw = true; }
  check("a refused statement never reaches the client", threw && calls.length === 1, `threw=${threw} calls=${calls.length}`);
  check("non-query properties pass through untouched", g.other === 42, String(g.other));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
