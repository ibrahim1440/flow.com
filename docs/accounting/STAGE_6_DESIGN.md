# Stage 6 — e-invoicing (LOCAL validation only) and the VAT return

Repository [https://github.com/ibrahim1440/flow.com](https://github.com/ibrahim1440/flow.com), branch
`feature/accounting-ledger-core` (unpushed). Designed in Figma first (page 23, ACC-70..72,
`FIGMA_PARITY.md`), then implemented.

> **Nothing in this branch has been sent to ZATCA** — not to the sandbox / simulation, not to
> production — and no document has been sent to any customer. The e-invoices are generated and
> checked **locally**. Passing these local checks is **not** ZATCA validation and **not**
> compliance. Only ZATCA's official SDK or the Fatoora platform can validate a document.

## 1. Official requirements: what was verified, and how far

zatca.gov.sa is **blocked by this environment's egress policy** (`EGRESS_BLOCKED`; proxy answers
403 to CONNECT). The documents could not be opened. A web search restricted to `zatca.gov.sa`
returned the official documents' titles, versions, dates and URLs, and search-snippet summaries.
That is index-level confirmation only:

| Official document (as indexed on zatca.gov.sa) | Version / date | URL | What was confirmed |
|---|---|---|---|
| Electronic Invoice XML Implementation Standard | v1.2, 2023-05-19 (v1.1 2022-06-24 also indexed) | [link](https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_XML_Implementation_Standard_%20vF.pdf) | title, version, date; UBL-based; document types invoice / credit note / debit note |
| Electronic Invoice Security Features Implementation Standards | v1.2, 2023-05-19 | [link](https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf) | title, version; "cryptographic stamp" = signature of the document hash |
| Detailed Guidelines for E-Invoicing | v2, May 2023 | [link](https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-Invoicing_Detailed__Guideline.pdf) | simplified invoices reported within 24 h of generation; standard invoices cleared |
| E-invoicing Detailed Technical Guidelines | v2, Nov 2022 | [link](https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-invoicing-Detailed-Technical-Guideline.pdf) | clearance vs reporting models |
| Guide to Developed FATOORA Compliant QR Code | — | [link](https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/QRCodeCreation.pdf) | TLV: tag byte, length byte, UTF-8 value, base64; tags 1–5 seller name, VAT number, timestamp, total with VAT, VAT total; phase 2 has 9 tags |
| E-Invoicing Implementation Resolution | 2023-05-19 | [link](https://zatca.gov.sa/en/E-Invoicing/Introduction/LawsAndRegulations/Documents/20230519_E-Invoicing%20Implementation%20Resolution%20English.pdf) | title only |
| Developer portal / integration sandbox | Developer Portal Manual v3 (Nov 2022) | [sandbox.zatca.gov.sa](https://sandbox.zatca.gov.sa/) | test CSIDs from the sandbox; compliance CSID then production CSID; test CSIDs are not usable in production |

Not verified (contents unreadable here): exact UBL element paths and cardinalities, the official
BR-KSA rule codes and messages, the canonicalisation (C14N 1.1) and XAdES structure, QR tags 6–9
formats, exemption reason codes (VATEX-SA-…), API paths and headers, and the timelines per wave.
Whether newer versions than those indexed exist in 2026 is **unknown**.

The QR encoding is cross-checked against the widely published phase-1 example ("Bobs Records"):
our encoder produces the same base64 string (`einvoice-pure.test.ts`).

## 2. What is built (local)

| Part | Implementation | Status against the official standard |
|---|---|---|
| Seller profile | versioned, approved by someone other than the preparer, immutable once approved; environment `LOCAL_ONLY` or `SANDBOX`; production refused by service and database | company data must be entered by the business — the fixture's is synthetic |
| Document | UBL 2.1 XML: ID, UUID, issue date/time, type 388/381/383 with subtype 01…/02…, currency, billing reference and reason for notes, ICV and PIH references, parties with national address and VAT/CR, tax totals per category, monetary totals, lines | structure is our reading of the standard; **unverified** |
| Chain | ICV per EGS, gapless under concurrency (advisory lock + unique index); PIH = previous document hash; the first uses base64(hex(SHA-256("0"))); the database checks the chain and forbids changes | the initial value and hash encoding are our reading; **unverified** |
| Hash | SHA-256 (base64) of our deterministic XML without the signature extension, `cac:Signature` and the QR reference | equivalence with C14N 1.1 **unverified** |
| Signature | simplified invoices: ECDSA secp256k1 over the hash with a **local test key**, in a simplified UBL extension | **not** XAdES, **not** a ZATCA CSID |
| QR | TLV base64; tags 1–5 always, 6–8 for signed documents; tag 9 omitted (no ZATCA certificate) | encoding cross-checked on the phase-1 example only |
| Local rules | 20+ `LOCAL-*` checks: seller/buyer identity and address, UUID, type, dates, currency, ICV/PIH, credit/debit references and reasons, line and total arithmetic, tax categories with exemption code and text, stored hash, QR content, signature | **local codes, not BR-KSA** |
| Generation | after posting; never blocks the posting; an invalid document takes no ICV and waits with its errors (job), fixed and retried; idempotent | — |
| Debit notes | an invoice naming a posted invoice, same customer, reason, no goods → type 383 | — |
| Submission | `LOCAL_ONLY` → "not sent" recorded; `SANDBOX` → only a local stub (`http://localhost`) or `https://gw-fatoora.zatca.gov.sa/e-invoicing/{developer-portal,simulation}` with test credentials from the environment; the production path `/e-invoicing/core` is refused; retryable failures (429/5xx/network) back off 1, 5, 15, 60, 240 min then FAILED; accepted is final; every attempt appended, audited | endpoint paths and headers **unverified**; never exercised against ZATCA |
| VAT return | boxes 1, 3–13 from posted documents and supplier bills (credit notes negative, reversals in the reversal period), reconciled to output/input VAT with differences by source and an unexplained remainder | box numbering and wording to check against the official form; exports, imports, reverse charge, corrections and carried-forward credit **not modelled** |

## 3. Separation: local validation ≠ sandbox ≠ production

| Level | Done here? | What it needs |
|---|---|---|
| Local generation and local checks | **yes** (tests below) | — |
| ZATCA SDK validation of our XML | **no** | the official SDK (download from zatca.gov.sa — blocked here) run on the generated XML, in CI or on a machine with access |
| Sandbox / simulation compliance checks | **no** | network access to `gw-fatoora.zatca.gov.sa`, a test CSR and a compliance CSID from the developer portal, then the compliance invoice set |
| Production onboarding and clearance/reporting | **no — refused by design in this branch** | owner approval, production CSID, private-key custody (HSM/secret store, not the database), and a release |

## 4. Tests (synthetic data)

`einvoice-pure.test.ts` (unit: initial PIH, QR vs published example, hash/signature/tamper, rules,
submission targets); `einvoice.test.ts` (DB: waiting for a profile, four-eyes profile and refusal of
production, invalid documents not consuming the chain, simplified signing and QR, credit and debit
notes, concurrent generation, immutability and chain guards, submission gating, retries/back-off,
append-only attempts, VAT return and reconciliation); `tax.test.mjs` (HTTP, runtime role: duties,
XML download, LOCAL_ONLY submission, guards); `tax-forms.mjs` (browser: profile, address fix and
retry, debit note through the receivables form, submission and re-validation, VAT return page).

## 5. Open items (decisions and external steps)

- Seller legal data, EGS unit naming, and which customers are "standard" (B2B) vs "simplified": the
  rule used is "customer has a VAT number → standard" — a proposal awaiting the accountant.
- Exemption reason codes and texts per tax category (the fixture's zero-rated category has none, so
  its lines fail locally, as they should).
- Private-key custody for real signing; the local test key is generated per process or read from
  `EINVOICE_LOCAL_TEST_KEY` and must never be used beyond local validation.
- A reversed invoice that was e-invoiced is flagged: ZATCA's model corrects issued invoices with
  credit notes, not reversals.
