# Source-code candidates and licence register

> Researched 2026-09-27 from the repositories and manifests themselves (SHAs below). **Outcome: no third-party accounting code was copied into BeanFlow.** The ledger, posting engine, reports and screens are an independent implementation from the requirements in `docs/accounting-module-file-02.txt` and the owner decisions in `POLICIES.md`. ERPNext and Odoo were read only as functional references. The ZATCA candidates (`zatca-sdk`, `@jaicome/zatca-*`, MIT) are recorded for a later increment; nothing is installed yet. This is not legal advice.

# OSS License Register: Double-Entry Accounting, Invoicing and ZATCA

**Prepared:** 2026-09-27
**Context:** A proprietary, closed-source, commercially hosted Next.js 16 + TypeScript + Prisma + PostgreSQL ERP. The question is whether any code can be copied or adapted, or whether each piece must be built independently from requirements.
**Method:** SHAs come from `git ls-remote <url> HEAD` run on 2026-09-27. Licenses were read from the LICENSE files and manifests in shallow clones in this scratchpad (`bigcapital/`, `erpnext/` (sparse), `odoo-18.0/`, `odoo-19.0/`, `odoo-20.0/` (tree-only), `odoo-doc/`, `ksa_compliance/`, `zatca_erpgulf/`, `Accounts-ERP-With-TypeScript/`, `z/*`). Open-issue counts come from the GitHub search API and include PRs. Releases come from `git ls-remote --tags`, because the GitHub releases API returned 403 through the proxy.
**Not legal advice.** Anything I could not read directly is marked **unverified**.

> **Key licensing premise.** GPLv3 and LGPLv3 obligations are triggered by *conveying* (distributing) the software. AGPLv3 §13 adds an obligation for software used over a network: you must offer the Corresponding Source to remote users of a modified version. A pure SaaS that is never distributed does not trigger GPL/LGPL source obligations, but it **does** trigger AGPL. If any customer ever gets an on-prem, self-hosted, desktop or offline build, GPL/LGPL obligations apply as well. A port or translation of code (for example Python to TypeScript) is still a derivative work. Rewriting the code in another language does not remove the license.

---

## 1. Bigcapital (bigcapitalhq/bigcapital)

| Field | Value |
|---|---|
| URL | https://github.com/bigcapitalhq/bigcapital |
| Default branch / HEAD | `develop` @ `d2a0bf153a0f11dc4250df504105d3fea74356bd` (commit date 2026-09-23) |
| Latest version | tag `v0.25.42`, which is the HEAD commit. `packages/webapp` is 0.10.2 and `packages/server` is 0.0.1 |
| Stars / open issues+PRs | ~3.9k / 269 |
| Stack | TypeScript monorepo (pnpm/lerna). Server: **NestJS**, **Knex + Objection.js**, **MySQL** (`mysql`, `mysql2`), multi-tenant DB-per-tenant (`TenantDBManager`), Redis/Bull/BullMQ, ClickHouse client, Stripe/LemonSqueezy/Plaid. Money: `js-money`, `accounting`, `mathjs`. The ledger table is `decimal(13,3)` debit/credit (`20200104232647_create_accounts_transactions_table.ts`) |
| Accounting scope | Accounts, ManualJournals, Ledger, SaleInvoices/Estimates/Receipts, PaymentReceived, CreditNotes, Bills, BillPayments, VendorCredit, Expenses, Items, InventoryCost (FIFO/LIFO/AVG constants present), InventoryAdjustments, Warehouses, Branches, TaxRates, FinancialStatements, TransactionsLocking. `modules/EE/` contains AuditLogs and BillLandedCosts. No ZATCA module was found |
| Tests | 118 `*.spec.ts` / `*.e2e-spec.ts` files under `packages/server`, plus a root Playwright `e2e/` |

**The license question:**
- Root `LICENSE`: *"### GNU AFFERO GENERAL PUBLIC LICENSE — Version 3, 19 November 2007"* (full AGPLv3 text).
- `README.md` line 53: *"Bigcapital is available open-source under AGPL license."*
- `AGENTS.md` line 103: *"**License**: AGPL for the open-source edition. Some modules under `modules/EE/` may be enterprise-only."* No separate EE license file exists and no headers under `modules/EE` or `modules/ee` mention a license, so the EE status is **unverified** and ambiguous.
- `packages/server/package.json`: `"private": true, "license": "UNLICENSED"`. This is next to `"author": ""` and `"build": "nest build"`, which matches the default NestJS CLI scaffold.
- Other manifests: the root `package.json` has no license field. `@bigcapital/utils` and `@bigcapital/sdk-ts` are `"ISC"`. The webapp, email-components and pdf-templates have no field.

