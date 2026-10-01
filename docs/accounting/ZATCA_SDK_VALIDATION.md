# Official ZATCA SDK validation — status and handover

**Official SDK validation has not run.** The official SDK could not be obtained: every ZATCA host
was refused by this environment's network policy, re-checked 2026-10-01T08:14Z. No result below is
an official SDK result.

Done meanwhile:
- the application generates the six-document matrix;
- a harness with a real pass/fail gate and container isolation is ready;
- a **secondary** check (UBL schema and business-rule files from a third-party SDK copy) found
  defects, now fixed.

## 1. Six statuses, kept apart

| Status | State | Evidence / what is needed |
|---|---|---|
| 1. Local implementation and verification | **done locally**; full release gates green on the commit named in `TEST_RESULTS.md` | `TEST_RESULTS.md` |
| 2. Official SDK validation | **NOT DONE — blocked** (harness gate: NOT_RUN) | the official SDK archive (§2) |
| 3. ZATCA sandbox integration | **not done** | network access to `gw-fatoora.zatca.gov.sa`, developer-portal onboarding, a test CSID |
| 4. Independent technical review | **not done**; package prepared | `REVIEW_PACKAGE.md`; a reviewer |
| 5. Accountant acceptance | **not done**; scenarios prepared | `ACCOUNTANT_ACCEPTANCE.md`; the accountant |
| 6. Production readiness and release authorisation | **not ready, not authorised** | all of the above, plus `RELEASE_PROPOSAL.md` |

## 2. SDK provenance: not obtained

| Item | Value |
|---|---|
| Official page | https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Pages/DownloadSDK.aspx |
| Attempts | 2026-09-29, 2026-10-01T05:42Z, 2026-10-01T08:14Z: `CONNECT tunnel failed, response 403` (environment egress proxy) for zatca.gov.sa, sandbox.zatca.gov.sa and gw-fatoora.zatca.gov.sa — `evidence/zatca/access-attempts-*.txt` |
| Download URL, time, version, SHA-256, Java requirement | **unknown** — not downloaded |
| Third-party copy | `github.com/aashahin/zatca-sdk` @ 7ed2964 redistributes `zatca-einvoicing-sdk-238-R3.4.8`. It is **not** an authenticated official download and was **not executed**. Only its data files (UBL XSD, rule XSLs) were used, for the secondary check in §5, with their SHA-256 recorded |

**Input needed (one of):**
1. allow `zatca.gov.sa` in this environment's Network access settings (cloud environment menu →
   Edit). `sandbox.zatca.gov.sa` and `gw-fatoora.zatca.gov.sa` are needed later for the sandbox;
2. download the SDK zip from the official page and upload it here, together with:
   - the exact download URL;
   - the download time;
   - its SHA-256 computed on your machine.

The SHA-256 verifies the file's integrity against that value. The URL is recorded as your statement
of origin: the harness cannot authenticate it.

## 3. Harness: `scripts/accounting/zatca-sdk/harness.mjs`

`zatca-sdk-validate.sh` is a thin wrapper around it.

**Evidence and gate are separate.** It always records all six documents × two checks (`validate`;
`generateHash` compared with the application hash), then decides:

| Exit | Decision | When |
|---|---|---|
| 0 | PASS | all twelve checks PASS (requires a confirmed output profile) |
| 1 | FAIL | any precondition or check fails: archive hash, unsafe archive entry, missing or corrupted document, SDK command exit ≠ 0, global result not passed, SDK hash ≠ application hash |
| 3 | BLOCKED / NOT_RUN | the SDK is missing, a command is not documented in the archive's readme, Java is outside the readme's range, or output cannot be interpreted reliably |

**Before execution:**
- **Matrix:** exactly the six required documents, verified against `SHA256SUMS`, with nothing extra.
- **Archive:** entries listed with `zipinfo` and refused if any is absolute, contains `..` or a
  backslash, or is a link or device; links are checked again after extraction.
- **Readme:** the commands must appear verbatim in the archive's readme, and the readme's Java range
  is enforced.

