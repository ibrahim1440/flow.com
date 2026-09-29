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
| **Independent local checks** (`einvoice-qr-independent.test.ts`) | QR bytes equal TLV sequences written out by hand; the public key equals an SPKI built byte by byte from the SEC 2 secp256k1 constants; signatures are DER and verify under an ECDSA verifier written in the test (BigInt, no `node:crypto`); SHA-256 against the FIPS 180-2 "abc" vector | that ZATCA accepts the layout — both layouts in §3 pass these |
| **Official standards validation** (ZATCA SDK, Fatoora sandbox/simulation) | conformance | — **not done: blocked (§2)** |

## 2. Official sources and validator: access evidence

Every official host is refused by this environment's network policy (the proxy answers 403 to
CONNECT). Nothing was worked around. Raw attempts: `evidence/zatca/access-attempts-2026-09-29.txt`.

| Source | URL | Result |
|---|---|---|
| Security Features Implementation Standards v1.2 | zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf | 403 (egress) |
| Detailed E-Invoicing Guidelines | zatca.gov.sa/en/e-invoicing/introduction/guidelines/documents/e-invoicing_detailed__guideline.pdf | 403 (egress) |
| Developer Portal User Manual | zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Documents/Developer%20Portal%20User%20Manual.pdf | 403 (egress) |
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

## 3. QR code: findings and current state

| Tag | Before (da37cb0) | Now | Evidence | Open |
|---|---|---|---|---|
| 1–5 | UTF-8 TLV | unchanged | hand-built bytes, including an Arabic name counted in UTF-8 bytes; the published phase-1 example | — |
| 6 hash | base64 text (44 bytes) | the layout is an explicit choice, `QR_ENCODING`: default **SDK_SAMPLE_TEXT** = base64 text (44 bytes); alternative **RAW_BYTES** = 32 raw bytes | see below | **which layout ZATCA requires** |
| 7 signature | base64 text of the DER signature, signed over SHA-256 of the hash's base64 *text* | same default layout (96 bytes), or raw DER under RAW_BYTES; the signature is now over the 32 hash *bytes* | DER structure parsed by hand and verified by the independent verifier | XAdES: the real stamp signs `SignedInfo`, not the hash — not implemented |
| 8 public key | raw DER SPKI | unchanged; the key must be secp256k1 (other curves refused) | SPKI equals the hand-built 88 bytes for d = 1 (the generator G) and another synthetic scalar | — |
| 9 CA signature | absent | absent; listed on the screen as a standards gap | needs a ZATCA certificate | **cannot be produced without ZATCA** |
| curve | secp256k1 | secp256k1, enforced | ZATCA SDK notes (search snippet above); `ec-secp256k1-priv-key.pem` in the SDK copy's configuration | — |

**The tag 6 finding.** The review said the standard specifies the 32-byte SHA-256 value. The only
byte-level artefact available here disagrees.

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
- **Decision:** on that evidence the default was set back to the text layout. The 32-byte reading
  is kept as the `RAW_BYTES` alternative, with its own tests.
- **Still open:** which layout is correct stays unresolved until the official SDK validates our
  output. Switching is one constant, `QR_ENCODING` in `src/lib/accounting/einvoice/ubl.ts`.

## 4. Requirements

| Area | Requirement | Local status | What is still needed (external) |
|---|---|---|---|
| 1.1 Documents | Standard (B2B) and simplified (B2C) invoices, credit notes (381) and debit notes (383) with the original's reference and a reason | implemented, local tests | SDK validation of the XML |
| 1.2 Data | Seller VAT/CR/national address; buyer VAT and address for standard invoices; UUID; issue date/time | implemented; seller data approved by someone else | the company's real seller data (fixture values are synthetic) |
| 1.3 Chain | ICV per EGS, previous-invoice hash | gapless under concurrency, DB-guarded; initial PIH per our reading (unverified) | SDK validation |
| 1.4 XML | UBL 2.1 per the XML Implementation Standard | per our reading; **unverified** | the standard's text; SDK validation |
| 1.5 Hash / stamp | canonicalised hash; XAdES stamp with a CSID | hash over our deterministic serialisation (C14N equivalence **unverified**); ECDSA secp256k1 with a **local test key**, not XAdES, not a CSID | compliance CSID; XAdES checked with the SDK |
| 1.6 QR | TLV base64, phase-2 tags | §3: tags 1–8; layout of tags 6–7 unresolved; tag 9 absent | certificate; SDK validation |
| 1.7 Rules | BR-KSA business rules | 20+ local checks (`LOCAL-*`), not the official codes | official data dictionary; mapping to BR-KSA |
| 1.8 Clearance / reporting | standard invoices cleared before sharing; simplified reported within 24 h | production refused; LOCAL_ONLY records "not sent"; SANDBOX only to a local stub or ZATCA's developer-portal / simulation paths; retries with back-off; append-only attempts | network access to gw-fatoora, test CSID, compliance invoice set |
| 1.9 Retention / audit | XML and responses kept; who did what | immutable e-invoice rows, append-only attempts, audit entries | retention period policy |
| 1.10 Standards status on screen | the user sees that a document is not standards-compliant | every e-invoice detail lists its gaps: not SDK-validated; for simplified documents also the local key (not a CSID), the unconfirmed QR layout and the missing tag 9 — `tax-forms.mjs` | — |
| 2. VAT return | boxes by period; credit notes; reconciliation | from posted documents, reconciled to output/input VAT with an unexplained remainder | box numbering against the official form; exports, imports, reverse charge, corrections and carried-forward credit not modelled |
| 3. Zakat | zakat base and filing | **not implemented** | professional input |
