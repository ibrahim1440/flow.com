# Saudi localisation — requirements matrix

**Status: e-invoices are generated and checked LOCALLY. Nothing has been sent to ZATCA (not the
sandbox or simulation, not production) or to any customer. No document has been validated by ZATCA's
SDK or the Fatoora platform, and no compliance is claimed.** A QR code, or a document that passes
our local checks, is not compliance. Design: `STAGE_6_DESIGN.md`. Evidence: `STAGE_5_6_EVIDENCE.md`.
Review date: 2026-09-29.

## 1. Two kinds of test, never mixed

| Kind | What it shows | What it does not show |
|---|---|---|
| **Local self-consistency** (`einvoice.test.ts`, `tax.test.mjs`, `tax-forms.mjs`, `einvoice-pure.test.ts`) | our generator, chain, rules and screens agree with each other and with our reading of the standard | that the reading is right |
| **Independent local checks** (`einvoice-qr-independent.test.ts`) | QR bytes equal TLV sequences written out by hand for both layouts; tag 8 equals X‖Y of d·G computed from SEC 2 constants; tag 7 equals r‖s from a DER signature parsed by hand; the QR's own tags verify under a local ECDSA verifier (BigInt); P1363 padding on hand-made DER; SHA-256 test vector | that ZATCA accepts the layout. These tests encode implementation assumptions and do not validate official conformance |
| **Secondary checks** (`zatca-secondary-check.sh`) | our XML against the UBL 2.1 XSD and the EN 16931 / ZATCA business-rule files of a third-party SDK copy (provenance unverified; checksums recorded) — all six documents XSD-valid; remaining rule findings BR-KSA-28/29 on simplified documents (XAdES) | official conformance — the files are not authenticated and the SDK itself (signature, hash, QR checks) did not run |
| **Official standards validation** (ZATCA SDK, Fatoora sandbox/simulation) | conformance | — **not done: blocked (§2)**; harness ready (`ZATCA_SDK_VALIDATION.md` §3) |

## 2. Official sources and validator: access evidence

Every official host is refused by this environment's network policy (the proxy answers 403 to
CONNECT), re-checked on 2026-10-01T05:42Z and 08:14Z. Nothing was worked around. Raw attempts:
`evidence/zatca/access-attempts-2026-09-29.txt`, `access-attempts-2026-10-01.txt`. The SDK run that
is ready to go (application-generated six-document matrix, harness, Java 11) and the six separate
statuses (developer verification → production readiness) are in `ZATCA_SDK_VALIDATION.md`.
The two "opened via web retrieval" rows below record the owner's retrieval and line references; web
retrieval from this environment was also attempted on 2026-09-29 and returned `EGRESS_BLOCKED`, so
those lines were **not re-read here**. The implementation follows them as cited.

| Source | URL | Result |
|---|---|---|
| Security Features Implementation Standards v1.2 | zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf | Opened via web retrieval; §4.1 specifies tag 6 as 32 bytes (PDF lines 723–725) |
| Detailed E-Invoicing Guidelines | zatca.gov.sa/en/e-invoicing/introduction/guidelines/documents/e-invoicing_detailed__guideline.pdf | 403 (egress) |
| Developer Portal User Manual | zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Documents/Developer%20Portal%20User%20Manual.pdf | Opened via web retrieval; lines 946–966 specify 64-byte public key BLOB and IEEE P1363 ECDSA signature |
| SDK download page | zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Pages/DownloadSDK.aspx | 403 (egress) — **official SDK not obtained, not run** |
| Sandbox / gateway | sandbox.zatca.gov.sa, gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal | 403 (egress) |

A web search restricted to zatca.gov.sa returned index snippets only, not the documents:
- QR tags: 6 "hash of XML invoice", 7 "ECDSA signature", 8 "ECDSA public key", and 9 "for simplified
  tax invoices and their associated notes, the ECDSA signature of the cryptographic stamp's public
  key by ZATCA's technical CA", all effective 2023-01-01.
- TLV encoding: the length is the byte length of the value.
- From ZATCA's SDK notes: "the Java SDK (JAR) will run on JDK versions >=11 and <15, to comply with
  secp256k1 as per ZATCA".

To unblock, choose one:
- allow `zatca.gov.sa`, `sandbox.zatca.gov.sa` and `gw-fatoora.zatca.gov.sa` in this environment's
  Network access settings (cloud environment menu → Edit);
- run the SDK on a machine that can download it from zatca.gov.sa.

## 3. QR code: official requirements and implementation

| Tag | Before (da37cb0) | Now | Evidence | Open |
|---|---|---|---|---|
| 1–5 | UTF-8 TLV | unchanged | hand-built bytes, including an Arabic name counted in UTF-8 bytes; the published phase-1 example | — |
| 6 hash | base64 text (44 bytes) | **default `OFFICIAL_DOCS` = the 32-byte SHA-256 value**; alternate `SDK_SAMPLE_TEXT` = 44-byte Base64 text (secondary evidence only) | official Security Features standard §4.1 requires the 32-byte SHA-256 value | validate with the official SDK |
| 7 signature | Base64 text of DER signature | **default: IEEE P1363 r‖s, 64 bytes** (converted from the DER signature, each integer left-padded to 32 bytes); alternate: Base64 text of DER (96 bytes) | official Developer Portal Manual lines 956–966 specifies IEEE P1363; 256-bit example is 64 bytes | validate with the official SDK |
| 8 public key | raw DER SPKI | **default: the 64-byte public key X‖Y** (no 0x04 prefix, no framing); alternate: DER SPKI (88 bytes) | official manual lines 946–950 describes 64-byte public key BLOB (72 with some system framing) | the 72-byte framed form is not produced; validate with the official SDK |
| 9 CA signature | absent | absent; listed on the screen as a standards gap | needs a ZATCA certificate | **cannot be produced without ZATCA** |
| curve | secp256k1 | secp256k1, enforced (unchanged; listed on screen as still to be confirmed) | official manual names secp256k1 as an example for 256-bit curves; Security Standard's illustrative certificate profile lists P-256 at lines 369–370 | confirm currently applicable curve/profile using official SDK and onboarding |