**Interpretation:**
- The SDK readme seen documents only that validation prints "PASS" or "NOT PASS"; it gives no exact
  output format for either command. So `scripts/accounting/zatca-sdk/output-profile.json` starts
  **unconfirmed**, and every result is BLOCKED until someone confirms the line formats against
  official SDK output.
- An exit code of 0 is never taken as a pass on its own.
- With a confirmed profile, exactly one global-result line and exactly one hash line must match;
  anything else is BLOCKED.
- The hash comparison is an exact equality of the parsed base64 value, not a substring search.

**Isolation:**
- **Container:** each command runs in a fresh container of `zatca-sdk-runner:11`, built from
  `scripts/accounting/zatca-sdk/Dockerfile`. The base is `eclipse-temurin:11-jre@sha256:717e7ce1…`,
  plus `jq` and `unzip`, running as uid 10001.
- **Container restrictions:**
  - `--network none` and a read-only root;
  - `--cap-drop ALL` and `no-new-privileges`;
  - pids and memory limits;
  - the SDK and the matrix mounted **read-only**;
  - a tmpfs work directory, and one writable output directory.
- **What it does not mount:** no Docker socket, no host secrets, no repository and no `.env`.
- **Inside the container:** the SDK's `install.sh` runs in the tmpfs copy, so it cannot modify the
  host.
- **Direct runner:** `--runner direct` exists only for harness tests and is always recorded
  `official: false`.

**Outputs:**
- raw `stdout`/`stderr`, argv, exit code and start/finish times per command;
- input checksums, the SDK jar hashes and the Java version;
- `summary.json` (machine-readable) and `SUMMARY.md`.

**Harness tests:** `tests/accounting/harness/zatca-sdk-harness.test.mjs`, 13 tests, part of the
release gates. They cover:
- success, SDK failure, hash mismatch, a missing document and corrupted input;
- unrecognised output and an unconfirmed profile;
- a wrong archive hash, no archive, an undocumented command, and traversal or symbolic-link entries;
- one run of the stub inside the real container.

They use a **stub SDK** and are **harness tests, not SDK validation**.

**Current run:** `evidence/zatca/harness-<commit>/` → **NOT_RUN**, exit 3 (no archive).

## 4. Application-generated matrix

