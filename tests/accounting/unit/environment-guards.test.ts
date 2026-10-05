// Environment guards: the preview target (URL + server identity) and the URL classifier used in
// the credential-incident procedure. Run: npm run test:accounting:unit
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isPreviewTarget, identityProblems, neonMetadataProblems, assertNeonMetadata, PREVIEW } from "../../../scripts/accounting/preview-target.mjs";
import { classifyUrl } from "../../../scripts/accounting/classify-db-urls.mjs";

const ok = { db: PREVIEW.database, project: PREVIEW.project, branch: PREVIEW.branch, endpoint: PREVIEW.endpoint, marker: PREVIEW.marker };

describe("preview target", () => {
  test("URL guard needs the preview endpoint, database and explicit env confirmation", () => {
    const url = "postgresql://x:y@ep-plain-field-awqkif28-pooler.c-12.us-east-1.aws.neon.tech/accounting_preview";
    delete process.env.ACCOUNTING_PREVIEW_DB;
    assert.equal(isPreviewTarget(url), false);
    process.env.ACCOUNTING_PREVIEW_DB = "accounting_preview";
    assert.equal(isPreviewTarget(url), true);
    assert.equal(isPreviewTarget(url.replace("accounting_preview", "neondb")), false);
    assert.equal(isPreviewTarget("postgresql://x:y@ep-dawn-dust-aqn1u1uf.c-8.us-east-1.aws.neon.tech/accounting_preview"), false);
    assert.equal(isPreviewTarget("postgresql://x:y@ep-rapid-rain-aq9ft4ev.c-8.us-east-1.aws.neon.tech/accounting_preview"), false, "backup branch of production (added 2026-10-01)");
    assert.equal(isPreviewTarget("not a url"), false);
    // exact host only: a look-alike host with the endpoint id as a prefix is refused
    assert.equal(isPreviewTarget("postgresql://x:y@ep-plain-field-awqkif28.evil.example.com/accounting_preview"), false);
    assert.equal(isPreviewTarget("postgresql://x:y@ep-plain-field-awqkif28.c-12.us-east-1.aws.neon.tech/accounting_preview"), true);
  });

  test("server identity: every id must match; production project is named explicitly", () => {
    assert.deepEqual(identityProblems(ok), []);
    assert.equal(identityProblems(undefined).length, 1);
    const prod = identityProblems({ ...ok, project: "dark-lab-61530722", branch: "br-weathered-bread-aqais7hp", endpoint: "ep-dawn-dust-aqn1u1uf" });
    assert.ok(prod.includes("server reports the PRODUCTION project"));
    assert.equal(identityProblems({ ...ok, branch: "br-other" }).length, 1);
    assert.equal(identityProblems({ ...ok, endpoint: "ep-other" }).length, 1);
    assert.equal(identityProblems({ ...ok, db: "neondb" }).length, 1);
    assert.equal(identityProblems({ ...ok, marker: null }).length, 1);
    // a local server without Neon settings (null ids) is refused
    assert.equal(identityProblems({ ...ok, project: null, branch: null, endpoint: null }).length, 3);
  });
});

describe("URL classifier (credential incident)", () => {
  test("classifies by endpoint id, flags the production owner credential, never returns the password", () => {
    const c = classifyUrl("postgresql://neondb_owner:SECRET123@ep-dawn-dust-aqn1u1uf-pooler.c-8.us-east-1.aws.neon.tech/neondb")!;
    assert.equal(c.cls, "PRODUCTION-LIVE");
    assert.equal(c.ownerCredential, true);
    assert.equal(c.pooled, true);
    assert.equal(c.password, "present");
    assert.ok(!JSON.stringify(c).includes("SECRET123"));
    const app = classifyUrl("postgresql://erp_app:x@ep-dawn-dust-aqn1u1uf-pooler.c-8.us-east-1.aws.neon.tech/neondb")!;
    assert.equal(app.ownerCredential, false);
    assert.equal(app.production, true);
    assert.equal(classifyUrl("postgresql://a:b@ep-plain-field-awqkif28.c-2.us-east-2.aws.neon.tech/accounting_preview")!.production, false);
    assert.equal(classifyUrl("https://example.com"), null);
    assert.match(classifyUrl("postgresql://a:b@ep-new-thing-abc123.aws.neon.tech/x")!.cls, /UNKNOWN NEON/);
  });
});