**Official-source finding.** The primary standard explicitly specifies tag 6 as the 32-byte
SHA-256 value. The official portal manual specifies a P1363 ECDSA signature (r||s; 64 bytes for a
256-bit curve) and a 64-byte public-key BLOB (sometimes 72 bytes with framing). The default at
`74d4b03` (44-byte Base64 hash, DER signature, 88-byte DER SPKI) therefore did not match those
documented encodings; it has been corrected (default `OFFICIAL_DOCS`, see "Decision" below). The third-party SDK-copy samples are secondary evidence and do not override the official
documents.

- **Source:** a third-party GitHub repository, `github.com/aashahin/zatca-sdk` at commit 7ed2964,
  cloned earlier in this work, redistributes `zatca-einvoicing-sdk-Java-238-R3.4.8`. The jar's
  SHA-256 starts `48abeb82…ffd5e30`; the full value is in `evidence/zatca/sdk-sample-qr-layout.txt`.
- **Layout in all 19 sample invoices** in its `Data/Samples` (simplified and standard, invoices and
  notes):
  - tag 6 is the 44-byte base64 text of the 32-byte hash, equal to the invoice `ds:DigestValue`;
  - tag 7 is the 96-byte base64 text of the DER signature, equal to `ds:SignatureValue`;
  - tag 8 is the 88-byte DER SPKI;
  - on simplified documents, tag 9 is a 71-byte DER signature.
- **Status of that copy:** its provenance cannot be checked against ZATCA's download, which is
  blocked. So it was **not executed**, it is **not** treated as the official validator, and its
  samples are unofficial secondary evidence only.
- **Decision:** the third-party samples do not justify a default. The code now follows the official
  documents as cited: tags 6–8 default to `OFFICIAL_DOCS` (32-byte hash, 64-byte P1363 signature,
  64-byte X‖Y public key), and the local rules (`LOCAL-QR-HASH`, `LOCAL-QR-STAMP`) check that layout,
  including that tag 7 verifies over tag 6 with the tag 8 key. The SDK-sample layout remains as the
  alternate `SDK_SAMPLE_TEXT` (`QR_ENCODING` in `src/lib/accounting/einvoice/ubl.ts`). Run the
  official SDK before enabling or releasing e-invoicing.
- **Still open:** verify exact current SDK behavior and applicable curve/certificate profile using
  the official SDK. Passing the SDK is validation evidence, not ZATCA acceptance or production approval.

## 4. Requirements

| Area | Requirement | Local status | What is still needed (external) |
|---|---|---|---|
| 1.1 Documents | Standard (B2B) and simplified (B2C) invoices, credit notes (381) and debit notes (383) with the original's reference and a reason | implemented, local tests | SDK validation of the XML |
| 1.2 Data | Seller VAT/CR/national address; buyer VAT and address for standard invoices; UUID; issue date/time | implemented; seller data approved by someone else | the company's real seller data (fixture values are synthetic) |
| 1.3 Chain | ICV per EGS, previous-invoice hash | gapless under concurrency, DB-guarded; initial PIH per our reading (unverified) | SDK validation |
| 1.4 XML | UBL 2.1 per the XML Implementation Standard | XSD-valid against the UBL 2.1 schema (third-party copy of the schema files); line allowances with amount and base amount; supply date on standard invoices; **official validation not run** | SDK validation |
| 1.5 Hash / stamp | canonicalised hash; XAdES stamp with a CSID | hash = SHA-256 of the canonical form, byte-equal to `xmllint --c14n11` (test); ECDSA secp256k1 with a **local test key**, not XAdES, not a CSID; BR-KSA-28/29 (secondary rule files) fire on simplified documents | XAdES per the official documents; equality with `fatoora -generateHash`; compliance CSID |
| 1.6 QR | TLV base64, phase-2 tags | §3: tags 6–8 now use the encodings the official documents specify as cited (32-byte hash, P1363 signature, 64-byte key); tag 9 absent | certificate; curve/profile confirmation; SDK validation |
| 1.7 Rules | BR-KSA business rules | 20+ local checks (`LOCAL-*`), not the official codes | official data dictionary; mapping to BR-KSA |
| 1.8 Clearance / reporting | standard invoices cleared before sharing; simplified reported within 24 h | production refused; LOCAL_ONLY records "not sent"; SANDBOX only to a local stub or ZATCA's developer-portal / simulation paths; retries with back-off; append-only attempts | network access to gw-fatoora, test CSID, compliance invoice set |
| 1.9 Retention / audit | XML and responses kept; who did what | immutable e-invoice rows, append-only attempts, audit entries | retention period policy |
| 1.10 Standards status on screen | the user sees that a document is not standards-compliant | detail lists: not SDK-validated; local key (not a CSID); QR encodings follow the documents as cited but are unconfirmed, curve/profile to confirm; tag 9 absent — `tax-forms.mjs` (browser) | — |
| 2. VAT return | boxes by period; credit notes; reconciliation | from posted documents, reconciled to output/input VAT with an unexplained remainder | box numbering against the official form; exports, imports, reverse charge, corrections and carried-forward credit not modelled |
| 3. Zakat | zakat base and filing | **not implemented** | professional input |