Generated by the application's own services on the disposable `erp_finance_zatca` at commit `031daaf`
(clean tree: `workingTreeDirty: false`; one untracked file, the run's migration log). Fixture
`zatca-matrix-v1`, synthetic identities. The content covers:
- Arabic text;
- discounts of 10 %, 2.5 % and 5 %;
- four-decimal prices;
- S, Z and E categories;
- supply dates on the standard documents.

Directory: `evidence/zatca/matrix-031daaf/`.

| Document | Type/subtype | ICV | XML sha256 | QR sha256 | Application hash |
|---|---|---|---|---|---|
| standard-invoice | 388/0100000 | 1 | `3c62385e73e8469d…` | `491e28da4e95c501…` | `yQWe7vcoejPNNI5G9h8BItXEfsKZXMjL2C9Yc8OTb3w=` |
| standard-credit-note | 381/0100000 | 2 | `737f75a2508da7c6…` | `c4fc81cad8ac2047…` | `XUh64ofnT+zW+p9GnR3FuPoXtnPFUgzTa03PXCuR5QA=` |
| standard-debit-note | 383/0100000 | 3 | `da035240b2bc8165…` | `7f8260f84ba9a3f1…` | `0v5KOiMyYgZdP3IE/No7TuLf25rFHsOic/847wt18FQ=` |
| simplified-invoice | 388/0200000 | 4 | `024ffd82755c9d9e…` | `6f44239caaae1b22…` | `v65MK/4JjFzrYFGqzRDr8bx7qtp9Wqp5mlFYg6UFkCw=` |
| simplified-credit-note | 381/0200000 | 5 | `07f8597696ac202b…` | `030fbd80fe8dd321…` | `UJ/aLUo/aTBuJXZdXlHA6hkKyCwAWcJnRaWcnlKwz50=` |
| simplified-debit-note | 383/0200000 | 6 | `1e3a2cc79011f732…` | `3fca2b1845039c71…` | `qW8Afd4M+d+5M1v9Nxj4sdTVGaNuIVyC1iFZw8hki80=` |

**Signing and certificate profile:**
- *Standard documents:* not signed by us.
- *Simplified documents:* LOCAL test key, ECDSA secp256k1. This is not XAdES and not a ZATCA
  certificate, and there is no QR tag 9.

## 5. Secondary check — NOT official validation

Script: `scripts/accounting/zatca-secondary-check.sh`. Evidence: `evidence/zatca/secondary-031daaf/`
(`provenance.txt` lists the SHA-256 of every schema, rule and tool file). It:
- validates against the UBL 2.1 Invoice XSD (xmllint);
- runs the EN 16931 and ZATCA rule XSLs with Saxon-HE 12.5 (from Maven Central, checksum-verified) in
  the no-network container.

The schema and rule files come from the **third-party copy**, so this is developer evidence about
our documents, not official validation.

**Before the fixes** (matrix `19f3639`):

| Finding | Where | Fix (commit `031daaf`) |
|---|---|---|
| XSD error: `cac:AllowanceCharge` missing `cbc:Amount` | every document with a discount | line-level allowance with `Amount` and `BaseAmount` |
| XSD error: `ExtensionURI` in the `cbc` namespace | simplified documents (local signature block) | `ext:ExtensionURI` |
| BR-KSA-EN16931-04 (warning): percentage without base amount | discounted lines | `BaseAmount` |
| BR-KSA-EN16931-11 (warning): line net ≠ quantity × price − allowances | discounted lines | allowance at line level; unit price keeps 4 decimals (it was rounded to 2) |
| BR-KSA-15 (warning): standard 388 without supply date | standard invoice | local warning `LOCAL-SUPPLY-DATE` (non-blocking); fixture and matrix carry supply dates |

**After the fixes** (matrix `031daaf`):

| Document | XSD | Rule findings |
|---|---|---|
| standard invoice, credit note, debit note | valid | none |
| simplified invoice, credit note, debit note | valid | **BR-KSA-28 (error)**: the cryptographic stamp must carry signature information ID `urn:oasis:names:specification:ubl:signature:1`; **BR-KSA-29 (warning)**: referenced signature ID `…:signature:Invoice` |

BR-KSA-28/29 concern the XAdES signature block, which is not implemented (§6). They were not
silenced by inserting the identifiers into the local test block: that would satisfy the rule's text
without a signature the SDK could verify.

**Canonicalisation:**
- the invoice hash is now SHA-256 of the canonical form: no XML declaration, C14N text escaping,
  attributes in canonical order;
- a unit test compares it byte for byte with `xmllint --c14n11`. That comparison found the attribute
  order defect;
- equality with ZATCA's hash is unconfirmed until `fatoora -generateHash` is compared.

## 6. Open items that need the official SDK or documents

1. **XAdES signing:** `SignedInfo`, `SignedProperties`, the certificate digest, the two References and
   their transforms. The rule files check only fixed identifiers. ZATCA's digest conventions for
   `SignedProperties` and the certificate could not be confirmed from an official source, and a
   generic XMLDSig verifier would not confirm them either. Not implemented: **blocked on the official
   documents or SDK.**
2. **QR tags 6–8:** they follow the official documents as cited by the owner (32-byte hash, P1363
   signature, 64-byte key). This conflicts with the third-party samples. Tag 9 needs a ZATCA
   certificate.
3. **Curve and certificate profile:** secp256k1 is used; the illustrative profile in the security
   standard lists P-256.
4. **Exemption codes:** VATEX-SA-32 and VATEX-SA-29 are synthetic test choices.
5. **Standard versus simplified:** whether the taxpayer stamps standard invoices before clearance.

## 7. Issued documents and the hash change

E-invoice rows are immutable (database trigger). Documents issued before `031daaf` keep their stored
XML and hash:
- the chain continues from each stored hash;
- re-validating such a document reports `LOCAL-HASH` with the detail "issued with the earlier hash
  method", and the QR rules report the earlier layout;
- nothing is regenerated.

Production has no e-invoices. Test databases are rebuilt from scratch, and no test document is to
be migrated.