**Which governs:** the root `LICENSE` file (AGPLv3) is the only actual license grant in the repository, and the README confirms it. The npm `license` field is package metadata, not a grant. Under npm semantics `"UNLICENSED"` means *"you do not grant others the right to use a private or unpublished package under any terms."* It does **not** mean public domain. Because the package is `private: true` and never published, the field is most plausibly an unedited scaffold default. The inconsistent ISC fields on two shared packages make this worse: it is ambiguous whether those two small packages have an ISC grant. **Either reading rules out closed-source reuse.** Under AGPLv3, §13 forces an offer of the complete source of the modified program to every network user of your SaaS. Under a literal "UNLICENSED" reading, no rights are granted at all.

**Verdict:** *Reusable in closed-source SaaS: **No**. Use only as a functional or UX reference* (do not copy code, schemas or migrations verbatim). Even if it were permissive, the coupling is heavy: NestJS + Objection + Knex on MySQL with tenant-DB-per-org, compared with our Next.js + Prisma + Postgres.
**Porting effort, if it were licensable:** ledger and CoA 3–4 pw; invoicing/AR 4–6 pw; AP 3–4 pw; inventory valuation 4–6 pw. That is about 14–20 pw, which is close to the cost of a clean-room build.

---

## 2. ERPNext (frappe/erpnext): accounts, stock, manufacturing, assets

| Field | Value |
|---|---|
| URL | https://github.com/frappe/erpnext |
| Default branch / HEAD | `develop` @ `e4621bfb506ac2677a078b1847bba9a88db6efba` (2026-09-27) |
| Version | `develop` = `17.0.0-dev` (`erpnext/__init__.py`). Latest tag `v16.36.0` |
| Stars / open issues+PRs | ~39.6k / 1,769 |
| License | `license.txt` = **GNU GPL v3** (29 June 2007). It applies to the whole repo, including `erpnext/accounts`, `stock`, `manufacturing` and `assets`; I found no per-module license files. `TRADEMARK_POLICY.md`: "ERPNext" name and logo need permission |
| Framework coupling | Python ≥3.14; `[tool.bench.frappe-dependencies] frappe = ">=17.0.0-dev,<18.0.0"`. Everything is a Frappe DocType (JSON metadata + Python controllers + `frappe.db` / Query Builder, MariaDB/Postgres through Frappe). The Frappe framework itself is MIT (its `LICENSE` at `frappe/frappe@develop` reads "The MIT License"), but ERPNext's own code is GPLv3 |
| Tests | 533 `test_*.py` files repo-wide, 324 of them under accounts/stock/manufacturing/assets |
| Maintenance | Very active: a commit the same day and many tags |

**Obligations:** GPLv3 has no network clause, so SaaS-only use does not trigger source disclosure. However, any distribution of our ERP (on-prem, self-host, desktop) would require the whole combined work to be GPLv3. A TypeScript port of ERPNext logic is a derivative work.
**Verdict:** *Reusable in closed-source SaaS: **Only as reference.*** Copying is legally possible only while we never distribute, which is fragile and not recommended for a commercial product. Technically the Frappe DocType/ORM coupling makes direct reuse impractical in any case. It is a valuable reference for behaviour: GL Entry, Payment Ledger, Stock Ledger Entry, moving-average/FIFO valuation (`stock_ledger.py`), repost logic, period closing, asset depreciation schedules.
**Porting effort (translation to TS/Prisma):** ledger 3–5 pw; invoicing/AR 5–7 pw; AP 4–5 pw; inventory valuation with backdated reposting 6–10 pw. That is about 18–27 pw, which is no cheaper than clean-room work.

---

## 3. Odoo (odoo/odoo): account, l10n_sa, l10n_sa_edi

