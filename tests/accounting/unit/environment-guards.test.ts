// Environment guards: the preview target (URL + server identity) and the URL classifier used in
// the credential-incident procedure. Run: npm run test:accounting:unit
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isPreviewTarget, identityProblems, PREVIEW } from "../../../scripts/accounting/preview-target.mjs";
import { classifyUrl } from "../../../scripts/accounting/classify-db-urls.mjs";

const ok = { db: PREVIEW.database, project: PREVIEW.project, branch: PREVIEW.branch, endpoint: PREVIEW.endpoint, marker: PREVIEW.marker };

describe("preview target", () => {
  test("URL guard needs the preview endpoint, database and explicit env confirmation", () => {
    const url = "postgresql://x:y@ep-plain-field-awqkif28-pooler.c-2.us-east-2.aws.neon.tech/accounting_preview";
    delete process.env.ACCOUNTING_PREVIEW_DB;
    assert.equal(isPreviewTarget(url), false);
    process.env.ACCOUNTING_PREVIEW_DB = "accounting_preview";
    assert.equal(isPreviewTarget(url), true);
    assert.equal(isPreviewTarget(url.replace("accounting_preview", "neondb")), false);
    assert.equal(isPreviewTarget("postgresql://x:y@ep-dawn-dust-aqn1u1uf.c-8.us-east-1.aws.neon.tech/accounting_preview"), false);
    assert.equal(isPreviewTarget("not a url"), false);
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
