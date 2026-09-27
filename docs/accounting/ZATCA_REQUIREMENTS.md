# Saudi localisation — requirements matrix (NOT IMPLEMENTED)

**Status: nothing in this branch issues, signs, reports or clears an e-invoice, and no VAT return or
zakat computation exists.** No compliance is claimed. The only related data is
`TaxCategory.zatcaTaxCategoryCode` (pre-existing). Review date: 2026-09-27.

Official sources could not be read from this environment (zatca.gov.sa is blocked by its network
policy); versions below come from the licence research and are **unverified** until checked on
https://zatca.gov.sa/en/E-Invoicing/Pages/default.aspx.

| Area | Requirement to verify and implement | Status | Needs |
|---|---|---|---|
| 1. E-invoicing | Seller/buyer data (VAT no., CR, national address), invoice types (standard/simplified), credit/debit notes with reason and reference, UUID, ICV counter, previous-invoice hash, UBL 2.1 XML per the XML Implementation Standard (v1.2 reported 2023-05-19, unverified), cryptographic stamp, TLV QR (Phase 1 fields + Phase 2 signature fields), clearance (B2B) within the published window / reporting (B2C) within 24 h, CSID onboarding (compliance → production), secure private-key storage, retention of XML and responses, retries/outage queue, warning vs rejection handling | M | Company VAT/CR/address; ZATCA portal access; decision on library (`zatca-sdk` MIT, validated against SDK 238-R3.4.8 per its docs — unverified) behind an adapter; official Java SDK validation in CI; **sandbox only** until approved |
| 2. VAT accounting & reporting | Output/input VAT accounts (in template: 2170, 1160), per-category rates incl. zero-rated and exempt with reasons, VAT return boxes by period, rounding rules per line/document | P (accounts only) | Sales invoicing and supplier bills first |
| 3. Zakat / income tax | Zakat base computation and filing | M | Professional accounting input; out of scope for software alone |

Rule kept from the brief: a generated QR code or one passing validation is not compliance.