| Field | Value |
|---|---|
| URL | https://github.com/odoo/odoo |
| Default branch / HEAD | **`20.0`** @ `17ff827a18248397342e73bb2bcac48e2b8e1027` (2026-09-26). `19.0` @ `4e7b84db9455086754164db5e404987c34d48eb7`. `18.0` @ `bdb5a9a8f81563a87081ec17ef99bf0fbb8d4e98`. `master` @ `a35f117fb5c52a8377c0bf7f0b39c6574a4e611b` |
| Stars / open issues+PRs | ~54.7k / 10,521 |
| Project license | `LICENSE`: *"Odoo is published under the GNU LESSER GENERAL PUBLIC LICENSE, Version 3 (LGPLv3)"*, with the GPL text appended. `COPYRIGHT`: files are "Copyright (c) 2004-2015 Odoo S.A." unless stated otherwise |
| Coupling | Python Odoo ORM (`models.Model`, QWeb XML views and templates, `account.move` / `account.move.line` model), PostgreSQL. It cannot be lifted out without the framework |

**Saudi modules present in the community repo (checked with `git ls-tree` on each branch):**

| Module | 18.0 | 19.0 | 20.0 | Manifest license (19.0) | Notes |
|---|---|---|---|---|---|
| `account` ("Invoicing") | yes | yes | yes | `LGPL-3` | Community edition. The full "Accounting" app and reports are Enterprise |
| `l10n_sa` ("Saudi Arabia - Accounting", v2.3) | yes | yes | yes | `LGPL-3` | depends: `l10n_gcc_invoice`, `account`, `account_debit_note`. Docs: "Phase 1 QR code support" |
| `l10n_sa_edi` ("Saudi Arabia - E-invoicing", v0.3) | yes | yes | yes | `LGPL-3` | depends: `account_edi`, `account_edi_ubl_cii`, `l10n_sa`, `base_vat`, `certificate`. Contains `account_edi_xml_ubl_21_zatca.py`, `pre-hash_invoice.xsl`, the OTP wizard, and tests with ZATCA compliance sample XMLs (standard and simplified invoice/credit/debit) |
| `l10n_sa_edi_pos`, `l10n_sa_pos` | yes | yes | yes | not read | PoS |
| `l10n_sa_withholding_tax` | no | yes | no | `LGPL-3` | Missing from the 20.0 tree listing |
| `l10n_sa_reports` | **no** | **no** | **no** | n/a | Listed in the 19.0 docs but absent from community, so it is **Enterprise**. The Enterprise license (OEEL-1) was **not read** (private repo) |

**Documentation:** www.odoo.com was blocked by the egress proxy. I read the same page's source from `odoo/documentation@19.0` (`91ebb273…`, `content/applications/finance/fiscal_localizations/saudi_arabia.rst`). It lists `l10n_sa`, `l10n_sa_reports`, `l10n_sa_edi` ("Enables ZATCA Phase 2 API integration for e-invoicing compliance"), `l10n_sa_edi_pos`, `l10n_sa_pos` and `l10n_sa_withholding_tax`. It describes three onboarding modes (Sandbox, Simulation (Pre-Production), Production), OTP from the Fatoora portal (expires after 60 min), compliance CSID and then production CSID, "Revoke CSID", and clearance for B2B versus reporting for B2C. The page does not label any module as Enterprise. The Enterprise attribution of `l10n_sa_reports` is inferred from its absence in the community repo.

**Obligations:** LGPLv3 has no network clause. Using a *modified* LGPL "Library" in a SaaS that is never distributed triggers no source obligation. A TypeScript translation of `l10n_sa_edi` (UBL templates, hashing XSL, business logic) would itself be an LGPL-covered derivative, and any distribution would require releasing that portion's source and allowing relinking.
**Verdict:** *Reusable in closed-source SaaS: **Only as reference*** (recommended). A narrow LGPL-isolated port is legally possible if kept in a separate module with legal sign-off. The field mappings in `account_edi_xml_ubl_21_zatca.py` and the compliance sample XMLs are high-value references. The ZATCA rules themselves come from public ZATCA standards and can be implemented independently.
**Porting effort:** ZATCA UBL/signing from `l10n_sa_edi` 3–5 pw. Ledger/AR/AP porting from `account` is not sensible because of heavy ORM coupling (20+ pw).

---

## 4. A-Haseeb-Dev/Accounts-ERP-With-TypeScript ("HAS ERP")