const HOST = "ep-plain-field-awqkif28.c-12.us-east-1.aws.neon.tech";
const goodEp = { id: PREVIEW.endpoint, project_id: PREVIEW.project, branch_id: PREVIEW.branch, host: HOST, hosts: { read_write_host: HOST, read_write_pooled_host: HOST.replace(".c-12", "-pooler.c-12") } };
const goodDbs = [{ name: "accounting_preview" }, { name: "neondb" }];

describe("Neon control-plane cross-check (authoritative identity)", () => {
  test("pure check: every id, host and the database must match the allowlist", () => {
    assert.deepEqual(neonMetadataProblems(HOST, goodEp, goodDbs), []);
    assert.deepEqual(neonMetadataProblems(goodEp.hosts.read_write_pooled_host, goodEp, goodDbs), []);
    assert.ok(neonMetadataProblems("ep-other.aws.neon.tech", goodEp, goodDbs)[0].includes("allowlist"));
    assert.ok(neonMetadataProblems(HOST, { ...goodEp, project_id: "dark-lab-61530722" }, goodDbs).some((p) => p.includes("PRODUCTION")));
    assert.ok(neonMetadataProblems(HOST, { ...goodEp, branch_id: "br-other" }, goodDbs).length > 0);
    assert.ok(neonMetadataProblems(HOST, { ...goodEp, host: "x", hosts: {} }, goodDbs).some((p) => p.includes("host")));
    assert.ok(neonMetadataProblems(HOST, goodEp, [{ name: "neondb" }]).some((p) => p.includes("not found")));
    assert.equal(neonMetadataProblems(HOST, undefined, goodDbs).length, 1);
  });

  test("fails closed: no key, unreachable API, error status, or mismatching metadata", async () => {
    const url = `postgresql://x:y@${HOST}/accounting_preview`;
    const saved = { key: process.env.NEON_API_KEY, base: process.env.NEON_API_BASE };
    try {
      delete process.env.NEON_API_KEY;
      await assert.rejects(assertNeonMetadata(url), /NEON_API_KEY is not set/);
      process.env.NEON_API_KEY = "test-key-not-real";
      process.env.NEON_API_BASE = "http://127.0.0.1:9/api/v2";
      await assert.rejects(assertNeonMetadata(url), /unreachable/);
      let mode = "ok";
      const srv = createServer((req, res) => {
        if (req.headers.authorization !== "Bearer test-key-not-real") { res.writeHead(401).end(); return; }
        if (mode === "500") { res.writeHead(500).end(); return; }
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith(`/endpoints/${PREVIEW.endpoint}`)) res.end(JSON.stringify({ endpoint: mode === "prod" ? { ...goodEp, project_id: "dark-lab-61530722" } : goodEp }));
        else if (req.url?.endsWith("/databases")) res.end(JSON.stringify({ databases: goodDbs }));
        else res.writeHead(404).end();
      });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      const port = (srv.address() as { port: number }).port;
      process.env.NEON_API_BASE = `http://127.0.0.1:${port}/api/v2`;
      assert.deepEqual(await assertNeonMetadata(url), { project: PREVIEW.project, branch: PREVIEW.branch, endpoint: PREVIEW.endpoint });
      mode = "500"; await assert.rejects(assertNeonMetadata(url), /answered 500/);
      mode = "prod"; await assert.rejects(assertNeonMetadata(url), /PRODUCTION/);
      srv.close();
    } finally {
      if (saved.key === undefined) delete process.env.NEON_API_KEY; else process.env.NEON_API_KEY = saved.key;
      if (saved.base === undefined) delete process.env.NEON_API_BASE; else process.env.NEON_API_BASE = saved.base;
    }
  });
});
