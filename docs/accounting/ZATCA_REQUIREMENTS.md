# Saudi localisation — requirements matrix

**Status (stage 6): e-invoices are generated and checked LOCALLY; nothing has been sent to ZATCA
(neither the sandbox / simulation nor production) or to any customer. No compliance is claimed.**
A generated QR code or a document that passes our local checks is not compliance; only the official
SDK or the Fatoora platform validates a document. Design and evidence: `STAGE_6_DESIGN.md`.

Official sources: zatca.gov.sa is blocked by this environment's egress policy, so the documents
could not be read. Their titles, versions, dates and URLs were confirmed by a search restricted to
zatca.gov.sa (XML Implementation Standard v1.2 2023-05-19; Security Features Implementation
Standards v1.2 2023-05-19; Detailed Guidelines v2 May 2023; Detailed Technical Guidelines v2 Nov
2022; QR code guide; developer portal / integration sandbox) — `STAGE_6_DESIGN.md` §1 lists them
with links and what each search result confirmed. Review date: 2026-09-29.

| Area | Requirement | Local status | What is still needed (external) |
|---|---|---|---|
| 1.1 Documents | Standard (B2B) and simplified (B2C) invoices, credit notes (381) and debit notes (383) with the original's reference and a reason | implemented and tested locally (`einvoice.test.ts`, `tax-forms.mjs`) | SDK validation of the XML |
| 1.2 Data | Seller VAT/CR/national address; buyer VAT and national address for standard invoices; UUID; issue date/time | implemented; seller data approved by someone else; buyer national address per customer | the company's real seller data (fixture values are synthetic) |
| 1.3 Chain | ICV counter per EGS, previous-invoice hash | implemented, gapless under concurrency, DB-guarded; initial PIH per our reading (unverified) | SDK validation |
| 1.4 XML | UBL 2.1 per the XML Implementation Standard | implemented per our reading; **unverified** (element paths, cardinalities) | read the standard; SDK validation |
| 1.5 Hash / stamp | canonicalised hash; XAdES cryptographic stamp with a CSID | hash over our deterministic serialisation (C14N equivalence **unverified**); ECDSA secp256k1 with a **local test key**, not XAdES, not a CSID | compliance CSID from the developer portal; XAdES implementation checked with the SDK |
| 1.6 QR | TLV base64, phase-2 tags | tags 1–8 (encoding matches the published phase-1 example); tag 9 omitted (no certificate) | certificate; SDK validation |
| 1.7 Rules | BR-KSA business rules | 20+ local checks (`LOCAL-*`), not the official codes | official data dictionary; mapping to BR-KSA |
| 1.8 Clearance / reporting | standard cleared before sharing; simplified reported within 24 h | submission adapter refuses production; LOCAL_ONLY records "not sent"; SANDBOX only to a local stub or ZATCA's developer-portal / simulation paths with test credentials; retries with back-off; append-only attempts | network access to gw-fatoora.zatca.gov.sa, test CSID, compliance invoice set |
| 1.9 Retention / audit | XML and responses kept; who did what | immutable e-invoice rows, append-only attempts, audit log entries | retention period policy |
| 2. VAT return | boxes by period; credit notes; reconciliation to the ledger | implemented from posted documents, reconciled to output/input VAT with an unexplained remainder | box numbering/wording checked against the official form; exports, imports, reverse charge, corrections and carried-forward credit are not modelled |
| 3. Zakat | zakat base and filing | **not implemented** | professional input; out of scope for the software alone |