| Field | Value |
|---|---|
| URL | https://github.com/A-Haseeb-Dev/Accounts-ERP-With-TypeScript |
| HEAD | `main` @ `95ce4be7a991f885a8cae585d771c6c9dc5670fb` (2026-09-27) |
| Version | `has-erp` 1.0.0. No tags or releases seen |
| License | **None.** There is no LICENSE file, no `license` field in any of the three `package.json` files, and no license section in the README. With no license grant, all rights are reserved by default |
| Stack | pnpm monorepo: NestJS 10 API + Prisma + PostgreSQL; Next.js 15 web. Closest to our stack |
| Maturity | Repo created 2026-09-01, 0 stars / 0 forks. 18 Prisma migrations dated 2026-09-01 to 2026-09-22. About 293 files. Scope includes vouchers, sales/purchases and returns, COGS, average cost, PDC, HR/payroll, and trial balance/GL reports. There is no ZATCA/TLV code (`qrcode` is a dependency) |
| Tests | 28 `*.spec.ts` (Vitest). The README claims "90 unit tests" |

**Accounting red flags (read in the code):**
- Money is stored as `Decimal(18,2)` in Prisma, which is good. However, **all arithmetic is done in JS `number`**: there are 452 `Number(`/`parseFloat(` calls in `apps/api/src` and only 1 use of Decimal. For example, `assertBalanced` does `round2(entries.reduce((s,e)=> s + Number(e.debit ?? 0), 0))` (`common/services/accounting.service.ts:143`), and `round2` uses `Math.round((n+Number.EPSILON)*100)/100`.
- `averageCost` and `unitCost` are `Decimal(18,2)`. Two decimal places for moving-average unit cost causes cumulative valuation drift.
- `round2` is duplicated across services (`sales.service.ts:618`, `quotations.service.ts:410`, `sales-returns.service.ts:445`).
- It is a single-author project, three weeks old.

**Verdict:** *Reusable in closed-source SaaS: **No*** (no license). It is usable at most as a loose reference, and it is not a good one given the float arithmetic. Reuse would require a written license from the author. Porting effort if licensed: about 6–10 pw of hardening (decimal arithmetic, cost precision, tests).

---

## 5a. lavaloon-eg/ksa_compliance

| Field | Value |
|---|---|
| URL | https://github.com/lavaloon-eg/ksa_compliance |
| HEAD | `master` @ `24968b4e7e6846b968421f385311a999ca3cfd0f` (2026-06-01) |
| Version | tag `0.61.8` |
| Stars / open issues+PRs | 89 / 37 |
| License | `LICENSE` = **GNU AGPL v3**. README: *"Copyright (c) 2024 LavaLoon, The KSA Compliance App code is licensed as AGPL"*. This conflicts with `hooks.py`, which says `app_license = 'Copyright (c) 2023 LavaLoon'`. The LICENSE file and README govern |
| Coupling | Frappe app (`frappe >=15.0.0,<17.0.0`), ERPNext DocTypes. Deps: `result`, `pyqrcode`, `pathvalidate`, `semantic-version`. Signing, CSR and validation are delegated to an external **Java CLI** (`lavaloon-eg/zatca-cli`, whose `LICENSE` on `master` reads "MIT License, Copyright (c) 2024 LavaLoon"), which is auto-downloaded together with Temurin JRE 11 |
| ZATCA scope | README: Phase 1 and Phase 2 compliance, Phase 1 and Phase 2 print formats, Sandbox support |
| Tests | 8 `test_*.py` |

**Verdict:** *Reusable in closed-source SaaS: **No*** (AGPL §13 would apply to our network service). Use only as a reference. The separately licensed MIT `zatca-cli` (Java) could in principle be reused as a sidecar process, but that is **unverified** beyond reading its LICENSE header. Effort to port its logic to TS: 4–6 pw.

## 5b. ERPGulf/zatca_erpgulf

