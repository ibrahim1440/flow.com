// The fixture/reset guard refuses everything except the explicitly marked disposable DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUrl, assertDisposableFinanceDb, MARKER } from "../../../scripts/finance/local-db-guard.mjs";

const ok = "postgresql://u:p@127.0.0.1:54329/erp_finance_dev";
const env = { FIN_DISPOSABLE_DB: "erp_finance_dev" };

test("accepts only the declared local disposable database", () => {
  assert.deepEqual(checkUrl(ok, "erp_finance_dev", env), []);
});

test("refuses shared endpoints, hosted providers, other hosts, ports and names", () => {
  const cases = [
    "postgresql://u:p@ep-dawn-dust-aqn1u1uf-pooler.c-8.us-east-1.aws.neon.tech/neondb",
    "postgresql://u:p@ep-icy-field-aq4upc3z.us-east-1.aws.neon.tech:5432/erp_finance_dev",
    "postgresql://u:p@db.example.supabase.co:5432/erp_finance_dev",
    "postgresql://u:p@10.0.0.5:54329/erp_finance_dev",
    "postgresql://u:p@127.0.0.1:5432/erp_finance_dev",
    "postgresql://u:p@127.0.0.1:54329/neondb",
    "file:./prisma/dev.db",
  ];
  for (const c of cases) assert.ok(checkUrl(c, "erp_finance_dev", env).length > 0, c);
});

test("NODE_ENV is irrelevant; the operator must declare the exact database", () => {
  assert.ok(checkUrl(ok, "erp_finance_dev", { NODE_ENV: "development" }).length > 0);
  assert.ok(checkUrl(ok, "erp_finance_dev", { FIN_DISPOSABLE_DB: "erp_finance_test" }).length > 0);
  assert.ok(checkUrl(ok, "erp_finance_test", env).length > 0, "expected DB mismatch");
});

test("the server-side marker is required", async () => {
  await assert.rejects(assertDisposableFinanceDb({ url: ok, expectedDb: "erp_finance_dev", env, query: async () => [{ db: "erp_finance_dev", marker: null }] }), /not marked/);
  await assert.rejects(assertDisposableFinanceDb({ url: ok, expectedDb: "erp_finance_dev", env, query: async () => [{ db: "other", marker: MARKER }] }), /does not match/);
  await assertDisposableFinanceDb({ url: ok, expectedDb: "erp_finance_dev", env, query: async () => [{ db: "erp_finance_dev", marker: MARKER }] });
});