| Field | Value |
|---|---|
| URL | https://github.com/ERPGulf/zatca_erpgulf |
| HEAD | `main` @ `9d0099e291c8b10591d31142e246bf98b3fafbb8` (2026-09-08) |
| Version | tag `v3.0.1` |
| Stars / open issues+PRs | 61 / 34 |
| License | `LICENSE` = **MIT** ("Copyright (c) 2024 ERPGulf"). There is also an unfilled template `license.txt` ("Copyright (c) [year] [fullname]"). `pyproject.toml` has `license = {file = "LICENSE"}` and `hooks.py` has `app_license = "mit"`. The README says "MIT (Or another license)", which is a minor ambiguity |
| Coupling | Frappe app (`frappe >=14.0.0,<17.0.0`), ERPNext Sales Invoice / POS. Python with native signing (`createxml.py`, `sign_invoice_first.py`, `posxml.py`) and deps `asn1` and `pikepdf` (PDF/A-3) |
| ZATCA scope | README: Phase 2, clearance and reporting APIs. Some Phase-1 references exist in the code (`create_qr.py`) |
| Tests | 4 `test_*.py` |
| Note | Commits `cert.pem` and `sdkprivatekey.pem` at repo root. These are probably the public ZATCA SDK sample credentials (**unverified**), but they are a hygiene flag |

**Verdict:** *Reusable in closed-source SaaS: **Yes (license-wise, with MIT attribution)**.* In practice it is a Python/Frappe codebase, so reuse means *translating* algorithms (hashing and canonicalization, XAdES signed-properties, TLV) to TS while keeping the MIT notice. Effort: 3–5 pw. Its code quality has not been audited.

---

## 6. Permissively licensed TypeScript/JS alternatives

### 6a. ZATCA libraries (npm/GitHub, read in clones under `z/`)

| Package / repo | HEAD SHA (date) | Version | License (read) | Phase 2? | Crypto/runtime | Tests | Notes |
|---|---|---|---|---|---|---|---|
| **`zatca-sdk`** / [aashahin/zatca-sdk](https://github.com/aashahin/zatca-sdk) | `7ed29640512e158e12ca623c9841a46a3962f710` (2026-09-08) | 0.1.2 | MIT (LICENSE + package.json) | Yes: CSR, compliance CSID, compliance checks, production CSID, reporting and clearance; sandbox, simulation and production | Pure JS (`@noble/curves`, `xmldsigjs`, `@xmldom/xmldom`, `xpath`, `qrcode`, typebox). No OpenSSL. `engines: node>=18, bun>=1` (README says "Runs on Bun") | 11 test files, including golden fixtures from the official SDK and a live sandbox test script | **Validated against official ZATCA Java SDK `238-R3.4.8`** (bundled in `resources/examples/zatca-einvoicing-sdk-Java-238-R3.4.8`). Very new (0.1.x). Best candidate for Phase 2 |
| **`@jaicome/zatca-core` + `@jaicome/zatca-server`** / [Jaicome/jaicome-zatca-sdk](https://github.com/Jaicome/jaicome-zatca-sdk) | `bb424178b4c8f77d3b18c18f2bc7fc3eee218533` (2026-03-05) | 1.0.6 in repo, 1.1.0 on npm | MIT (LICENSE is "Copyright (c) 2022 Repzo Inc", so it is a fork lineage of zatca-xml-js) | Yes, per the README ("Reporting", EGS, CSR) | `decimal.js`, `xmldsigjs`, `zod`. The EGS key/CSR module **requires system OpenSSL** (`child_process`) | 33 test files | Monorepo that separates portable core from Node server code. SDK version targeted: **unverified** |
| `zatca-xml-js` / [wes4m/zatca-xml-js](https://github.com/wes4m/zatca-xml-js) | `41a2c7d9075cb1a4b0b0e39f30a887337d778c73` (2022-12-09) | 0.1.9 (npm 2022-12-09) | MIT | Partial (simplified invoices, onboarding) per the README | OpenSSL through `child_process` | 0 | Stale (no commits since 2022). It is the origin of the Repzo and Jaicome forks |
| `zatca-xml-ts` / [Repzo/zatca-xml-js](https://github.com/Repzo/zatca-xml-js) | `1f9b63338e2d8e0fef5cf71342ac5617257b1e60` (2025-06-04) | 0.1.5 | MIT | Same as wes4m | OpenSSL | 0 | Low activity |
| `@khaledhajsalem/zatca-node` / [khaledhajsalem/zatca-node](https://github.com/khaledhajsalem/zatca-node) | `b64d7f74345d7c8774631e8edf5e0be1e58e38d4` (2026-04-20) | 1.0.4 | MIT | Claims Phase 2 (CSR, compliance, clearance, reporting) | `xml-crypto`, `xmlbuilder2`, `axios`. **OpenSSL required** for CSR | 1 | Low test coverage |
| `@talha7k/zatca` | not cloned | 0.13.2 (npm 2026-09-17) | **AGPL-3.0-only** (npm metadata) | Phase 2 | n/a | n/a | **Excluded** (AGPL). Its sibling `@talha7k/zatca-qr` 1.3.0 is MIT per npm metadata (unverified) |
| `Erpflow-dev/zatca-kit` | not cloned | n/a | AGPL-3.0 (GitHub metadata) | Phase 2 | n/a | n/a | **Excluded** |
| `@dokhna-tech/zatca*` | not cloned | 4.0.1 | **BUSL-1.1** (npm metadata) | Phase 2 | n/a | n/a | **Excluded** (Business Source License, not open source) |
| `@axenda/zatca`, `zatca-qr-tlv`, `@talha7k/zatca-qr`, `biza-ai/zatca-qr` | not cloned | various | MIT (npm/GitHub metadata) | QR/TLV only | n/a | n/a | TLV is trivial to implement in-house (about 1 day) |

### 6b. Double-entry ledger libraries

| Library | HEAD SHA (date) | Version | License | Coupling | Verdict |
|---|---|---|---|---|---|
| [flash-oss/medici](https://github.com/flash-oss/medici) | `54fa40b6df5bc43e7b290b4805a1ef3ddc256861` (2026-07-29) | 7.3.0 | MIT | **MongoDB/Mongoose only** (sole dependency `mongoose`). `debit`/`credit` are JS `Number` in `models/transaction.ts` | Reference only (wrong DB, float amounts). Its API design (Book/Entry, voiding, balance snapshots) is worth borrowing conceptually |
| [pgr0ss/pgledger](https://github.com/pgr0ss/pgledger) | `5e2c1fe2ee7bf471ddca3097e1c1acbb17b562a6` (2026-09-11) | no tag seen | MIT | Pure PostgreSQL (`pgledger.sql`, 256 lines, PL/pgSQL). `NUMERIC` amounts, account `version` for optimistic locking, `account_previous_balance` on entries. Go tests | **Reusable (MIT)** as a pattern or DDL for balance and immutability triggers in our Postgres. It is not an accounting system (no CoA, periods or tax) |

Also note that Frappe itself is MIT. That is irrelevant here, because the accounting logic lives in GPL ERPNext.

### 6c. Official ZATCA resources

zatca.gov.sa returned **403 from the egress proxy**, so nothing below was read on zatca.gov.sa itself. URLs and versions come from web-search results and from third-party copies.
- **Compliance & Enablement Toolbox / SDK download:** https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Pages/DownloadSDK.aspx. This is a Java CLI (`fatoora`, JDK ≥11 <15). The newest version I *observed* is **`zatca-einvoicing-sdk-Java-238-R3.4.8`**, bundled in aashahin/zatca-sdk. Its bundled `LICENSE.txt` is **LGPLv3**. A web-search snippet claimed "latest 238-R3.3.8", which conflicts with this, so the current official version is **unverified**.
- **E-Invoicing portal:** https://zatca.gov.sa/en/E-Invoicing/Pages/default.aspx
- **Developer Portal (sandbox) and Simulation:** per the Odoo docs and the aashahin README, the base paths are `…/developer-portal` (sandbox; test VAT 399999999900003; any OTP) and `…/simulation` (OTP from the Fatoora simulation portal). The full gw-fatoora host is **unverified**.
- **XML Implementation Standard** v1.2 (2023-05-19): https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_XML_Implementation_Standard_%20vF.pdf (v1.1, 2022-06-24, also exists). From search results only.
- **Security Features Implementation Standards** v1.2 (2023-05-19): https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf (v1.1, 2022-06-24). From search results only.
- **Detailed Guidelines** v2 (May 2023): https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-Invoicing_Detailed__Guideline.pdf
- **Developer community:** https://zatca1.discourse.group/ (blocked; not read).
- The API specs (compliance CSID, reporting, clearance and renewal OpenAPI) are mirrored in `aashahin/zatca-sdk/resources/zatca_docs/`. Their provenance is **unverified**.

---

## Summary table

| Candidate | SHA (HEAD) | Version | License (scope) | Coupling | Maintenance | Tests | Verdict (closed-source SaaS) | Effort (pw, ledger / inv+AR / AP / inv-valuation or ZATCA) |
|---|---|---|---|---|---|---|---|---|
| Bigcapital | `d2a0bf1` | v0.25.42 | AGPLv3 root (governs); server pkg `UNLICENSED` (npm metadata, no grant); utils/sdk-ts `ISC` field; EE modules ambiguous | NestJS, Knex/Objection, MySQL, tenant-DB | Active (2026-09-23), 269 open | 118 spec/e2e | **No**, reference only | 3–4 / 4–6 / 3–4 / 4–6 (≈14–20) |
| ERPNext (accounts, stock, mfg, assets) | `e4621bf` | 17.0.0-dev; v16.36.0 | GPLv3 (whole repo); trademark policy | Frappe DocTypes/ORM, Python 3.14 | Very active, 1,769 open | 324 test files in these modules | **Only as reference** | 3–5 / 5–7 / 4–5 / 6–10 (≈18–27) |
| Odoo community (account, l10n_sa, l10n_sa_edi) | `17ff827` (20.0); 19.0 `4e7b84d` | 18.0/19.0/20.0 | LGPLv3 (all three `LGPL-3`); `l10n_sa_reports` Enterprise (absent) | Odoo ORM, QWeb, Python | Very active, 10.5k open | Yes (`l10n_sa_edi/tests` + compliance XMLs) | **Only as reference** (LGPL port possible with legal review) | ZATCA 3–5; ledger port impractical (20+) |
| Accounts-ERP-With-TypeScript | `95ce4be` | 1.0.0 (no tags) | **None** (all rights reserved) | NestJS, Prisma, Postgres, Next 15 | 4 weeks old, single author | 28 spec | **No** | 6–10 hardening if licensed |
| ksa_compliance | `24968b4` | 0.61.8 | AGPLv3 (hooks.py says "Copyright") | Frappe/ERPNext + Java zatca-cli (MIT) | Last commit 2026-06-01, 37 open | 8 | **No**, reference only | ZATCA 4–6 |
| zatca_erpgulf | `9d0099e` | v3.0.1 | MIT | Frappe/ERPNext, Python | 2026-09-08, 34 open | 4 | **Yes (MIT)**, but needs translation to TS | ZATCA 3–5 |
| zatca-sdk (aashahin) | `7ed2964` | 0.1.2 | MIT | Pure TS, Node ≥18 / Bun | 2026-09-08, new | 11 + live sandbox | **Yes** (evaluate/vendor; pin; audit) | ZATCA integration 1–2 |
| @jaicome/zatca-* | `bb42417` | 1.0.6 / 1.1.0 | MIT | TS; OpenSSL for CSR | 2026-03-05 | 33 | **Yes** (alternative) | 1.5–3 |
| zatca-xml-js (wes4m) / Repzo fork | `41a2c7d` / `1f9b633` | 0.1.9 / 0.1.5 | MIT | TS; OpenSSL | Stale (2022 / 2025) | 0 | Reference only | n/a |
| @khaledhajsalem/zatca-node | `b64d7f7` | 1.0.4 | MIT | TS; OpenSSL | 2026-04-20 | 1 | Yes, low confidence | 2–3 |
| medici | `54fa40b` | 7.3.0 | MIT | Mongoose/MongoDB, Number amounts | 2026-07-29 | 17 | Reference only | n/a |
| pgledger | `5e2c1fe` | no tag | MIT | Pure PostgreSQL PL/pgSQL | 2026-09-11 | Go tests | **Yes** (pattern/DDL) | ledger core 0.5–1 to adapt |

## Recommendation
1. Build the **ledger, invoicing, AR, AP and inventory valuation clean-room** from requirements in TypeScript/Prisma/Postgres. Use Postgres `NUMERIC` and a decimal library, not JS `number`. Treat ERPNext and Odoo as functional references only, and record that no code was copied.
2. For **ZATCA Phase 2**, evaluate `zatca-sdk` (MIT, pure JS, validated against SDK 238-R3.4.8) and `@jaicome/zatca-*` (MIT). Pin versions, vendor behind an adapter, and re-validate every artifact with the official Java SDK in CI. Use zatca_erpgulf (MIT) and Odoo `l10n_sa_edi` (LGPL, read-only) as cross-checks.
3. Avoid Bigcapital, ksa_compliance, @talha7k/zatca and zatca-kit (all AGPL), @dokhna-tech (BUSL), and HAS ERP (no license).
